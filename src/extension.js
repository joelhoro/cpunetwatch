/* extension.js -- CPU Throttle Watch + Net Watch (GNOME Shell 45-48, ESM)
 *
 * Two panel indicators:
 *   - the real current CPU clock, distinguishing a latched PROCHOT fault
 *     from ordinary thermal protection;
 *   - connectivity, diagnosed by layer (router / upstream / DNS) rather
 *     than a bare up-down.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    SensorPaths, sample, classify, formatGhz, THROTTLE_REASONS, STATE,
} from './sensors.js';
import {
    NET_STATE, classifyNet, pingAsync, resolveAsync, defaultGateway,
    haveLink, formatMs,
} from './net.js';
import {Series, RANGES, loadSeries, saveSeries} from './history.js';
import {
    TIGER_STATE, remoteCommand, parseReport, classifyTiger, previewUrl,
} from './tiger.js';
import {Graph} from './graph.js';

const POLL_SECONDS = 2;
const NET_POLL_SECONDS = 10;
const METER_WIDTH = 272;
const CPU_PANEL_ICON = 'computer-chip-symbolic';
const NET_PANEL_ICON = 'globe-symbolic';
const SAVE_SECONDS = 60;
const FLAG_FAULT = 1;
const BD_STATE_FILE = '/run/cpunetwatch-bdprochot';
const TIGER_HOST = 'tiger';
const TIGER_POLL_SECONDS = 60;
const TIGER_PANEL_ICON = 'network-server-symbolic';
const DNS_PROBE_HOST = 'cloudflare.com';
const INTERNET_PROBE = '1.1.1.1';

/* ------------------------------------------------------------------ *
 * shared little widgets
 * ------------------------------------------------------------------ */

/** Small-caps section heading. */
function sectionLabel(text) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false, can_focus: false, activate: false,
    });
    item.add_child(new St.Label({
        text: text.toUpperCase(),
        style_class: 'cputhr-section',
        x_expand: true,
    }));
    return item;
}

