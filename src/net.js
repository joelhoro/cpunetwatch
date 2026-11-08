/* net.js -- layered connectivity probe.
 *
 * Imports nothing from GNOME Shell so it can be exercised under plain gjs.
 *
 * The point is not "is the internet up" but "which layer is broken":
 * link -> router -> upstream -> DNS. Each probe is independent and async;
 * the classifier reads the combination.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const NET_STATE = {
    OK:        'ok',          // everything answers, latency sane
    SLOW:      'slow',        // reachable but latency is bad
    LOSSY:     'lossy',       // reachable but dropping packets
    DNS:       'dns',         // packets fine, names don't resolve
    UPSTREAM:  'upstream',    // router answers, internet doesn't
    LOCAL:     'local',       // router itself unreachable
    DOWN:      'down',        // no link at all
    UNKNOWN:   'unknown',
};

/* Latency thresholds in ms, applied to the internet probe. */
const SLOW_MS = 150;
const OK_MS = 60;

/** Default gateway address, or null. Cheap: reads one proc file. */
export function defaultGateway() {
    try {
        const [ok, bytes] = GLib.file_get_contents('/proc/net/route');
        if (!ok)
            return null;
        const text = new TextDecoder().decode(bytes);
        for (const line of text.split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length < 3 || f[1] !== '00000000')
                continue;
            // little-endian hex
            const h = f[2];
            const o = [6, 4, 2, 0].map(i => parseInt(h.substr(i, 2), 16));
            return o.join('.');
        }
    } catch {
        // fall through
    }
    return null;
}

/** Is any non-loopback interface actually up with a carrier? */
export function haveLink() {
    try {
        const dir = Gio.File.new_for_path('/sys/class/net');
        const e = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = e.next_file(null)) !== null) {
            const name = info.get_name();
            if (name === 'lo')
                continue;
            try {
                const [ok, b] = GLib.file_get_contents(
                    `/sys/class/net/${name}/operstate`);
                if (ok && new TextDecoder().decode(b).trim() === 'up')
                    return true;
            } catch {
                // keep looking
            }
        }
    } catch {
        return true; // can't tell; don't claim it's down
    }
    return false;
}

/**
 * Ping once. cb({ok, rttMs, loss}). Never throws, never blocks.
 * Returns the Gio.Subprocess so the caller can force_exit() on teardown.
 */
export function pingAsync(host, {count = 3, waitSec = 2, cancellable = null} = {}, cb) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            ['ping', '-n', '-q', '-c', String(count), '-i', '0.3',
                '-W', String(waitSec), host],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        cb({ok: false, rttMs: null, loss: 100, error: String(e)});
        return null;
    }

    proc.communicate_utf8_async(null, cancellable, (p, res) => {
        let out = '';
        try {
            [, out] = p.communicate_utf8_finish(res);
        } catch (e) {
            cb({ok: false, rttMs: null, loss: 100, error: String(e)});
            return;
        }
        cb(parsePing(out ?? ''));
    });
    return proc;
}

/** Pull loss% and avg RTT out of ping's summary. Exported for testing. */
export function parsePing(out) {
    const loss = /([\d.]+)% packet loss/.exec(out);
    const rtt = /= *[\d.]+\/([\d.]+)\//.exec(out);
    const lossPct = loss ? parseFloat(loss[1]) : 100;
    return {
        ok: lossPct < 100,
        rttMs: rtt ? parseFloat(rtt[1]) : null,
        loss: lossPct,
    };
}

/** Resolve a name. cb({ok, ms}). Uses GLib's resolver, no subprocess. */
export function resolveAsync(host, cancellable, cb) {
    const t0 = GLib.get_monotonic_time();
    try {
        Gio.Resolver.get_default().lookup_by_name_async(
            host, cancellable, (resolver, res) => {
                let ok = false;
                try {
                    const addrs = resolver.lookup_by_name_finish(res);
                    ok = !!(addrs && addrs.length);
                } catch {
                    ok = false;
                }
                cb({ok, ms: (GLib.get_monotonic_time() - t0) / 1000});
            });
    } catch (e) {
        cb({ok: false, ms: null, error: String(e)});
    }
}

/**
 * Turn the three probes into one state + a plain-language verdict.
 * Pure function -- unit testable.
 */
export function classifyNet({link, gateway, internet, dns}) {
    if (link === false) {
        return {
            state: NET_STATE.DOWN,
            verdict: 'No network link. Wi-Fi or Ethernet is disconnected.',
        };
    }

    if (gateway && gateway.ok === false) {
        return {
            state: NET_STATE.LOCAL,
            verdict: 'Cannot reach the router. The problem is between this ' +
                     'machine and your local network.',
        };
    }

    if (internet && internet.ok === false) {
        return {
            state: NET_STATE.UPSTREAM,
            verdict: gateway && gateway.ok
                ? 'Router responds but the internet does not. The outage is ' +
                  'upstream — your router\'s WAN side or your ISP.'
                : 'Cannot reach the internet.',
        };
    }

    if (dns && dns.ok === false) {
        return {
            state: NET_STATE.DNS,
            verdict: 'Packets get through but names do not resolve. DNS is ' +
                     'broken — the connection itself is fine.',
        };
    }

    if (internet && internet.loss > 0) {
        return {
            state: NET_STATE.LOSSY,
            verdict: `Connected, but dropping ${internet.loss.toFixed(0)}% of ` +
                     'packets. Expect stalls and timeouts.',
        };
    }

    if (internet && internet.rttMs !== null && internet.rttMs > SLOW_MS) {
        return {
            state: NET_STATE.SLOW,
            verdict: `Connected but slow — ${internet.rttMs.toFixed(0)} ms ` +
                     'round trip. Interactive work will feel laggy.',
        };
    }

    if (internet && internet.ok) {
        return {
            state: NET_STATE.OK,
            verdict: internet.rttMs !== null && internet.rttMs <= OK_MS
                ? 'Connection healthy.'
                : 'Connection healthy.',
        };
    }

    return {state: NET_STATE.UNKNOWN, verdict: 'Checking connection…'};
}

export function formatMs(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms))
        return '--';
    if (ms < 10)
        return `${ms.toFixed(1)} ms`;
    return `${ms.toFixed(0)} ms`;
}
