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
cool and idle is a fault — and it needs an **EC reset** (full shutdown,
unplug, hold power 15–30 s, boot). A normal reboot will not clear it, because
the embedded controller keeps state across warm restarts.

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
