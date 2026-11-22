/* usage.js -- Claude subscription usage from `claude -p "/usage"`.
 *
 * The slash command is handled locally by the CLI and makes no model call:
 * an invocation writes an 11-line transcript with zero usage records and
 * zero tokens, so polling it does not consume the very quota it reports.
 *
 * Pure parsing here; the caller runs the subprocess.
 */

export const USAGE_STATE = {
    OK:       'ok',
    WARN:     'warn',
    CRITICAL: 'critical',
    UNKNOWN:  'unknown',
};

export const WARN_PCT = 70;
export const CRIT_PCT = 90;

/** Command that produces the text parseRows() expects. */
export function usageCommand(binary) {
    return [binary, '-p', '/usage'];
}

/**
 * Pull the limit rows out of the CLI output. Shape:
 *   Current session: 18% used · resets Nov 22, 7:40pm (America/New_York)
 *   Current week (all models): 11% used · resets Nov 28, 6pm (...)
 *   Current week (Fable): 2% used · resets Nov 28, 6pm (...)
 */
export function parseUsage(text) {
    const rows = [];
    for (const line of (text ?? '').split('\n')) {
        const m = /^\s*(Current [^:]+):\s*(\d+)%\s*used(?:\s*·\s*resets\s+([^(]+?)\s*(?:\(([^)]+)\))?)?\s*$/
            .exec(line);
        if (!m)
            continue;
        rows.push({
            label: m[1].trim(),
            pct: parseInt(m[2], 10),
            resets: (m[3] ?? '').trim() || null,
            tz: m[4] ?? null,
        });
    }

    const find = re => rows.find(r => re.test(r.label)) ?? null;
    return {
        rows,
        session: find(/^Current session/i),
        week: find(/^Current week \(all models\)/i),
        model: find(/^Current week \((?!all models)/i),
        ok: rows.length > 0,
    };
}

/** Worst of the limits decides the indicator's state. */
export function classifyUsage(u) {
    if (!u || !u.ok) {
        return {
            state: USAGE_STATE.UNKNOWN,
            verdict: 'Could not read usage from the Claude CLI.',
            worst: null,
        };
    }
    const considered = [u.session, u.week].filter(Boolean);
    if (!considered.length)
        return {state: USAGE_STATE.UNKNOWN, verdict: 'No limits reported.', worst: null};

    const worst = considered.reduce((a, b) => (b.pct > a.pct ? b : a));
    const state = worst.pct >= CRIT_PCT ? USAGE_STATE.CRITICAL
        : worst.pct >= WARN_PCT ? USAGE_STATE.WARN
            : USAGE_STATE.OK;

    const noun = /session/i.test(worst.label) ? 'session' : 'weekly';
    const verdict = state === USAGE_STATE.OK
        ? `${u.session ? u.session.pct : '?'}% of this session, ` +
          `${u.week ? u.week.pct : '?'}% of the week.`
        : `${worst.pct}% of your ${noun} limit used` +
          (worst.resets ? ` — resets ${worst.resets}.` : '.');

    return {state, verdict, worst};
}

/**
 * Compact panel text: every limit's percentage, worst-first order preserved
 * as session / week / per-model so the positions stay stable to read at a
 * glance. "18·11·2%" rather than three separate "%" signs, which is too wide
 * for a crowded bar.
 */
export function panelText(u) {
    if (!u || !u.ok)
        return '--';
    const parts = [u.session, u.week, u.model]
        .filter(Boolean)
        .map(r => String(r.pct));
    return parts.length ? `${parts.join('\u00b7')}%` : '--';
}
