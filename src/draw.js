/* draw.js -- pure Cairo rendering for the history chart.
 * Imports nothing from GNOME Shell, so it renders to an ImageSurface in
 * tests exactly as it does to an St.DrawingArea in the panel.
 */

/**
 * Pure drawing routine -- takes any Cairo context, so it can be rendered to
 * an ImageSurface in tests as well as to an St.DrawingArea in the shell.
 */
export function drawSeries(cr, w, h, opts) {
    const {points, stepMs, rangeMs, domain, accent, faultMask, now} = opts;
    if (!w || !h)
        return;

    const [lo, hi] = domain;
    const span = hi - lo || 1;
    const from = now - rangeMs;
    const X = t => ((t - from) / rangeMs) * w;
    const Y = v => h - ((v - lo) / span) * h;

    cr.setLineWidth(1);
    cr.setSourceRGBA(1, 1, 1, 0.07);
    for (let i = 1; i < 4; i++) {
        const y = Math.round((h / 4) * i) + 0.5;
        cr.moveTo(0, y); cr.lineTo(w, y);
    }
    cr.stroke();

    if (!points.length)
        return;

    const bw = Math.max(1.5, (stepMs / rangeMs) * w);
    cr.setSourceRGBA(0.92, 0.25, 0.20, 0.30);
    for (const p of points) {
        if (p.flags & faultMask)
            cr.rectangle(X(p.t), 0, bw, h);
    }
    cr.fill();

    const [r, g, b] = accent;

    const runs = [];
    let cur = [], prevT = null;
    for (const p of points) {
        const broken = p.empty || (prevT !== null && p.t - prevT > stepMs * 2.5);
        if (broken) {
            if (cur.length) runs.push(cur);
            cur = [];
            if (p.empty) { prevT = p.t; continue; }
        }
        cur.push(p);
        prevT = p.t;
    }
    if (cur.length) runs.push(cur);

    for (const run of runs) {
        if (run.some(p => p.max - p.min > 1e-9)) {
            cr.setSourceRGBA(r, g, b, 0.18);
            cr.moveTo(X(run[0].t), Y(run[0].max));
            for (const p of run) cr.lineTo(X(p.t), Y(p.max));
            for (let i = run.length - 1; i >= 0; i--)
                cr.lineTo(X(run[i].t), Y(run[i].min));
            cr.closePath();
            cr.fill();
        }

        cr.setSourceRGBA(r, g, b, 0.22);
        cr.moveTo(X(run[0].t), h);
        for (const p of run) cr.lineTo(X(p.t), Y(p.avg));
        cr.lineTo(X(run[run.length - 1].t), h);
        cr.closePath();
        cr.fill();

        cr.setSourceRGBA(r, g, b, 0.95);
        cr.setLineWidth(1.6);
        cr.moveTo(X(run[0].t), Y(run[0].avg));
        for (const p of run) cr.lineTo(X(p.t), Y(p.avg));
        cr.stroke();
    }

    const last = points.filter(p => !p.empty).pop();
    if (last) {
        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(Math.min(X(last.t), w - 2.5), Y(last.avg), 2.5, 0, 2 * Math.PI);
        cr.fill();
    }
}

/**
 * Y-axis domain. With robust:true the top is pinned near the 90th percentile
 * instead of the maximum, so one latency spike cannot flatten the baseline
 * into an unreadable sliver -- the spike still draws, clipped at the ceiling.
 */
export function computeDomain(points, {robust = false, floorZero = false} = {}) {
    const mins = [], maxs = [];
    for (const p of points) {
        if (!p.empty) { mins.push(p.min); maxs.push(p.max); }
    }
    if (!mins.length)
        return [0, 1];

    let lo = Math.min(...mins);
    let hi = Math.max(...maxs);

    if (robust && maxs.length > 4) {
        const sorted = [...maxs].sort((a, b) => a - b);
        const p90 = sorted[Math.floor(sorted.length * 0.9)];
        hi = Math.min(hi, Math.max(p90 * 2.2, lo + 1));
    }

    if (floorZero)
        lo = 0;
    if (hi - lo < 1e-9)
        hi = lo + 1;
    const pad = (hi - lo) * 0.12;
    return [floorZero ? 0 : Math.max(0, lo - pad), hi + pad];
}