/** "glyph  Label .......... [pill]" row. */
const DetailRow = GObject.registerClass(
class DetailRow extends PopupMenu.PopupBaseMenuItem {
    _init(keyText, glyph = '') {
        super._init({reactive: false, can_focus: false, activate: false});
        this._pillClass = null;

        this.add_child(new St.Label({
            text: glyph,
            style_class: 'cputhr-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(new St.Label({
            text: keyText,
            style_class: 'cputhr-row-key',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._value = new St.Label({
            text: '--',
            style_class: 'cputhr-row-value pill pill-dim',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pillClass = 'pill-dim';
        this.add_child(this._value);
    }

    /** tone: 'good' | 'warn' | 'bad' | 'dim' */
    setValue(text, tone = 'dim') {
        this._value.text = text;
        const cls = `pill-${tone}`;
        if (cls === this._pillClass)
            return;
        if (this._pillClass)
            this._value.remove_style_class_name(this._pillClass);
        this._pillClass = cls;
        this._value.add_style_class_name(cls);
    }
});

/**
 * Big number + unit, a caption, and a proportional bar underneath.
 * Used as the first thing in each dropdown so the answer reads instantly.
 */
const HeroReadout = GObject.registerClass(
class HeroReadout extends PopupMenu.PopupBaseMenuItem {
    _init(unitText) {
        super._init({reactive: false, can_focus: false, activate: false});

        const col = new St.BoxLayout({vertical: true, x_expand: true});

        const numberRow = new St.BoxLayout();
        this._badge = new St.Label({
            text: '',
            style_class: 'cputhr-hero-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        numberRow.add_child(this._badge);
        this._number = new St.Label({
            text: '--',
            style_class: 'cputhr-hero',
            y_align: Clutter.ActorAlign.END,
        });
        this._unit = new St.Label({
            text: unitText,
            style_class: 'cputhr-hero-unit',
            y_align: Clutter.ActorAlign.END,
        });
        numberRow.add_child(this._number);
        numberRow.add_child(this._unit);

        this._sub = new St.Label({text: '', style_class: 'cputhr-hero-sub'});

        this._track = new St.Widget({
            style_class: 'cputhr-meter-track',
            width: METER_WIDTH,
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.START,
        });
        this._fill = new St.Widget({
            style_class: 'cputhr-meter-fill',
            width: 1,
            x_align: Clutter.ActorAlign.START,
        });
        this._track.add_child(this._fill);

        this._caption = new St.Label({
            text: '', style_class: 'cputhr-meter-caption',
        });

        col.add_child(numberRow);
        col.add_child(this._sub);
        col.add_child(this._track);
        col.add_child(this._caption);
        this.add_child(col);

        this._numberClass = null;
        this._fillClass = null;
    }

    setNumber(text, cls = 'cputhr-hero-ok') {
        this._number.text = text;
        if (cls === this._numberClass)
            return;
        if (this._numberClass)
            this._number.remove_style_class_name(this._numberClass);
        this._numberClass = cls;
        this._number.add_style_class_name(cls);
    }

    setBadge(t) { this._badge.text = t; }
    setUnit(t) { this._unit.text = t; }
    setSub(t) { this._sub.text = t; }
    setCaption(t) { this._caption.text = t; }

    /** fraction 0..1 */
    setFill(frac, cls = null) {
        const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
        this._fill.width = Math.max(2, Math.round(f * METER_WIDTH));
        if (cls === this._fillClass)
            return;
        if (this._fillClass)
            this._fill.remove_style_class_name(this._fillClass);
        this._fillClass = cls;
        if (cls)
            this._fill.add_style_class_name(cls);
    }
});

/**
 * Range buttons + chart + min/max labels. Only repaints while the menu is
 * open, so a closed indicator costs nothing beyond the sample itself.
 */
const GraphSection = GObject.registerClass(
class GraphSection extends PopupMenu.PopupBaseMenuItem {
    _init(unit, accent, fmt, domainOpts = {}) {
        super._init({reactive: false, can_focus: false, activate: false});

        this._unit = unit;
        this._fmt = fmt ?? (v => v.toFixed(0));
        this._rangeMs = RANGES[0].ms;
        this._series = null;
        this._domain = null;

        const col = new St.BoxLayout({vertical: true, x_expand: true});

        // range selector
        const tabs = new St.BoxLayout({style_class: 'cnw-tabs'});
        this._buttons = [];
        for (const r of RANGES) {
            const btn = new St.Button({
                label: r.label,
                style_class: 'cnw-tab',
                can_focus: true,
            });
            btn.connect('clicked', () => {
                this._rangeMs = r.ms;
                this._syncTabs();
                this.refresh();
            });
            tabs.add_child(btn);
            this._buttons.push({btn, ms: r.ms});
        }
        col.add_child(tabs);

        // chart with y-axis labels either side
        this._yMax = new St.Label({text: '', style_class: 'cnw-axis'});
        this._yMin = new St.Label({text: '', style_class: 'cnw-axis'});
        this._graph = new Graph({height: 86});
        this._graph.setAccent(accent);
        this._graph.setFaultMask(FLAG_FAULT);
        this._graph.setDomainOpts(domainOpts);

        const axisCol = new St.BoxLayout({vertical: true, style_class: 'cnw-axis-col'});
        axisCol.add_child(this._yMax);
        axisCol.add_child(new St.Widget({y_expand: true}));
        axisCol.add_child(this._yMin);

        const chartRow = new St.BoxLayout({x_expand: true});
        chartRow.add_child(this._graph);
        chartRow.add_child(axisCol);
        col.add_child(chartRow);

        this._caption = new St.Label({text: '', style_class: 'cnw-graph-caption'});
        col.add_child(this._caption);

        this.add_child(col);
        this._syncTabs();
    }

    _syncTabs() {
        for (const {btn, ms} of this._buttons) {
            if (ms === this._rangeMs)
                btn.add_style_class_name('cnw-tab-active');
            else
                btn.remove_style_class_name('cnw-tab-active');
        }
    }

    attach(series, domain = null) {
        this._series = series;
        this._domain = domain;
    }

    refresh() {
        if (!this._series)
            return;
        const q = this._series.query(this._rangeMs);
        this._graph.setData(q, this._rangeMs, this._domain);

        const [lo, hi] = this._graph.domain();
        this._yMax.text = this._fmt(hi);
        this._yMin.text = this._fmt(lo);

        const vals = q.points.filter(x => !x.empty);
        if (!vals.length) {
            this._caption.text = 'no data yet for this range';
            return;
        }
        const avg = vals.reduce((a, x) => a + x.avg, 0) / vals.length;
        const mn = Math.min(...vals.map(x => x.min));
        const mx = Math.max(...vals.map(x => x.max));
        const faults = q.points.filter(x => x.flags & FLAG_FAULT).length;
        const span = Math.round((q.points[q.points.length - 1].t - q.points[0].t) / 60000);
        this._caption.text =
            `avg ${this._fmt(avg)} · min ${this._fmt(mn)} · max ${this._fmt(mx)} ` +
            `· ${span < 60 ? span + 'm' : (span / 60).toFixed(1) + 'h'} of data` +
            (faults ? `  ⚠ ${faults} throttled` : '');
    }
});

/**
 * Row with a label and a button. The button escalates via pkexec, which
 * gnome-shell's own polkit agent prompts for -- the shell itself never
 * touches the MSR.
 */
const ActionRow = GObject.registerClass(
class ActionRow extends PopupMenu.PopupBaseMenuItem {
    _init(glyph, keyText) {
        super._init({reactive: false, can_focus: false, activate: false});
        this.add_child(new St.Label({
            text: glyph, style_class: 'cputhr-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._key = new St.Label({
            text: keyText, style_class: 'cputhr-row-key',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._key);
        this._button = new St.Button({
            label: '--', style_class: 'cnw-action', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._button);
        this._btnCls = new ClassSwapper(this._button);
    }

    setKey(t) { this._key.text = t; }

    setButton(label, cls, sensitive = true) {
        this._button.label = label;
        this._button.reactive = sensitive;
        this._button.can_focus = sensitive;
        this._btnCls.set(cls);
    }

    onClick(fn) { this._button.connect('clicked', fn); }
});

/** Shared panel box: identity icon + label. The icon carries state by colour. */
function buildPanelBox(labelClass, iconClass, iconName) {
    const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
    const icon = new St.Icon({
        style_class: `system-status-icon ${iconClass}`,
        icon_name: iconName,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const label = new St.Label({
        text: '--',
        style_class: labelClass,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(icon);
    box.add_child(label);
    return {box, icon, label};
}

/** Swap a single style class on an actor, tracking the previous one. */
class ClassSwapper {
    constructor(actor) {
        this._actor = actor;
        this._cur = null;
    }

    set(cls) {
        if (cls === this._cur)
            return;
        if (this._cur)
            this._actor.remove_style_class_name(this._cur);
        this._cur = cls;
        if (cls)
            this._actor.add_style_class_name(cls);
    }
}

/* ------------------------------------------------------------------ *
 * CPU indicator
 * ------------------------------------------------------------------ */

const STATE_STYLE = {
    [STATE.NORMAL]:  {cls: 'cputhr-normal',  iconCls: 'ico-plain'},
    [STATE.POWER]:   {cls: 'cputhr-info',    iconCls: 'ico-info'},
    [STATE.THERMAL]: {cls: 'cputhr-info',    iconCls: 'ico-info'},
    [STATE.SUSPECT]: {cls: 'cputhr-warn',    iconCls: 'ico-warn'},
    [STATE.FAULT]:   {cls: 'cputhr-fault',   iconCls: 'ico-bad'},
    [STATE.UNKNOWN]: {cls: 'cputhr-unknown', iconCls: 'ico-dim'},
};

const STATE_EMOJI = {
    [STATE.NORMAL]:  '🚀',
    [STATE.POWER]:   '🔌',
    [STATE.THERMAL]: '🔥',
    [STATE.SUSPECT]: '❔',
    [STATE.FAULT]:   '🚨',
    [STATE.UNKNOWN]: '🔎',
};

const REASON_EMOJI = {
    prochot: '🚨',
    thermal: '🔥',
    pl1: '🔋', pl2: '🔋', pl4: '🔋',
    ratl: '🛑',
    vr_tdc: '🚀',
    vr_thermalert: '🧯',
};

const REASON_TITLES = {
    prochot: 'PROCHOT (external)',
    thermal: 'Thermal',
    pl1: 'Power limit PL1',
    pl2: 'Power limit PL2',
    pl4: 'Power limit PL4',
    ratl: 'Ratio limit (RATL)',
    vr_tdc: 'VR current (TDC)',
    vr_thermalert: 'VR thermal alert',
};

const ThrottleIndicator = GObject.registerClass(
class ThrottleIndicator extends PanelMenu.Button {
    _init(extPath) {
        super._init(0.5, 'CPU Throttle Watch', false);

        this._extPath = extPath;

        this._paths = new SensorPaths();
        this._series = loadSeries('cpu.json');
        this._blink = false;
        this._failStreak = 0;
        this._notifiedFault = false;

        const p = buildPanelBox('cputhr-panel-label', 'cputhr-icon',
            CPU_PANEL_ICON);
        this._icon = p.icon;
        this._label = p.label;
        this._labelCls = new ClassSwapper(p.label);
        this._iconCls = new ClassSwapper(p.icon);
        this.add_child(p.box);

        // ---- dropdown ----
        this._verdict = new St.Label({
            text: 'Reading sensors…', style_class: 'cputhr-verdict',
        });
        this._verdict.clutter_text.line_wrap = true;
        this._verdict.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._verdict.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._verdictCls = new ClassSwapper(this._verdict);

        this._verdictGlyph = new St.Label({
            text: '', style_class: 'cputhr-verdict-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const vi = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false,
        });
        vi.add_child(this._verdictGlyph);
        vi.add_child(this._verdict);
        this.menu.addMenuItem(vi);

        this._hero = new HeroReadout('GHz');
        this.menu.addMenuItem(this._hero);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._graphSection = new GraphSection('GHz', [0.34, 0.89, 0.54],
            v => `${(v / 1e6).toFixed(1)}`, {floorZero: true});
        this._graphSection.attach(this._series, null);
        this.menu.addMenuItem(this._graphSection);
        this.menu.connect('open-state-changed', (m, open) => {
            if (open) {
                this._graphSection.refresh();
                this._refreshBd();
            }
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(sectionLabel('Limits'));

        this._allClear = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false,
        });
        this._allClear.add_child(new St.Label({
            text: '✅  No limits asserted',
            style_class: 'cputhr-allclear',
            x_expand: true,
        }));
        this.menu.addMenuItem(this._allClear);

        this._reasonRows = new Map();
        for (const r of THROTTLE_REASONS) {
            const row = new DetailRow(REASON_TITLES[r] ?? r, REASON_EMOJI[r] ?? '•');
            row.visible = false;
            this._reasonRows.set(r, row);
            this.menu.addMenuItem(row);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(sectionLabel('External throttle (BD PROCHOT)'));
        this._rowBd = new ActionRow('🛡', 'Respond to EC throttle');
        this._rowBd.onClick(() => this._toggleBd());
        this.menu.addMenuItem(this._rowBd);
        this._bdBusy = false;
        this._refreshBd();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(sectionLabel('Detail'));
        this._rowTemp = new DetailRow('Package temperature', '🔥');
        this._rowRange = new DetailRow('Clock range', '🔆');
        this._rowSource = new DetailRow('Sensor source', '🔬');
        this.menu.addMenuItem(this._rowTemp);
        this.menu.addMenuItem(this._rowRange);
        this.menu.addMenuItem(this._rowSource);

        this._update();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            });
        this._saveId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, SAVE_SECONDS, () => {
                if (this._series.dirty)
                    saveSeries('cpu.json', this._series);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _update() {
        let s = sample(this._paths);

        if (s.curKhz === null || !this._paths.throttleDir) {
            if (++this._failStreak >= 5) {
                this._failStreak = 0;
                this._paths.resolve();
                s = sample(this._paths);
            }
        } else {
            this._failStreak = 0;
        }

        const {state, verdict} = classify(s);
        const style = STATE_STYLE[state] ?? STATE_STYLE[STATE.UNKNOWN];

        this._series.push(Date.now(), s.curKhz,
            state === STATE.FAULT ? FLAG_FAULT : 0);
        if (this.menu.isOpen)
            this._graphSection.refresh();

        // ---- panel ----
        this._label.text = formatGhz(s.curKhz);

        let cls = style.cls;
        if (state === STATE.FAULT) {
            this._blink = !this._blink;
            if (this._blink)
                cls = 'cputhr-fault-alt';
        } else {
            this._blink = false;
        }
        this._labelCls.set(cls);
        this._iconCls.set(style.iconCls);

        // ---- dropdown ----
        this._verdict.text = verdict;
        this._verdictGlyph.text = STATE_EMOJI[state] ?? '';
        this._verdictCls.set(
            state === STATE.FAULT ? 'cputhr-verdict-fault'
                : state === STATE.SUSPECT ? 'cputhr-verdict-warn'
                    : state === STATE.THERMAL || state === STATE.POWER
                        ? 'cputhr-verdict-info'
                        : 'cputhr-verdict-ok');

        // hero: split "4.5 GHz" into number and unit
        const txt = formatGhz(s.curKhz);
        const m = /^([\d.]+)\s*(\S+)$/.exec(txt);
        const frac = s.curKhz !== null && s.maxKhz ? s.curKhz / s.maxKhz : 0;
        const pct = Math.round(frac * 100);

        const heroCls = state === STATE.FAULT ? 'cputhr-hero-bad'
            : state === STATE.SUSPECT ? 'cputhr-hero-warn'
                : 'cputhr-hero-ok';
        const fillCls = state === STATE.FAULT ? 'cputhr-meter-fill-bad'
            : frac < 0.35 ? 'cputhr-meter-fill-warn'
                : null;

        this._hero.setBadge(STATE_EMOJI[state] ?? '');
        if (m) {
            this._hero.setNumber(m[1], heroCls);
            this._hero.setUnit(m[2]);
        } else {
            this._hero.setNumber(txt, heroCls);
            this._hero.setUnit('');
        }
        this._hero.setSub(
            s.tempC === null ? 'fastest core' : `fastest core · ${s.tempC.toFixed(0)} °C`);
        this._hero.setFill(frac, fillCls);
        this._hero.setCaption(
            s.maxKhz ? `${pct}% of ${formatGhz(s.maxKhz)} rated` : '');

        // ---- limits: collapse to one line unless something is asserted ----
        let anyAsserted = false;
        for (const [r, row] of this._reasonRows) {
            const v = s.reasons[r];
            row.visible = v === true;
            if (v === true) {
                anyAsserted = true;
                row.setValue('ASSERTED', r === 'prochot' ? 'bad' : 'warn');
            }
        }
        this._allClear.visible = !anyAsserted && s.haveThrottleData;

        this._rowTemp.setValue(
            s.tempC === null ? 'unavailable' : `${s.tempC.toFixed(0)} °C`,
            s.tempC === null ? 'dim'
                : s.tempC >= 95 ? 'bad'
                    : s.tempC >= 85 ? 'warn' : 'good');
        this._rowRange.setValue(
            s.minKhz ? `${formatGhz(s.minKhz)} – ${formatGhz(s.maxKhz)}`
                : formatGhz(s.maxKhz), 'dim');
        this._rowSource.setValue(
            s.haveThrottleData
                ? `${s.tempLabel ?? 'no temp'} · GT telemetry`
                : 'throttle data unavailable',
            s.haveThrottleData ? 'dim' : 'warn');

        // ---- one notification per entry into the fault state ----
        if (state === STATE.FAULT) {
            if (!this._notifiedFault) {
                this._notifiedFault = true;
                Main.notifyError(
                    'CPU latched in throttled state',
                    `${verdict} Clock is ${formatGhz(s.curKhz)} of ` +
                    `${formatGhz(s.maxKhz)}.`);
            }
        } else if (state === STATE.NORMAL) {
            this._notifiedFault = false;
        }
    }

    /** Reads the world-readable state file the helper publishes. */
    _bdState() {
        try {
            const [ok, bytes] = GLib.file_get_contents(BD_STATE_FILE);
            if (!ok)
                return null;
            const t = new TextDecoder().decode(bytes).trim();
            return t === 'enabled' || t === 'disabled' ? t : null;
        } catch {
            return null;
        }
    }

    _refreshBd() {
        if (this._bdBusy) {
            this._rowBd.setButton('working…', 'cnw-action-busy', false);
            return;
        }
        const st = this._bdState();
        if (st === 'disabled') {
            this._rowBd.setKey('EC throttle ignored');
            this._rowBd.setButton('Restore', 'cnw-action-warn');
        } else if (st === 'enabled') {
            this._rowBd.setKey('Respond to EC throttle');
            this._rowBd.setButton('Release', 'cnw-action');
        } else {
            this._rowBd.setKey('Respond to EC throttle');
            this._rowBd.setButton('Check', 'cnw-action');
        }
    }

    _toggleBd() {
        if (this._bdBusy)
            return;
        const st = this._bdState();
        const verb = st === 'disabled' ? 'on' : st === 'enabled' ? 'off' : 'status';
        const script = GLib.build_filenamev([this._extPath, 'prochot']);

        this._bdBusy = true;
        this._refreshBd();
        this.menu.close();

        let proc;
        try {
            proc = Gio.Subprocess.new(['pkexec', script, verb],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._bdBusy = false;
            this._refreshBd();
            Main.notifyError('Could not run the helper', String(e));
            return;
        }

        proc.communicate_utf8_async(null, null, (p, res) => {
            this._bdBusy = false;
            let out = '', err = '';
            try {
                [, out, err] = p.communicate_utf8_finish(res);
            } catch (e) {
                err = String(e);
            }
            const code = p.get_exit_status();
            // 126/127 are pkexec's "dismissed" and "not authorised".
            if (code !== 0 && code !== 126 && code !== 127)
                Main.notifyError('BD PROCHOT change failed', (err || out).trim());
            this._refreshBd();
        });
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = null;
        }
        saveSeries('cpu.json', this._series);
        super.destroy();
    }
});

/* ------------------------------------------------------------------ *
 * Network indicator
 * ------------------------------------------------------------------ */

const NET_EMOJI = {
    [NET_STATE.OK]:       '✅',
    [NET_STATE.SLOW]:     '🐌',
    [NET_STATE.LOSSY]:    '💧',
    [NET_STATE.DNS]:      '🔤',
    [NET_STATE.UPSTREAM]: '🌐',
    [NET_STATE.LOCAL]:    '📶',
    [NET_STATE.DOWN]:     '🔌',
    [NET_STATE.UNKNOWN]:  '🔄',
};

const NET_STYLE = {
    [NET_STATE.OK]:       {cls: 'netw-normal',  iconCls: 'ico-plain'},
    [NET_STATE.SLOW]:     {cls: 'netw-warn',    iconCls: 'ico-warn'},
    [NET_STATE.LOSSY]:    {cls: 'netw-warn',    iconCls: 'ico-warn'},
    [NET_STATE.DNS]:      {cls: 'netw-fault',   iconCls: 'ico-bad'},
    [NET_STATE.UPSTREAM]: {cls: 'netw-fault',   iconCls: 'ico-bad'},
    [NET_STATE.LOCAL]:    {cls: 'netw-fault',   iconCls: 'ico-bad'},
    [NET_STATE.DOWN]:     {cls: 'netw-unknown', iconCls: 'ico-dim'},
    [NET_STATE.UNKNOWN]:  {cls: 'netw-unknown', iconCls: 'ico-dim'},
};

const NetIndicator = GObject.registerClass(
class NetIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Net Watch', false);

        this._cancellable = new Gio.Cancellable();
        this._series = loadSeries('net.json');
        this._procs = new Set();
        this._blink = false;
        this._notified = false;
        this._busy = false;

        const p = buildPanelBox('netw-panel-label', 'netw-icon',
            NET_PANEL_ICON);
        this._icon = p.icon;
        this._label = p.label;
        this._labelCls = new ClassSwapper(p.label);
        this._iconCls = new ClassSwapper(p.icon);
        this.add_child(p.box);

        this._verdict = new St.Label({
            text: 'Checking connection…', style_class: 'cputhr-verdict',
        });
        this._verdict.clutter_text.line_wrap = true;
        this._verdict.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._verdict.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._verdictCls = new ClassSwapper(this._verdict);

        this._verdictGlyph = new St.Label({
            text: '', style_class: 'cputhr-verdict-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const vi = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false,
        });
        vi.add_child(this._verdictGlyph);
        vi.add_child(this._verdict);
        this.menu.addMenuItem(vi);

        this._hero = new HeroReadout('ms');
        this.menu.addMenuItem(this._hero);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._graphSection = new GraphSection('ms', [0.60, 0.76, 0.95],
            v => v < 10 ? v.toFixed(1) : v.toFixed(0), {robust: true});
        this._graphSection.attach(this._series, null);
        this.menu.addMenuItem(this._graphSection);
        this.menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._graphSection.refresh();
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(sectionLabel('Path'));
        this._rowLink = new DetailRow('Link', '🔗');
        this._rowGw = new DetailRow('Router', '📶');
        this._rowNet = new DetailRow('Internet', '🌐');
        this._rowDns = new DetailRow('DNS', '🔤');
        this.menu.addMenuItem(this._rowLink);
        this.menu.addMenuItem(this._rowGw);
        this.menu.addMenuItem(this._rowNet);
        this.menu.addMenuItem(this._rowDns);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(sectionLabel('Detail'));
        this._rowLoss = new DetailRow('Packet loss', '💧');
        this._rowTargets = new DetailRow('Probing', '🎯');
        this.menu.addMenuItem(this._rowLoss);
        this.menu.addMenuItem(this._rowTargets);

        this._probe();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, NET_POLL_SECONDS, () => {
                this._probe();
                return GLib.SOURCE_CONTINUE;
            });
        this._saveId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, SAVE_SECONDS, () => {
                if (this._series.dirty)
                    saveSeries('net.json', this._series);
                return GLib.SOURCE_CONTINUE;
            });
    }

    /* Fire all three probes; render once they have all reported. */
    _probe() {
        if (this._busy)
            return;
        this._busy = true;

        const gw = defaultGateway();
        const link = haveLink();
        const r = {link, gateway: null, internet: null, dns: null, gw};
        let outstanding = 3;

        const done = () => {
            if (--outstanding > 0)
                return;
            this._busy = false;
            if (!this._cancellable.is_cancelled())
                this._render(r);
        };

        if (gw) {
            const p = pingAsync(gw, {count: 2, cancellable: this._cancellable},
                res => { r.gateway = res; done(); });
            if (p)
                this._procs.add(p);
        } else {
            r.gateway = {ok: false, rttMs: null, loss: 100};
            done();
        }

        const p2 = pingAsync(INTERNET_PROBE,
            {count: 3, cancellable: this._cancellable},
            res => { r.internet = res; done(); });
        if (p2)
            this._procs.add(p2);

        resolveAsync(DNS_PROBE_HOST, this._cancellable,
            res => { r.dns = res; done(); });
    }

    _render(r) {
        const {state, verdict} = classifyNet(r);
        const style = NET_STYLE[state] ?? NET_STYLE[NET_STATE.UNKNOWN];

        const rtt = r.internet?.rttMs ?? null;
        const unhealthy = state !== NET_STATE.OK && state !== NET_STATE.SLOW;
        this._series.push(Date.now(), rtt, unhealthy ? FLAG_FAULT : 0);
        if (this.menu.isOpen)
            this._graphSection.refresh();

        this._label.text = state === NET_STATE.DOWN ? 'offline'
            : rtt !== null ? formatMs(rtt) : '--';

        let cls = style.cls;
        const bad = state === NET_STATE.LOCAL || state === NET_STATE.UPSTREAM ||
                    state === NET_STATE.DNS;
        if (bad) {
            this._blink = !this._blink;
            if (this._blink)
                cls = 'netw-fault-alt';
        } else {
            this._blink = false;
        }
        this._labelCls.set(cls);
        this._iconCls.set(style.iconCls);

        this._verdict.text = verdict;
        this._verdictGlyph.text = NET_EMOJI[state] ?? '';
        this._verdictCls.set(
            bad ? 'cputhr-verdict-fault'
                : state === NET_STATE.SLOW || state === NET_STATE.LOSSY
                    ? 'cputhr-verdict-warn'
                    : state === NET_STATE.DOWN ? 'cputhr-verdict-warn'
                        : 'cputhr-verdict-ok');

        // hero: latency, with the bar as a 0-200ms quality scale (inverted)
        this._hero.setBadge(NET_EMOJI[state] ?? '');
        if (rtt !== null) {
            this._hero.setNumber(rtt < 10 ? rtt.toFixed(1) : rtt.toFixed(0),
                bad ? 'cputhr-hero-bad'
                    : rtt > 150 ? 'cputhr-hero-warn' : 'cputhr-hero-ok');
            this._hero.setUnit('ms');
            this._hero.setSub(`round trip to ${INTERNET_PROBE}`);
            const quality = Math.max(0, 1 - rtt / 200);
            this._hero.setFill(quality,
                quality < 0.25 ? 'cputhr-meter-fill-bad'
                    : quality < 0.6 ? 'cputhr-meter-fill-warn' : null);
            this._hero.setCaption(
                rtt <= 30 ? 'excellent' : rtt <= 60 ? 'good'
                    : rtt <= 150 ? 'usable' : 'poor');
        } else {
            this._hero.setNumber('--', 'cputhr-hero-bad');
            this._hero.setUnit('');
            this._hero.setSub('no reply');
            this._hero.setFill(0, 'cputhr-meter-fill-bad');
            this._hero.setCaption('');
        }

        this._rowLink.setValue(
            r.link !== false ? 'up' : 'down',
            r.link !== false ? 'good' : 'bad');

        if (r.gateway?.ok)
            this._rowGw.setValue(formatMs(r.gateway.rttMs), 'good');
        else
            this._rowGw.setValue(r.gw ? 'unreachable' : 'none', 'bad');

        this._rowNet.setValue(
            r.internet?.ok ? formatMs(rtt) : 'unreachable',
            r.internet?.ok ? 'good' : 'bad');

        this._rowDns.setValue(
            r.dns?.ok ? formatMs(r.dns.ms) : 'not resolving',
            r.dns?.ok ? 'good' : 'bad');

        const loss = r.internet?.loss ?? null;
        this._rowLoss.setValue(
            loss === null ? '--' : `${loss.toFixed(0)}%`,
            loss ? (loss >= 50 ? 'bad' : 'warn') : 'good');
        this._rowTargets.setValue(r.gw ?? INTERNET_PROBE, 'dim');

        if (bad) {
            if (!this._notified) {
                this._notified = true;
                Main.notifyError('Network problem', verdict);
            }
        } else if (state === NET_STATE.OK) {
            this._notified = false;
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = null;
        }
        saveSeries('net.json', this._series);
        this._cancellable.cancel();
        for (const p of this._procs) {
            try { p.force_exit(); } catch { /* already gone */ }
        }
        this._procs.clear();
        super.destroy();
    }
});

/* ------------------------------------------------------------------ *
 * Tiger (remote host) indicator
 * ------------------------------------------------------------------ */

const TIGER_EMOJI = {
    [TIGER_STATE.OK]:          '✅',
    [TIGER_STATE.WARN]:        '🧹',
    [TIGER_STATE.CRITICAL]:    '🚨',
    [TIGER_STATE.UNREACHABLE]: '🔌',
    [TIGER_STATE.UNKNOWN]:     '🔎',
};

const TIGER_STYLE = {
    [TIGER_STATE.OK]:          {cls: 'netw-normal',  iconCls: 'ico-plain'},
    [TIGER_STATE.WARN]:        {cls: 'netw-warn',    iconCls: 'ico-warn'},
    [TIGER_STATE.CRITICAL]:    {cls: 'netw-fault',   iconCls: 'ico-bad'},
    [TIGER_STATE.UNREACHABLE]: {cls: 'netw-unknown', iconCls: 'ico-dim'},
    [TIGER_STATE.UNKNOWN]:     {cls: 'netw-unknown', iconCls: 'ico-dim'},
};

const TigerIndicator = GObject.registerClass(
class TigerIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Tiger Watch', false);

        this._cancellable = new Gio.Cancellable();
        this._proc = null;
        this._busy = false;
        this._blink = false;
        this._notified = false;
        this._series = loadSeries('tiger.json');

        const p = buildPanelBox('netw-panel-label', 'netw-icon', TIGER_PANEL_ICON);
        this._icon = p.icon;
        this._label = p.label;
        this._labelCls = new ClassSwapper(p.label);
        this._iconCls = new ClassSwapper(p.icon);
        this.add_child(p.box);

        this._verdictGlyph = new St.Label({
            text: '', style_class: 'cputhr-verdict-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._verdict = new St.Label({
            text: 'Contacting tiger…', style_class: 'cputhr-verdict',
        });
        this._verdict.clutter_text.line_wrap = true;
        this._verdict.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._verdict.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._verdictCls = new ClassSwapper(this._verdict);

        const vi = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        vi.add_child(this._verdictGlyph);
        vi.add_child(this._verdict);
        this.menu.addMenuItem(vi);

        this._hero = new HeroReadout('%');
        this.menu.addMenuItem(this._hero);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._graphSection = new GraphSection('%', [0.95, 0.70, 0.44],
            v => `${v.toFixed(0)}`, {floorZero: true});
        this._graphSection.attach(this._series, [0, 100]);
        this.menu.addMenuItem(this._graphSection);
        this.menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._graphSection.refresh();
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(sectionLabel('Host'));
        this._rowRunning = new DetailRow('Containers running', '🔗');
        this._rowBad = new DetailRow('Needing attention', '🚨');
        this._rowExited = new DetailRow('Stopped, not removed', '🔌');
        this._rowReclaim = new DetailRow('Reclaimable', '🧹');
        this.menu.addMenuItem(this._rowRunning);
        this.menu.addMenuItem(this._rowBad);
        this.menu.addMenuItem(this._rowExited);
        this.menu.addMenuItem(this._rowReclaim);

        this._previewLabel = sectionLabel('Branch previews');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._previewLabel);
        this._previewItems = [];

        this._poll();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, TIGER_POLL_SECONDS, () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
        this._saveId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, SAVE_SECONDS, () => {
                if (this._series.dirty)
                    saveSeries('tiger.json', this._series);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _poll() {
        if (this._busy)
            return;
        this._busy = true;
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
                    TIGER_HOST, remoteCommand()],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            this._busy = false;
            this._render(null, false);
            return;
        }
        this._proc = proc;
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            this._busy = false;
            this._proc = null;
            let out = '';
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch {
                if (!this._cancellable.is_cancelled())
                    this._render(null, false);
                return;
            }
            if (this._cancellable.is_cancelled())
                return;
            const okExit = p.get_exit_status() === 0;
            this._render(okExit ? parseReport(out) : null, okExit);
        });
    }

    _render(report, reachable) {
        const {state, verdict} = classifyTiger(report, reachable);
        const style = TIGER_STYLE[state] ?? TIGER_STYLE[TIGER_STATE.UNKNOWN];
        const pct = report?.disk?.pct ?? null;

        if (pct !== null)
            this._series.push(Date.now(), pct,
                state === TIGER_STATE.CRITICAL ? FLAG_FAULT : 0);

        this._label.text = pct !== null ? `${pct}%`
            : state === TIGER_STATE.UNREACHABLE ? 'offline' : '--';

        let cls = style.cls;
        const bad = state === TIGER_STATE.CRITICAL;
        if (bad) {
            this._blink = !this._blink;
            if (this._blink)
                cls = 'netw-fault-alt';
        } else {
            this._blink = false;
        }
        this._labelCls.set(cls);
        this._iconCls.set(style.iconCls);

        this._verdict.text = verdict;
        this._verdictGlyph.text = TIGER_EMOJI[state] ?? '';
        this._verdictCls.set(
            bad ? 'cputhr-verdict-fault'
                : state === TIGER_STATE.WARN ? 'cputhr-verdict-warn'
                    : state === TIGER_STATE.OK ? 'cputhr-verdict-ok'
                        : 'cputhr-verdict-warn');

        this._hero.setBadge(TIGER_EMOJI[state] ?? '');
        if (pct !== null) {
            this._hero.setNumber(String(pct),
                pct >= 90 ? 'cputhr-hero-bad'
                    : pct >= 80 ? 'cputhr-hero-warn' : 'cputhr-hero-ok');
            this._hero.setUnit('% disk');
            this._hero.setSub(
                `${report.disk.usedGb.toFixed(0)} of ${report.disk.totalGb.toFixed(0)} GB on ${TIGER_HOST}`);
            this._hero.setFill(pct / 100,
                pct >= 90 ? 'cputhr-meter-fill-bad'
                    : pct >= 80 ? 'cputhr-meter-fill-warn' : null);
            this._hero.setCaption(
                `${report.reclaimableGb.toFixed(0)} GB reclaimable by pruning`);
        } else {
            this._hero.setNumber('--', 'cputhr-hero-bad');
            this._hero.setUnit('');
            this._hero.setSub(`no answer from ${TIGER_HOST}`);
            this._hero.setFill(0, 'cputhr-meter-fill-bad');
            this._hero.setCaption('');
        }

        if (report) {
            const nbad = report.unhealthy.length + report.restarting.length;
            this._rowRunning.setValue(String(report.running), 'good');
            this._rowBad.setValue(String(nbad), nbad ? 'bad' : 'good');
            this._rowExited.setValue(
                report.exited === null ? '--' : String(report.exited),
                (report.exited ?? 0) >= 20 ? 'warn' : 'dim');
            this._rowReclaim.setValue(`${report.reclaimableGb.toFixed(0)} GB`,
                report.reclaimableGb >= 40 ? 'warn' : 'dim');
            this._syncPreviews(report.previews);
        } else {
            for (const r of [this._rowRunning, this._rowBad, this._rowExited,
                this._rowReclaim])
                r.setValue('--', 'dim');
            this._syncPreviews([]);
        }

        if (bad) {
            if (!this._notified) {
                this._notified = true;
                Main.notifyError(`${TIGER_HOST}: containers need attention`, verdict);
            }
        } else if (state === TIGER_STATE.OK) {
            this._notified = false;
        }
    }

    /** Rebuild the clickable preview list; URLs open in the browser. */
    _syncPreviews(previews) {
        for (const it of this._previewItems)
            it.destroy();
        this._previewItems = [];

        const seen = new Set();
        for (const c of previews) {
            const url = previewUrl(c.name);
            if (!url || seen.has(url))
                continue;
            seen.add(url);
            const item = new PopupMenu.PopupBaseMenuItem();
            item.add_child(new St.Label({
                text: '\u{1f310}', style_class: 'cputhr-glyph',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            item.add_child(new St.Label({
                text: url.replace(/^https:\/\//, ''),
                style_class: 'cputhr-row-key',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            item.connect('activate', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(url, null);
                } catch (e) {
                    Main.notifyError('Could not open', String(e));
                }
            });
            this.menu.addMenuItem(item);
            this._previewItems.push(item);
        }
        this._previewLabel.visible = this._previewItems.length > 0;
        if (!this._previewItems.length) {
            const none = new PopupMenu.PopupBaseMenuItem({
                reactive: false, can_focus: false,
            });
            none.add_child(new St.Label({
                text: 'none running', style_class: 'cputhr-footnote', x_expand: true,
            }));
            this.menu.addMenuItem(none);
            this._previewItems.push(none);
            this._previewLabel.visible = true;
        }
    }

    destroy() {
        for (const id of ['_timeoutId', '_saveId']) {
            if (this[id]) {
                GLib.Source.remove(this[id]);
                this[id] = null;
            }
        }
        saveSeries('tiger.json', this._series);
        this._cancellable.cancel();
        try { this._proc?.force_exit(); } catch { /* already gone */ }
        super.destroy();
    }
});

/* ------------------------------------------------------------------ */

export default class CpuThrottleWatchExtension extends Extension {
    enable() {
        this._cpu = new ThrottleIndicator(this.path);
        Main.panel.addToStatusArea(`${this.uuid}-cpu`, this._cpu, 0, 'right');
        this._net = new NetIndicator();
        Main.panel.addToStatusArea(`${this.uuid}-net`, this._net, 1, 'right');
        this._tiger = new TigerIndicator();
        Main.panel.addToStatusArea(`${this.uuid}-tiger`, this._tiger, 2, 'right');
    }

    disable() {
        this._cpu?.destroy();
        this._cpu = null;
        this._net?.destroy();
        this._net = null;
        this._tiger?.destroy();
        this._tiger = null;
    }
}
