# CPU & Net Watch

Two GNOME Shell panel indicators that answer questions your system monitor
structurally cannot.

![panel](https://img.shields.io/badge/GNOME%20Shell-45--48-4a86cf) ![license](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)

## Why

A system monitor shows CPU **utilisation**, which is a share of whatever clock
the CPU is currently running at. So a chip crawling at 400 MHz because the
embedded controller has latched PROCHOT will show as *busy*, not slow — the
graphs point at your applications while the hardware quietly runs at one
thirteenth of its rated speed. There is no clock-speed field in `/proc/stat`
for the monitor to show you even if it wanted to.

This extension was written after exactly that fault went unnoticed for five
days.

## What it shows

### CPU

The real current clock of the fastest core, and crucially it distinguishes
**legitimate thermal protection** from a **latched fault**:

| State | | Meaning |
|---|---|---|
| Normal | 🚀 | Not throttled |
| Power limit | 🔌 | PL1/PL2/PL4 capping — normal under load |
| Thermal | 🔥 | Hot and protecting itself — **correct behaviour** |
| Suspect | ❔ | Ambiguous: 70–90 °C, or floor-pinned with no reason set |
| **Latched fault** | 🚨 | **The bug.** PROCHOT asserted while cool. |
| Unknown | 🔎 | Sensors unreadable |

Throttling while hot under load is the system doing its job. Throttling while
cool and idle is a fault.

### Clearing a latched fault

In increasing order of disruption:

1. **`sudo tools/prochot off`** — clears it instantly, no reboot. See below.
2. **Reboot** — often enough on its own.
3. **EC reset** — full shutdown, unplug, hold power 15–30 s, boot. The
   fallback when a reboot doesn't do it.

## tools/prochot

`MSR_POWER_CTL` (0x1FC) bit 0 enables the CPU's response to the PROCHOT pin
being asserted externally — by the embedded controller. Clear it and a
*latched* assertion becomes inert immediately.

```sh
sudo tools/prochot status   # BD PROCHOT state, assertion, clock, temp
sudo tools/prochot off      # ignore external PROCHOT
sudo tools/prochot on       # restore
```

This does **not** disable the CPU's own die-temperature protection (TCC), the
thermal trip, or the PL1/PL2/PL4 power limits — those are separate and stay
active. It *does* disable the embedded controller's ability to force a
throttle for reasons the CPU cannot see: VRM temperature, battery current
limits, chassis skin temperature. Use it to escape a stuck assertion, then
turn it back on.

`off` refuses above 85 °C unless forced. The setting is volatile and does not
survive a reboot, which is deliberate — it fails safe.

Requires `msr-tools` and a kernel without lockdown active.

### Network

Diagnoses **by layer** rather than reporting up/down. Three independent async
probes — router, internet, DNS — and the verdict reads the combination:

| State | | Meaning |
|---|---|---|
| Healthy | ✅ | All layers answer, latency sane |
| Slow | 🐌 | Reachable, >150 ms round trip |
| Lossy | 💧 | Reachable but dropping packets |
| DNS | 🔤 | Packets fine, names don't resolve |
| Upstream | 🌐 | Router answers, internet doesn't — ISP or router WAN |
| Local | 📶 | Router unreachable — Wi-Fi or router |
| Offline | 🔌 | No link |

### History

Click either indicator for a chart over **5m / 30m / 1h / 12h / 1d / 7d**.

Samples roll up through three tiers rather than retaining every point:

| Tier | Resolution | Span | Serves |
|---|---|---|---|
| fine | 2 s | 30 min | 5m, 30m |
| minute | 1 min | 24 h | 1h, 12h, 1d |
| coarse | 15 min | 7 d | 7d |

About 3,000 buckets per metric instead of 300,000 raw samples. Each bucket
keeps min/avg/max **plus an OR of the sample flags**, so a 20-second throttle
stays visible as a red stripe on the week view instead of being averaged into
nothing.

Gaps break the line rather than interpolating. Latency uses a
90th-percentile-based Y axis so one spike cannot flatten the baseline. History
persists to `~/.local/share/cpunetwatch/` and survives logout.

## Install

From a release:

```sh
gnome-extensions install cpunetwatch@joelhoro.github.io.shell-extension.zip --force
```

From source:

```sh
make install
```

Then **log out and back in** (GNOME cannot load new extension code in place),
and:

```sh
gnome-extensions enable cpunetwatch@joelhoro.github.io
```

## Cost

~0.4 ms per CPU poll every 2 s — about 0.02% of one core, below the noise
floor of gnome-shell's own rendering. The network probe runs every 10 s, fully
async. Charts repaint only while their menu is open.

## Development

```sh
make test      # run all unit suites under plain gjs
make lint      # syntax-check every module
make preview   # render the chart to a PNG without loading the extension
make pack      # build a distributable zip
```

Five of the eight modules import nothing from GNOME Shell, which is what makes
them testable outside a running session:

| Module | Shell-free | Purpose |
|---|---|---|
| `extension.js` | no | Indicators, menus, wiring |
| `graph.js` | no | `St.DrawingArea` wrapper |
| `sensors.js` | yes | CPU sysfs reads + state classification |
| `net.js` | yes | Layered connectivity probes |
| `history.js` | yes | Tiered ring buffers + persistence |
| `draw.js` | yes | Pure Cairo rendering + Y-axis domain |

## Licence

GPL-2.0-or-later.

## Tiger Watch

A third indicator for a remote host reached over ssh (`TIGER_HOST`, default
`tiger`). One round trip every 60 s collects container health, disk, and
`docker system df`.

| State | | Meaning |
|---|---|---|
| Healthy | ✅ | All containers up, disk and cruft within bounds |
| Housekeeping | 🧹 | Disk ≥80%, ≥40 GB reclaimable, or ≥20 stopped containers |
| Critical | 🚨 | A container is unhealthy or restarting, or disk ≥90% |
| Offline | 🔌 | ssh did not answer |

The panel shows disk percent. The menu gives container counts, how much
`docker system prune` would reclaim, a 7-day disk graph — which is the point,
since a slow leak from accumulating images is invisible in any single `df` —
and your live branch previews as clickable URLs.

### Prune button

The Reclaimable row has a two-step **Prune** button: the first click arms it
(and disarms after six seconds), the second runs it.

It runs `container prune -f && image prune -af && builder prune -af` and
deliberately **not** `docker system prune --volumes`. Dangling volumes are
anonymous ones no container references — typically orphaned application data,
since images like postgres create volumes unnamed. On a real host that was
2.2 GB against 86.3 GB in images, stopped containers and build cache: a poor
trade of data risk for 2.5% more space. Images and cache are regenerable;
volume cleanup stays a deliberate manual act.

Requires passphrase-free key auth to the host, since gnome-shell runs `ssh`
with `BatchMode=yes`.

## Claude Sessions

Panel shows how many Claude Code sessions are active (transcript touched in
the last 15 minutes). The menu gives today's token total, the active sessions
with project · worktree and title, and all-time totals.

Transcripts are 200+ MB of JSONL across dozens of files, so nothing is ever
re-read: each file is tracked by byte offset and only the appended tail is
parsed, with a truncated trailing line carried to the next pass. A cold scan
takes ~750 ms; subsequent ones ~40 ms.

Day buckets use the **local** date. Transcript timestamps are UTC, so slicing
the ISO string puts an evening's work on tomorrow and makes "today" read zero
from late afternoon onward.

## Shell on the host

Tiger Watch has an **Open** button that launches `gnome-terminal -- ssh tiger`.
