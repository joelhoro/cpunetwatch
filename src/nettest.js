import GLib from 'gi://GLib';
import {classifyNet, parsePing, defaultGateway, haveLink, pingAsync,
        resolveAsync, formatMs, NET_STATE} from './net.js';

let pass=0, fail=0;
const t=(name,got,want)=>{ if(got===want){pass++;print(`  PASS  ${name}: ${got}`);}
  else{fail++;print(`  FAIL  ${name}: got ${got} want ${want}`);} };

print('=== live environment ===');
print(`  gateway : ${defaultGateway()}`);
print(`  link up : ${haveLink()}`);

print('\n=== parsePing ===');
const sample=`3 packets transmitted, 3 received, 0% packet loss, time 601ms
rtt min/avg/max/mdev = 5.065/6.355/8.225/1.353 ms`;
const p=parsePing(sample);
t('parses loss', p.loss, 0);
t('parses avg rtt', p.rttMs, 6.355);
t('ok when replies', p.ok, true);
const lost=parsePing('3 packets transmitted, 0 received, 100% packet loss, time 2050ms');
t('total loss -> not ok', lost.ok, false);
t('total loss -> 100', lost.loss, 100);

print('\n=== classifyNet layering ===');
const ok={ok:true,rttMs:8,loss:0};
t('all healthy', classifyNet({link:true,gateway:ok,internet:ok,dns:{ok:true,ms:5}}).state, NET_STATE.OK);
t('no link', classifyNet({link:false}).state, NET_STATE.DOWN);
t('router unreachable', classifyNet({link:true,gateway:{ok:false,loss:100},internet:ok,dns:{ok:true}}).state, NET_STATE.LOCAL);
t('router ok internet dead', classifyNet({link:true,gateway:ok,internet:{ok:false,loss:100},dns:{ok:true}}).state, NET_STATE.UPSTREAM);
t('packets ok dns dead', classifyNet({link:true,gateway:ok,internet:ok,dns:{ok:false}}).state, NET_STATE.DNS);
t('lossy', classifyNet({link:true,gateway:ok,internet:{ok:true,rttMs:20,loss:33},dns:{ok:true}}).state, NET_STATE.LOSSY);
t('slow', classifyNet({link:true,gateway:ok,internet:{ok:true,rttMs:400,loss:0},dns:{ok:true}}).state, NET_STATE.SLOW);
t('local beats upstream', classifyNet({link:true,gateway:{ok:false},internet:{ok:false},dns:{ok:false}}).state, NET_STATE.LOCAL);

print('\n=== formatMs ===');
t('sub-10 keeps decimal', formatMs(6.355), '6.4 ms');
t('over-10 rounds', formatMs(142.7), '143 ms');
t('null', formatMs(null), '--');

print('\n=== live async probes ===');
const loop=GLib.MainLoop.new(null,false);
let left=2;
const fin=()=>{ if(--left===0){
  print(`\n${fail===0?'ALL TESTS PASSED':fail+' FAILURES'}  (${pass} passed)`); loop.quit(); } };
pingAsync('1.1.1.1',{count:2},r=>{ print(`  ping 1.1.1.1 -> ok=${r.ok} rtt=${formatMs(r.rttMs)} loss=${r.loss}%`); fin(); });
resolveAsync('cloudflare.com',null,r=>{ print(`  resolve cloudflare.com -> ok=${r.ok} in ${formatMs(r.ms)}`); fin(); });
loop.run();
