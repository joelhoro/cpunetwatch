/* graph.js -- a small Cairo sparkline/area chart for St menus.
 *
 * Draws avg as a filled area, the min..max spread as a lighter band when the
 * tier is aggregated, and vertical red bands wherever a sample carried a
 * fault flag -- so a 20-second throttle a week ago is still visible as a
 * stripe even though its bucket is 15 minutes wide.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import {drawSeries, computeDomain} from './draw.js';

export const Graph = GObject.registerClass(
class Graph extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            style_class: 'cnw-graph',
            height: params.height ?? 86,
            x_expand: true,
            ...params,
        });
        this._points = [];
        this._stepMs = 2000;
        this._rangeMs = 300_000;
        this._domain = null;       // [lo, hi] or null for auto
        this._accent = [0.34, 0.89, 0.54];
        this._faultMask = 1;
        this._domainOpts = {};
        this.connect('repaint', () => this._draw());
    }

    setAccent(rgb) { this._accent = rgb; }
    setFaultMask(m) { this._faultMask = m; }

    setData({points, stepMs}, rangeMs, domain = null) {
        this._points = points ?? [];
        this._stepMs = stepMs ?? 2000;
        this._rangeMs = rangeMs;
        this._domain = domain;
        this.queue_repaint();
    }

    setDomainOpts(o) { this._domainOpts = o; }

    /** [lo, hi] actually used for the Y axis. */
    domain() {
        if (this._domain)
            return this._domain;
        return computeDomain(this._points, this._domainOpts ?? {});
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        drawSeries(cr, w, h, {
            points: this._points,
            stepMs: this._stepMs,
            rangeMs: this._rangeMs,
            domain: this.domain(),
            accent: this._accent,
            faultMask: this._faultMask,
            now: Date.now(),
        });
        cr.$dispose();
    }
});

