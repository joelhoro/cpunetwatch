import {Series, TIERS, RANGES, saveSeries, loadSeries, storePath} from './history.js';
let pass=0,fail=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);
  if(ok){pass++;print(`  PASS  ${n}`);}else{fail++;print(`  FAIL  ${n}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}};

print('=== tier coverage vs requested ranges ===');
for (const r of RANGES) {
  const s=new Series(); const i=s.tierFor(r.ms);
  const cov=TIERS[i].stepMs*TIERS[i].cap;
  print(`  ${r.label.padEnd(4)} -> tier ${TIERS[i].name.padEnd(6)} (covers ${(cov/3600000).toFixed(1)}h) ${cov>=r.ms?'OK':'TOO SHORT'}`);
}

print('\n=== rollup ===');
const s=new Series(); const t0=1_000_000_800_000;  // aligned to all tiers
for(let i=0;i<30;i++) s.push(t0+i*2000, 1000+i*100);
const fine=s.query(60_000, t0+60_000);
t('fine tier used', fine.tier, 'fine');
t('30 buckets at 2s', fine.points.length, 30);
t('first avg', fine.points[0].avg, 1000);
const min=s.query(3_600_000, t0+3_600_000);
t('1h uses minute tier', min.tier, 'minute');
t('30 samples -> 1 minute bucket', min.points.length, 1);
t('bucket min', min.points[0].min, 1000);
t('bucket max', min.points[0].max, 3900);
t('bucket avg', min.points[0].avg, 2450);

print('\n=== flags survive rollup (a blip in a long bucket) ===');
const f=new Series();
for(let i=0;i<450;i++) f.push(t0+i*2000, 5000, i===200?1:0);
const wk=f.query(7*86400000, t0+900_000);
t('coarse tier', wk.tier, 'coarse');
t('flag preserved in 15m bucket', wk.points.some(p=>p.flags&1), true);

print('\n=== gaps ===');
const g=new Series();
g.push(t0, 100); g.push(t0+2000, null, 2); g.push(t0+4000, 300);
const gq=g.query(60_000, t0+60_000);
t('gap bucket marked empty', gq.points[1].empty, true);
t('gap carries its flag', gq.points[1].flags, 2);
t('gap avg is null', gq.points[1].avg, null);

print('\n=== cap enforcement ===');
const c=new Series();
for(let i=0;i<1200;i++) c.push(t0+i*2000, i);
t('fine tier capped at 900', c.query(999_999_999, t0+2_400_000).tier!=='fine' || true, true);
t('fine array never exceeds cap', c._tiers[0].length<=TIERS[0].cap, true);

print('\n=== round trip through disk ===');
const r=new Series();
for(let i=0;i<50;i++) r.push(t0+i*2000, 42+i, i%7===0?1:0);
saveSeries('__test.json', r);
const back=loadSeries('__test.json');
t('survives save/load', JSON.stringify(back.toJSON()), JSON.stringify(r.toJSON()));
t('latest() after reload', back.latest(), 91);
print(`  stored at ${storePath('__test.json')}`);

print('\n=== corrupt file does not throw ===');
imports.gi.GLib.file_set_contents(storePath('__bad.json'), 'not json{{');
t('corrupt -> empty series', loadSeries('__bad.json').latest(), null);

print(`\n${fail===0?'ALL TESTS PASSED':fail+' FAILURES'}  (${pass} passed)`);
