/* sensors.js
 *
 * Pure sysfs reading + state classification for CPU Throttle Watch.
 *
 * Deliberately imports nothing from resource:///org/gnome/shell/** so that it
 * can be exercised directly with plain `gjs` outside the shell. See selftest.js.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/* Test hook: point the whole thing at a fake sysfs tree so the fault-state
 * rendering path can be exercised on healthy hardware. Unset in normal use. */
const ROOT = GLib.getenv('CPUTHROTTLE_SYSFS_ROOT') ?? '';

const CPU_BASE = `${ROOT}/sys/devices/system/cpu`;
const DRM_BASE = `${ROOT}/sys/class/drm`;
const HWMON_BASE = `${ROOT}/sys/class/hwmon`;

// The GT telemetry exposes more reasons than the brief listed; read them all,
// but keep a fixed display order with PROCHOT first since it is the one that
// matters here.
export const THROTTLE_REASONS = [
    'prochot',
    'thermal',
    'pl1',
    'pl2',
    'pl4',
    'ratl',
    'vr_tdc',
    'vr_thermalert',
];

// Classification thresholds (degrees C).
export const HOT_C = 90;   // at or above this, PROCHOT is believable protection
export const COOL_C = 70;  // below this, PROCHOT is almost certainly latched junk

export const STATE = {
    NORMAL: 'normal',
    POWER: 'power',    // power/current limit - informational
    THERMAL: 'thermal',  // hot and throttling - correct behaviour
    SUSPECT: 'suspect',  // PROCHOT asserted in the ambiguous 70-90 band
    FAULT: 'fault',    // PROCHOT asserted while cool - the bug
    UNKNOWN: 'unknown',  // could not read the sensors at all
};

const _decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return _decoder.decode(bytes).trim();
    } catch (_e) {
        return null;
    }
}

function readInt(path) {
    const txt = readText(path);
    if (txt === null)
        return null;
    const n = Number.parseInt(txt, 10);
    return Number.isFinite(n) ? n : null;
}

function listDir(path) {
    const out = [];
    try {
        const dir = Gio.File.new_for_path(path);
        const iter = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = iter.next_file(null)) !== null)
            out.push(info.get_name());
        iter.close(null);
    } catch (_e) {
        // Unreadable or missing - callers treat an empty list as "not found".
    }
    return out;
}

/* Expand a "0-15,20" style cpu list into an array of indices. */
function parseCpuList(spec) {
    const ids = [];
    if (!spec)
        return ids;
    for (const part of spec.split(',')) {
        const [a, b] = part.split('-');
        const lo = Number.parseInt(a, 10);
        const hi = b === undefined ? lo : Number.parseInt(b, 10);
        if (!Number.isFinite(lo) || !Number.isFinite(hi))
            continue;
        for (let i = lo; i <= hi; i++)
            ids.push(i);
    }
    return ids;
}

/**
 * Resolves the sysfs paths once, so the 2 s poll does no directory scanning.
 * Re-run it if a read starts failing (e.g. the drm card index moved across a
 * reboot, or a CPU was hotplugged).
 */
export class SensorPaths {
    constructor() {
        this.resolve();
    }

