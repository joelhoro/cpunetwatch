import {splitRuns, computeDomain} from './draw.js';
let pass=0,fail=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);
  if(ok){pass++;print(`  PASS  ${n}: ${JSON.stringify(g)}`);}
  else{fail++;print(`  FAIL  ${n}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}};
const pts=(times,opts={})=>times.map(x=>({t:x,min:1,max:1,avg:1,flags:0,empty:!!(opts.emptyAt||[]).includes(x)}));

print('=== REGRESSION: 10s samples in a 2s tier must be ONE run ===');
const net=pts([0,10000,20000,30000,40000,50000]);
t('net cadence 10s, tier 2s -> 1 run', splitRuns(net,2000).length, 1);
t('and keeps all 6 points', splitRuns(net,2000)[0].length, 6);

print('\n=== CPU at the tier cadence still works ===');
t('2s samples in 2s tier -> 1 run', splitRuns(pts([0,2000,4000,6000]),2000).length, 1);

print('\n=== real gaps still split ===');
const gapped=pts([0,10000,20000, 300000,310000,320000]);
t('a 280s hole splits into 2 runs', splitRuns(gapped,2000).length, 2);
t('  first run size', splitRuns(gapped,2000)[0].length, 3);
t('  second run size', splitRuns(gapped,2000)[1].length, 3);

print('\n=== explicit empty buckets split ===');
const withEmpty=pts([0,10000,20000,30000],{emptyAt:[20000]});
t('empty bucket breaks the line', splitRuns(withEmpty,2000).length, 2);
t('empty point excluded from runs',
  splitRuns(withEmpty,2000).flat().some(p=>p.t===20000), false);

print('\n=== degenerate inputs ===');
t('no points', splitRuns([],2000).length, 0);
t('single point -> one run of one', splitRuns(pts([0]),2000)[0].length, 1);
t('irregular cadence tolerated',
  splitRuns(pts([0,9000,21000,29000,41000]),2000).length, 1);

print('\n=== computeDomain ===');
const spiky=[...Array(40)].map((_,i)=>({t:i*1000,min:7,max:i===38?400:9,avg:8,flags:0,empty:false}));
const robust=computeDomain(spiky,{robust:true});
const plain=computeDomain(spiky,{});
t('robust ceiling ignores the outlier', robust[1] < 40, true);
t('plain ceiling follows the outlier', plain[1] > 400, true);
t('floorZero pins the base', computeDomain(spiky,{floorZero:true})[0], 0);
t('empty input is safe', computeDomain([],{}), [0,1]);

print(`\n${fail===0?'ALL TESTS PASSED':fail+' FAILURES'}  (${pass} passed)`);
