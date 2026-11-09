/* claude.js -- Claude Code session activity from local transcripts.
 *
 * 200+ MB of JSONL across dozens of files, so this never re-reads a file it
 * has already seen: each is tracked by byte offset and only the appended tail
 * is parsed. A partial trailing line is carried over to the next pass.
 *
 * Imports only GLib, so it runs under plain gjs for testing.
 */

import GLib from 'gi://GLib';

export const ACTIVE_WINDOW_MS = 15 * 60_000;

/** "-home-joel-dev-godot--claude-worktrees-step-name-x-94eeac" -> readable */
export function describeSlug(slug) {
    const m = /^-home-[^-]+-dev-(.+?)(?:--claude-worktrees-(.+))?$/.exec(slug);
    if (!m)
        return {project: slug, worktree: null};
    const project = m[1];
    if (!m[2])
        return {project, worktree: null};
    // worktrees carry a 6-hex suffix the tooling appends
    const wt = m[2].replace(/-[0-9a-f]{6}$/, '');
    return {project, worktree: wt};
}

/** Sum the token fields we care about out of one usage object. */
export function addUsage(acc, usage) {
    if (!usage)
        return acc;
    acc.input += (usage.input_tokens ?? 0);
    acc.cacheRead += (usage.cache_read_input_tokens ?? 0);
    acc.cacheWrite += (usage.cache_creation_input_tokens ?? 0);
    acc.output += (usage.output_tokens ?? 0);
    return acc;
}

/** YYYY-MM-DD in the machine's own timezone. */
export function localDay(ms) {
    if (!Number.isFinite(ms))
        return null;
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyUsage() {
    return {input: 0, cacheRead: 0, cacheWrite: 0, output: 0};
}

/**
 * Sum one accumulator into another.
 *
 * Distinct from addUsage, which reads the raw API shape (input_tokens,
 * cache_read_input_tokens, ...). Folded buckets use short names, so passing
 * one to addUsage silently adds nothing -- which is exactly the bug that
 * made the daily total read zero.
 */
export function addAcc(dst, src) {
    if (!src)
        return dst;
    dst.input += src.input ?? 0;
    dst.cacheRead += src.cacheRead ?? 0;
    dst.cacheWrite += src.cacheWrite ?? 0;
    dst.output += src.output ?? 0;
    return dst;
}

/** Total tokens billed-ish: everything that went in, plus what came out. */
export function totalTokens(u) {
    return u.input + u.cacheRead + u.cacheWrite + u.output;
}

/**
 * Parse newline-delimited JSON, tolerating a truncated final line.
 * Returns {records, leftover}.
 */
export function parseJsonl(text, carry = '') {
    const records = [];
    const buf = carry + text;
    const lines = buf.split('\n');
    const leftover = lines.pop() ?? '';
    for (const line of lines) {
        if (!line.trim())
            continue;
        try {
            records.push(JSON.parse(line));
        } catch {
            // a genuinely corrupt line; skip it rather than abort the file
        }
    }
    return {records, leftover};
}

/** Fold a batch of records into a session's running state. */
export function foldRecords(state, records) {
    for (const r of records) {
        if (r.timestamp) {
            const t = Date.parse(r.timestamp);
            if (Number.isFinite(t) && t > state.lastTs)
                state.lastTs = t;
        }
        if (r.gitBranch)
            state.branch = r.gitBranch;
        if (r.type === 'custom-title' && r.customTitle)
            state.title = r.customTitle;
        else if (r.type === 'ai-title' && r.aiTitle && !state.titleIsCustom)
            state.title = r.aiTitle;
        if (r.type === 'custom-title' && r.customTitle)
            state.titleIsCustom = true;

        const msg = r.message;
        if (msg && typeof msg === 'object' && msg.usage) {
            addUsage(state.usage, msg.usage);
            // Bucket by LOCAL day. Transcript timestamps are UTC, so slicing
            // the ISO string puts an evening's work on tomorrow's date and
            // "today" reads zero from late afternoon onward.
            const day = localDay(Date.parse(r.timestamp));
            if (day) {
                state.byDay[day] ??= emptyUsage();
                addUsage(state.byDay[day], msg.usage);
            }
        }
    }
    return state;
}

function newState(slug, path) {
    const {project, worktree} = describeSlug(slug);
    return {
        slug, path, project, worktree,
        title: null, titleIsCustom: false, branch: null,
        offset: 0, carry: '', lastTs: 0,
        usage: emptyUsage(), byDay: {},
    };
}

/** List <dir>/<slug>/<file>.jsonl paths. */
export function listTranscripts(root) {
    const out = [];
    const dir = GLib.Dir.open?.bind(GLib.Dir);
    try {
        const d = GLib.Dir.open(root, 0);
        let slug;
        while ((slug = d.read_name()) !== null) {
            const sub = GLib.build_filenamev([root, slug]);
            if (!GLib.file_test(sub, GLib.FileTest.IS_DIR))
                continue;
            try {
                const sd = GLib.Dir.open(sub, 0);
                let f;
                while ((f = sd.read_name()) !== null) {
                    if (f.endsWith('.jsonl'))
                        out.push({slug, path: GLib.build_filenamev([sub, f])});
                }
                sd.close();
            } catch { /* unreadable project dir */ }
        }
        d.close();
    } catch { /* no transcripts yet */ }
    void dir;
    return out;
}

/**
 * Incremental scan. `cache` is a Map(path -> state) owned by the caller and
 * reused between polls; only bytes appended since last time are parsed.
 */
export function scanSessions(root, cache, now = Date.now()) {
    const seen = new Set();

    for (const {slug, path} of listTranscripts(root)) {
        seen.add(path);
        let size = 0;
        try {
            const info = GLib.stat(path);
            size = info ? 0 : 0;
        } catch { /* fall through to read */ }

        let state = cache.get(path);
        if (!state) {
            state = newState(slug, path);
            cache.set(path, state);
        }

        let bytes;
        try {
            const [ok, data] = GLib.file_get_contents(path);
            if (!ok)
                continue;
            bytes = data;
        } catch {
            continue;
        }
        size = bytes.length;

        if (size === state.offset)
            continue;              // untouched since last pass
        if (size < state.offset) { // truncated or rotated: start over
            Object.assign(state, newState(slug, path));
        }

        const tail = bytes.slice(state.offset);
        const text = new TextDecoder().decode(tail);
        const {records, leftover} = parseJsonl(text, state.carry);
        state.carry = leftover;
        state.offset = size - new TextEncoder().encode(leftover).length;
        foldRecords(state, records);
    }

    for (const path of [...cache.keys()]) {
        if (!seen.has(path))
            cache.delete(path);
    }

    const sessions = [...cache.values()].sort((a, b) => b.lastTs - a.lastTs);
    const active = sessions.filter(s => now - s.lastTs <= ACTIVE_WINDOW_MS);
    const today = localDay(now);
    const todayUsage = emptyUsage();
    for (const s of sessions) {
        if (s.byDay[today])
            addAcc(todayUsage, s.byDay[today]);
    }

    return {sessions, active, todayUsage, today};
}

export function formatTokens(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
    return String(n);
}

export function sessionLabel(s) {
    const base = s.worktree ? `${s.project} · ${s.worktree}` : s.project;
    return s.title ? `${base} — ${s.title}` : base;
}
