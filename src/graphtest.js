import Cairo from 'cairo';
import {Series} from './history.js';
import {drawSeries, computeDomain} from './draw.js';

const W=272,H=86,PAD=10,ROWS=3;
const surf=new Cairo.ImageSurface(Cairo.Format.ARGB32, W+PAD*2, (H+PAD)*ROWS+PAD);
const cr=new Cairo.Context(surf);
cr.setSourceRGBA(0.14,0.16,0.19,1); cr.paint();   // menu-ish backdrop

const now=1_000_000_800_000;
function panel(idx, series, rangeMs, accent, dopts){
  const q=series.query(rangeMs, now);
  const dom=computeDomain(q.points, dopts||{});
  cr.save();
  cr.translate(PAD, PAD+(H+PAD)*idx);
  cr.rectangle(0,0,W,H); cr.setSourceRGBA(0,0,0,0.22); cr.fill();
  cr.rectangle(0,0,W,H); cr.clip();
  drawSeries(cr,W,H,{points:q.points,stepMs:q.stepMs,rangeMs,domain:dom,
                     accent,faultMask:1,now});
  cr.restore();
  print(`  panel ${idx}: ${q.points.length} pts, tier=${q.tier}, domain=[${dom[0].toFixed(0)}, ${dom[1].toFixed(0)}]`);
}

// 1. healthy CPU with a throttle episode in the middle
const cpu=new Series();
for(let i=0;i<900;i++){
  const t=now-(900-i)*2000;
  const thr = i>380 && i<470;
  cpu.push(t, thr?400000:(4200000+Math.sin(i/22)*700000), thr?1:0);
}
panel(0, cpu, 30*60_000, [0.34,0.89,0.54], {floorZero:true});

// 2. network latency with a gap (unreachable) and a spike
const net=new Series();
for(let i=0;i<900;i++){
  const t=now-(900-i)*2000;
  if(i>600&&i<640) net.push(t,null,1);
  else net.push(t, 7+Math.abs(Math.sin(i/13))*6 + (i>700&&i<740?90:0), 0);
}
panel(1, net, 30*60_000, [0.60,0.76,0.95], {robust:true});

// 3. sparse week view
const wk=new Series();
for(let i=0;i<7*24*60;i++){
  const t=now-(7*24*60-i)*60_000;
  wk.push(t, 3000000+Math.sin(i/400)*1500000, (i%2000===0)?1:0);
}
panel(2, wk, 7*86_400_000, [0.34,0.89,0.54], {floorZero:true});

surf.writeToPNG('/tmp/claude-1000/graphpreview.png');
print('  wrote /tmp/claude-1000/graphpreview.png');
