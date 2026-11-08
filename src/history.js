/* history.js -- multi-resolution time series with on-disk persistence.
 *
 * Keeping 7 days at a 2 s sample rate would be 300k points, so samples roll
 * up through three tiers the way RRD does. Each bucket keeps min/avg/max plus
 * an OR of the sample flags, so a brief throttle inside a 15-minute bucket is
 * still visible on the week view instead of being averaged away.
 *
 * Imports only GLib, so it runs under plain gjs for testing.
 */

import GLib from 'gi://GLib';

export const TIERS = [
    {name: 'fine',   stepMs: 2_000,   cap: 900},   // 30 min @ 2 s
    {name: 'minute', stepMs: 60_000,  cap: 1440},  // 24 h  @ 1 min
    {name: 'coarse', stepMs: 900_000, cap: 672},   // 7 d   @ 15 min
];

export const RANGES = [
    {label: '5m',  ms: 5 * 60_000},
    {label: '30m', ms: 30 * 60_000},
    {label: '1h',  ms: 60 * 60_000},
    {label: '12h', ms: 12 * 3_600_000},
    {label: '1d',  ms: 24 * 3_600_000},
    {label: '7d',  ms: 7 * 86_400_000},
];

/* Bucket layout, stored as a plain array to keep the JSON small:
 *   [tStart, min, max, sum, count, flags] */
const T = 0, MIN = 1, MAX = 2, SUM = 3, N = 4, FLAGS = 5;

export class Series {
    constructor() {
        this._tiers = TIERS.map(() => []);
        this.dirty = false;
    }

    /** value may be null (a gap, e.g. unreachable); flags is a small bitmask. */
    push(tMs, value, flags = 0) {
        if (value === null || value === undefined || Number.isNaN(value)) {
            // Record the gap only as a flag-bearing empty bucket so the graph
            // can break the line rather than inventing a straight segment.
            this._pushRaw(tMs, null, flags);
            return;
        }
        this._pushRaw(tMs, Number(value), flags);
    }

    _pushRaw(tMs, value, flags) {
        for (let i = 0; i < TIERS.length; i++) {
            const {stepMs, cap} = TIERS[i];
            const arr = this._tiers[i];
            const start = Math.floor(tMs / stepMs) * stepMs;
            const last = arr.length ? arr[arr.length - 1] : null;

            if (last && last[T] === start) {
                if (value !== null) {
                    if (last[N] === 0) {
                        last[MIN] = value;
                        last[MAX] = value;
                    } else {
                        if (value < last[MIN]) last[MIN] = value;
                        if (value > last[MAX]) last[MAX] = value;
                    }
                    last[SUM] += value;
                    last[N] += 1;
                }
                last[FLAGS] |= flags;
            } else {
                arr.push(value === null
                    ? [start, 0, 0, 0, 0, flags]
                    : [start, value, value, value, 1, flags]);
                if (arr.length > cap)
                    arr.splice(0, arr.length - cap);
            }
        }
        this.dirty = true;
    }

    /** Finest tier that covers the requested span. */
    tierFor(rangeMs) {
        for (let i = 0; i < TIERS.length; i++) {
            if (TIERS[i].stepMs * TIERS[i].cap >= rangeMs)
                return i;
        }
        return TIERS.length - 1;
    }

    /**
     * Points for the given span, oldest first:
     *   {t, min, max, avg, flags, empty}
     */
    query(rangeMs, nowMs = Date.now()) {
        const i = this.tierFor(rangeMs);
        const from = nowMs - rangeMs;
        const out = [];
        for (const b of this._tiers[i]) {
            if (b[T] < from)
                continue;
            out.push({
                t: b[T],
                min: b[N] ? b[MIN] : null,
                max: b[N] ? b[MAX] : null,
                avg: b[N] ? b[SUM] / b[N] : null,
                flags: b[FLAGS],
                empty: b[N] === 0,
            });
        }
        return {points: out, stepMs: TIERS[i].stepMs, tier: TIERS[i].name};
    }

    /** Most recent non-empty value, or null. */
    latest() {
        const arr = this._tiers[0];
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i][N])
                return arr[i][SUM] / arr[i][N];
        }
        return null;
    }

    toJSON() { return {v: 1, tiers: this._tiers}; }

    static fromJSON(o) {
        const s = new Series();
        if (o && o.v === 1 && Array.isArray(o.tiers)) {
            for (let i = 0; i < TIERS.length && i < o.tiers.length; i++) {
                if (Array.isArray(o.tiers[i]))
                    s._tiers[i] = o.tiers[i].filter(b => Array.isArray(b) && b.length === 6);
            }
        }
        return s;
    }
}

/* ------------------------------------------------------------------ *
 * disk persistence
 * ------------------------------------------------------------------ */

export function storePath(filename) {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'cpunetwatch']);
    GLib.mkdir_with_parents(dir, 0o755);
    return GLib.build_filenamev([dir, filename]);
}

export function loadSeries(filename) {
    try {
        const [ok, bytes] = GLib.file_get_contents(storePath(filename));
        if (!ok)
            return new Series();
        return Series.fromJSON(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return new Series();
    }
}

export function saveSeries(filename, series) {
    try {
        GLib.file_set_contents(storePath(filename),
            JSON.stringify(series.toJSON()));
        series.dirty = false;
        return true;
    } catch {
        return false;
    }
}