    resolve() {
        // ---- cpufreq ----
        let ids = parseCpuList(readText(`${CPU_BASE}/present`));
        if (ids.length === 0) {
            ids = listDir(CPU_BASE)
                .filter(n => /^cpu[0-9]+$/.test(n))
                .map(n => Number.parseInt(n.slice(3), 10));
        }
        this.curFreqPaths = ids
            .map(i => `${CPU_BASE}/cpu${i}/cpufreq/scaling_cur_freq`)
            .filter(p => GLib.file_test(p, GLib.FileTest.EXISTS));

        this.maxFreqPath = null;
        this.minFreqPath = null;
        for (const i of ids) {
            const mx = `${CPU_BASE}/cpu${i}/cpufreq/cpuinfo_max_freq`;
            if (GLib.file_test(mx, GLib.FileTest.EXISTS)) {
                this.maxFreqPath = mx;
                this.minFreqPath = `${CPU_BASE}/cpu${i}/cpufreq/cpuinfo_min_freq`;
                break;
            }
        }

        // ---- throttle reasons: glob the drm card, do not hardcode card1 ----
        this.throttleDir = null;
        for (const name of listDir(DRM_BASE).sort()) {
            if (!/^card[0-9]+$/.test(name))
                continue;
            const d = `${DRM_BASE}/${name}/gt/gt0`;
            if (GLib.file_test(`${d}/throttle_reason_prochot`, GLib.FileTest.EXISTS)) {
                this.throttleDir = d;
                break;
            }
        }

        // ---- package temperature: find coretemp by name, not by index ----
        this.tempPath = null;
        this.tempLabel = null;
        const prefer = ['coretemp', 'k10temp', 'zenpower'];
        const mons = listDir(HWMON_BASE).filter(n => n.startsWith('hwmon'));

        const scan = wanted => {
            for (const m of mons) {
                const dir = `${HWMON_BASE}/${m}`;
                if (readText(`${dir}/name`) !== wanted)
                    continue;
                // Prefer the explicit package sensor.
                for (const f of listDir(dir)) {
                    const match = /^temp([0-9]+)_label$/.exec(f);
                    if (!match)
                        continue;
                    const label = readText(`${dir}/${f}`) ?? '';
                    if (/package|tctl|tdie/i.test(label)) {
                        this.tempPath = `${dir}/temp${match[1]}_input`;
                        this.tempLabel = label;
                        return true;
                    }
                }
                // No package sensor: fall back to the hottest core in this chip.
                const inputs = listDir(dir)
                    .filter(f => /^temp[0-9]+_input$/.test(f))
                    .map(f => `${dir}/${f}`);
                if (inputs.length > 0) {
                    this.tempInputs = inputs;
                    this.tempLabel = `${wanted} (hottest core)`;
                    return true;
                }
            }
            return false;
        };

        this.tempInputs = null;
        for (const p of prefer) {
            if (scan(p))
                break;
        }
        if (!this.tempPath && !this.tempInputs) {
            // Last resort: ACPI thermal zone. Reads low, so note it loudly in
            // the menu, because a bogus-low temp would fake a FAULT verdict.
            for (const m of mons) {
                const dir = `${HWMON_BASE}/${m}`;
                if (readText(`${dir}/name`) === 'acpitz' &&
                    GLib.file_test(`${dir}/temp1_input`, GLib.FileTest.EXISTS)) {
                    this.tempPath = `${dir}/temp1_input`;
                    this.tempLabel = 'acpitz (approximate)';
                    break;
                }
            }
        }
    }

    get ok() {
        return this.curFreqPaths.length > 0 && this.maxFreqPath !== null;
    }
}

/**
 * One poll. Returns a plain object; never throws.
 */
export function sample(paths) {
    let curKhz = null;
    for (const p of paths.curFreqPaths) {
        const v = readInt(p);
        if (v !== null && (curKhz === null || v > curKhz))
            curKhz = v;
    }

    const maxKhz = paths.maxFreqPath ? readInt(paths.maxFreqPath) : null;
    const minKhz = paths.minFreqPath ? readInt(paths.minFreqPath) : null;

    const reasons = {};
    let statusBit = null;
    if (paths.throttleDir) {
        for (const r of THROTTLE_REASONS) {
            const v = readInt(`${paths.throttleDir}/throttle_reason_${r}`);
            if (v !== null)
                reasons[r] = v === 1;
        }
        const st = readInt(`${paths.throttleDir}/throttle_reason_status`);
        if (st !== null)
            statusBit = st === 1;
    }

    let tempC = null;
    if (paths.tempPath) {
        const m = readInt(paths.tempPath);
        if (m !== null)
            tempC = m / 1000;
    } else if (paths.tempInputs) {
        for (const p of paths.tempInputs) {
            const m = readInt(p);
            if (m !== null && (tempC === null || m / 1000 > tempC))
                tempC = m / 1000;
        }
    }

    return {
        curKhz,
        maxKhz,
        minKhz,
        tempC,
        reasons,
        statusBit,
        tempLabel: paths.tempLabel,
        haveThrottleData: paths.throttleDir !== null,
    };
}

