#!/usr/bin/gjs -m
/* selftest.js -- run with:  gjs -m ~/.local/share/gnome-shell/extensions/cputhrottle@joel.local/selftest.js
 *
 * Exercises the sensor + classification layer outside GNOME Shell. Useful
 * because a new extension cannot be loaded into a running Wayland session.
 */

import {SensorPaths, sample, classify, formatGhz, STATE} from './sensors.js';

let failures = 0;
const check = (name, got, want) => {
    const ok = got === want;
    if (!ok)
        failures++;
    print(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}${ok ? '' : `, want ${want}`}`);
};

print('=== resolved sysfs paths ===');
const paths = new SensorPaths();
print(`  cores found      : ${paths.curFreqPaths.length}`);
print(`  cpuinfo_max_freq : ${paths.maxFreqPath}`);
print(`  cpuinfo_min_freq : ${paths.minFreqPath}`);
print(`  throttle dir     : ${paths.throttleDir}`);
print(`  temp path        : ${paths.tempPath ?? paths.tempInputs}`);
print(`  temp label       : ${paths.tempLabel}`);
print(`  paths.ok         : ${paths.ok}`);

print('\n=== live sample ===');
const s = sample(paths);
print(`  current : ${formatGhz(s.curKhz)} (${s.curKhz} kHz)`);
print(`  max     : ${formatGhz(s.maxKhz)}`);
print(`  min     : ${formatGhz(s.minKhz)}`);
print(`  temp    : ${s.tempC} C`);
print(`  reasons : ${JSON.stringify(s.reasons)}`);
print(`  status  : ${s.statusBit}`);
const live = classify(s);
print(`  => state=${live.state}  verdict="${live.verdict}"`);

print('\n=== classification unit tests ===');
const base = {
    curKhz: 4800000, maxKhz: 5400000, minKhz: 400000, tempC: 55,
    reasons: {prochot: false, thermal: false, pl1: false, pl2: false,
        pl4: false, ratl: false, vr_tdc: false, vr_thermalert: false},
    statusBit: false, haveThrottleData: true, tempLabel: 'Package id 0',
};
const mk = o => ({...base, ...o, reasons: {...base.reasons, ...(o.reasons ?? {})}});

check('idle, nothing asserted', classify(mk({})).state, STATE.NORMAL);

check('the bug: prochot + 400 MHz + 45 C',
    classify(mk({reasons: {prochot: true}, curKhz: 400000, tempC: 45})).state,
    STATE.FAULT);

check('the bug: prochot + cool but clock not at floor',
    classify(mk({reasons: {prochot: true}, curKhz: 2000000, tempC: 50})).state,
    STATE.FAULT);

check('legit: prochot + 97 C under load',
    classify(mk({reasons: {prochot: true}, curKhz: 3200000, tempC: 97})).state,
    STATE.THERMAL);

check('ambiguous: prochot at 80 C',
    classify(mk({reasons: {prochot: true}, curKhz: 3200000, tempC: 80})).state,
    STATE.SUSPECT);

check('prochot + pinned at floor at 95 C still reads thermal',
    classify(mk({reasons: {prochot: true}, curKhz: 400000, tempC: 95})).state,
    STATE.THERMAL);

check('thermal reason only, no prochot',
    classify(mk({reasons: {thermal: true}, tempC: 92})).state,
    STATE.THERMAL);

check('power limit only',
    classify(mk({reasons: {pl2: true}})).state,
    STATE.POWER);

check('pinned at floor with no reason set',
    classify(mk({curKhz: 400000})).state,
    STATE.SUSPECT);

check('no throttle data, clock fine',
    classify(mk({haveThrottleData: false, reasons: {}})).state,
    STATE.UNKNOWN);

check('no throttle data, pinned at floor',
    classify(mk({haveThrottleData: false, reasons: {}, curKhz: 400000})).state,
    STATE.SUSPECT);

check('no temp sensor, prochot, pinned at floor',
    classify(mk({reasons: {prochot: true}, curKhz: 400000, tempC: null})).state,
    STATE.FAULT);

check('unreadable cpufreq',
    classify(mk({curKhz: null})).state,
    STATE.UNKNOWN);

check('formatGhz', formatGhz(5053752), '5.1 GHz');
check('formatGhz sub-GHz uses MHz', formatGhz(400000), '400 MHz');
check('formatGhz null', formatGhz(null), '--');

print(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
if (failures > 0)
    imports.system.exit(1);
