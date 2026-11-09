/* tiger.js -- remote host health over one ssh round trip.
 *
 * Imports nothing from GNOME Shell, so the parsing and classification are
 * unit tested under plain gjs against captured real output.
 */

export const TIGER_STATE = {
    OK:          'ok',
    WARN:        'warn',
    CRITICAL:    'critical',
    UNREACHABLE: 'unreachable',
    UNKNOWN:     'unknown',
};

/* Thresholds */
export const DISK_CRIT = 90;
export const DISK_WARN = 80;
export const RECLAIM_WARN_GB = 40;
export const EXITED_WARN = 20;

const SEP = '===CNW===';

/** One command, one round trip. Sections are separated by a sentinel. */
export function remoteCommand() {
    return [
        `docker ps --format '{{.Names}}\t{{.Status}}'`,
        `echo ${SEP}`,
        `docker ps -a --filter status=exited -q | wc -l`,
        `echo ${SEP}`,
        `df -P / | tail -1`,
        `echo ${SEP}`,
        `docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'`,
    ].join('; ');
}

/** "4.21GB" / "980.6MB" / "0B" -> bytes. Tolerates junk. */
export function parseSize(s) {
    const m = /^([\d.]+)\s*([KMGT]?)i?B?$/i.exec((s ?? '').trim());
    if (!m)
        return 0;
    const mult = {'': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12}[m[2].toUpperCase()] ?? 1;
    return parseFloat(m[1]) * mult;
}

/** Docker's reclaimable column is "41.21GB (50%)" -- take the size. */
export function parseReclaimable(s) {
    return parseSize((s ?? '').split('(')[0]);
}

function containerHealth(status) {
    const t = (status ?? '').toLowerCase();
    if (t.startsWith('restarting'))
        return 'restarting';
    if (t.includes('(unhealthy)'))
        return 'unhealthy';
    if (t.startsWith('up'))
        return 'up';
    return 'other';
}

/** A branch preview, by the naming the deploy scripts use. */
export function isPreview(name) {
    return /(^|-)br-/.test(name) || /branches/.test(name);
}

/** Parse the combined stdout into a structured report. */
export function parseReport(stdout) {
    const [psRaw = '', exitedRaw = '', dfRaw = '', sysRaw = ''] =
        (stdout ?? '').split(SEP);

    const containers = [];
    for (const line of psRaw.split('\n')) {
        const [name, status] = line.split('\t');
        if (!name || !name.trim())
            continue;
        containers.push({
            name: name.trim(),
            status: (status ?? '').trim(),
            health: containerHealth(status),
        });
    }

    const exited = parseInt(exitedRaw.trim(), 10);

    // df -P: Filesystem 1K-blocks Used Available Capacity Mounted
    const f = dfRaw.trim().split(/\s+/);
    let disk = null;
    if (f.length >= 6) {
        const totalKb = parseInt(f[1], 10);
        const usedKb = parseInt(f[2], 10);
        const pct = parseInt((f[4] ?? '').replace('%', ''), 10);
        if (Number.isFinite(totalKb) && Number.isFinite(usedKb))
            disk = {usedGb: usedKb / 1e6, totalGb: totalKb / 1e6, pct};
    }

    let reclaimable = 0;
    let reclaimableVolumes = 0;
    for (const line of sysRaw.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3)
            continue;
        const bytes = parseReclaimable(parts[2]);
        reclaimable += bytes;
        if (/volume/i.test(parts[0]))
            reclaimableVolumes += bytes;
    }

    return {
        containers,
        running: containers.length,
        unhealthy: containers.filter(c => c.health === 'unhealthy'),
        restarting: containers.filter(c => c.health === 'restarting'),
        previews: containers.filter(c => isPreview(c.name)),
        exited: Number.isFinite(exited) ? exited : null,
        disk,
        reclaimableGb: reclaimable / 1e9,
        reclaimableVolumesGb: reclaimableVolumes / 1e9,
    };
}

/** Report -> state + one plain-language verdict. */
export function classifyTiger(report, reachable = true) {
    if (!reachable) {
        return {
            state: TIGER_STATE.UNREACHABLE,
            verdict: 'Cannot reach tiger over ssh.',
        };
    }
    if (!report || !report.running) {
        return {
            state: TIGER_STATE.UNKNOWN,
            verdict: 'Connected, but no containers reported.',
        };
    }

    const bad = [...report.unhealthy, ...report.restarting];
    if (bad.length) {
        const names = bad.slice(0, 3).map(c => c.name).join(', ');
        return {
            state: TIGER_STATE.CRITICAL,
            verdict: `${bad.length} container${bad.length > 1 ? 's' : ''} ` +
                     `need attention: ${names}${bad.length > 3 ? '…' : ''}.`,
        };
    }

    if (report.disk && report.disk.pct >= DISK_CRIT) {
        return {
            state: TIGER_STATE.CRITICAL,
            verdict: `Disk is ${report.disk.pct}% full. Deploys will start failing.`,
        };
    }

    if (report.disk && report.disk.pct >= DISK_WARN) {
        return {
            state: TIGER_STATE.WARN,
            verdict: `Disk is ${report.disk.pct}% full — ` +
                     `${report.reclaimableGb.toFixed(0)} GB is reclaimable.`,
        };
    }

    if (report.reclaimableGb >= RECLAIM_WARN_GB) {
        return {
            state: TIGER_STATE.WARN,
            verdict: `${report.reclaimableGb.toFixed(0)} GB of images and build ` +
                     'cache can be pruned.',
        };
    }

    if (report.exited !== null && report.exited >= EXITED_WARN) {
        return {
            state: TIGER_STATE.WARN,
            verdict: `${report.exited} stopped containers are piling up.`,
        };
    }

    return {
        state: TIGER_STATE.OK,
        verdict: `All ${report.running} containers healthy.`,
    };
}

/** "nutrition-br-app-walkthrough-web" -> a guessable preview URL. */
export function previewUrl(name, domain = 'horowitz.com') {
    const m = /^(.+?)-br-(.+?)-(web|api|app)$/.exec(name);
    if (m)
        return `https://${m[1]}-${m[2]}.${domain}`;
    const r = /^(.+?)-branches-router/.exec(name);
    if (r)
        return `https://${r[1]}.${domain}`;
    return null;
}

/**
 * Prune command for the menu button.
 *
 * Deliberately NOT `docker system prune --volumes`. Dangling volumes are
 * anonymous ones no container references -- on this host that is orphaned
 * application data (postgres and friends create them unnamed) worth only a
 * couple of GB. Images, stopped containers and build cache are regenerable
 * and account for nearly all of the reclaimable space, so the button stops
 * there. Volume cleanup stays a deliberate manual act.
 */
export function pruneCommand() {
    return [
        'docker container prune -f',
        'docker image prune -af',
        'docker builder prune -af',
    ].join(' && ');
}

/** GB that pruneCommand() would actually free (volumes excluded). */
export function prunableGb(report) {
    if (!report)
        return 0;
    return Math.max(0, report.reclaimableGb - (report.reclaimableVolumesGb ?? 0));
}