/**
 * Turn a sample into a state plus a plain-language verdict.
 *
 * The important call is distinguishing "hot and protecting itself" (fine) from
 * "PROCHOT latched asserted by the EC while the chip is cold" (the bug that
 * cost days of 400 MHz).
 */
export function classify(s) {
    if (s.curKhz === null || s.maxKhz === null) {
        return {
            state: STATE.UNKNOWN,
            verdict: 'Cannot read CPU frequency from sysfs.',
        };
    }

    const prochot = s.reasons.prochot === true;
    const thermal = s.reasons.thermal === true;
    const powerKeys = ['pl1', 'pl2', 'pl4', 'ratl', 'vr_tdc', 'vr_thermalert'];
    const power = powerKeys.some(k => s.reasons[k] === true);

    // Pinned to the hardware floor is the signature of the latched fault: on
    // this machine that is 400 MHz against a 5400 MHz ceiling.
    const floor = s.minKhz ?? 0;
    const pinnedAtFloor = floor > 0 && s.curKhz <= floor * 1.10;
    const hasTemp = s.tempC !== null;

    if (!s.haveThrottleData) {
        if (pinnedAtFloor) {
            return {
                state: STATE.SUSPECT,
                verdict: `Clock pinned at the ${(floor / 1e6).toFixed(1)} GHz floor, ` +
                    'and throttle-reason data is unavailable. Investigate.',
            };
        }
        return {
            state: STATE.UNKNOWN,
            verdict: 'Throttle-reason files not found; showing clock only.',
        };
    }

    if (prochot) {
        if (hasTemp && s.tempC >= HOT_C) {
            return {
                state: STATE.THERMAL,
                verdict: `Thermal protection active at ${s.tempC.toFixed(0)} °C — ` +
                    'normal under heavy load.',
            };
        }
        if (pinnedAtFloor && (!hasTemp || s.tempC < HOT_C)) {
            return {
                state: STATE.FAULT,
                verdict: 'LATCHED FAULT — PROCHOT asserted and the clock is pinned at ' +
                    `its ${(floor / 1e6).toFixed(1)} GHz floor` +
                    (hasTemp ? ` at only ${s.tempC.toFixed(0)} °C` : '') +
                    '. Needs EC reset.',
            };
        }
        if (hasTemp && s.tempC < COOL_C) {
            return {
                state: STATE.FAULT,
                verdict: `LATCHED FAULT — PROCHOT asserted at only ${s.tempC.toFixed(0)} ` +
                    '°C. Needs EC reset.',
            };
        }
        return {
            state: STATE.SUSPECT,
            verdict: 'PROCHOT asserted' +
                (hasTemp ? ` at ${s.tempC.toFixed(0)} °C` : '') +
                ' — borderline. If it stays on as the chip cools, it is latched.',
        };
    }

    if (thermal) {
        return {
            state: STATE.THERMAL,
            verdict: 'Thermal throttling' +
                (hasTemp ? ` at ${s.tempC.toFixed(0)} °C` : '') +
                ' — normal under heavy load.',
        };
    }

    if (power) {
        return {
            state: STATE.POWER,
            verdict: 'Power/current limit reached — normal under heavy load.',
        };
    }

    // Nothing asserted. One more guard: if the clock is nailed to the floor
    // with no reason given, that is still worth noticing.
    if (pinnedAtFloor) {
        return {
            state: STATE.SUSPECT,
            verdict: `Clock pinned at the ${(floor / 1e6).toFixed(1)} GHz floor with no ` +
                'throttle reason set. Check the cpufreq governor and platform profile.',
        };
    }

    return {state: STATE.NORMAL, verdict: 'Running normally.'};
}

export function formatGhz(khz) {
    if (khz === null || khz === undefined)
        return '--';
    // Below 1 GHz, MHz reads far more clearly -- and "400 MHz" is exactly the
    // number that should make the hair on your neck stand up.
    if (khz < 1e6)
        return `${Math.round(khz / 1e3)} MHz`;
    return `${(khz / 1e6).toFixed(1)} GHz`;
}
