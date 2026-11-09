import GLib from 'gi://GLib';
import {addAcc, localDay, describeSlug, parseJsonl, foldRecords, addUsage, emptyUsage,
        totalTokens, formatTokens, scanSessions, sessionLabel} from './claude.js';
let pass=0,fail=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);
  if(ok){pass++;print(`  PASS  ${n}: ${JSON.stringify(g)}`);}
  else{fail++;print(`  FAIL  ${n}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}};

print('=== describeSlug ===');
t('plain project', describeSlug('-home-joel-dev-godot'), {project:'godot',worktree:null});
t('worktree, hex stripped',
  describeSlug('-home-joel-dev-godot--claude-worktrees-step-name-sliding-credits-94eeac'),
  {project:'godot',worktree:'step-name-sliding-credits'});
t('unknown shape passes through',
  describeSlug('weird').project, 'weird');

print('\n=== parseJsonl: incremental, tolerant ===');
const a=parseJsonl('{"a":1}\n{"b":2}\n{"c":');
t('complete records', a.records.length, 2);
t('partial line carried', a.leftover, '{"c":');
const b=parseJsonl('3}\n', a.leftover);
t('carry completes it', b.records[0], {c:3});
t('corrupt line skipped', parseJsonl('{bad\n{"ok":1}\n').records.length, 1);
t('blank lines ignored', parseJsonl('\n\n{"x":1}\n').records.length, 1);

print('\n=== usage folding ===');
const st={lastTs:0,branch:null,title:null,titleIsCustom:false,usage:emptyUsage(),byDay:{}};
foldRecords(st,[
  {timestamp:'2026-11-08T10:00:00Z', gitBranch:'master',
   message:{usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:100}}},
  {type:'ai-title', aiTitle:'Auto name'},
  {type:'custom-title', customTitle:'My name'},
  {timestamp:'2026-11-08T11:00:00Z',
   message:{usage:{input_tokens:1,output_tokens:2}}},
]);
t('input summed', st.usage.input, 11);
t('cache reads counted', st.usage.cacheRead, 100);
t('output summed', st.usage.output, 7);
t('branch captured', st.branch, 'master');
t('custom title wins', st.title, 'My name');
t('per-day bucket', totalTokens(st.byDay['2026-11-08']), 118);
t('latest timestamp kept', st.lastTs, Date.parse('2026-11-08T11:00:00Z'));

print('\n=== ai-title does not clobber a custom one ===');
const st2={lastTs:0,branch:null,title:null,titleIsCustom:false,usage:emptyUsage(),byDay:{}};
foldRecords(st2,[{type:'custom-title',customTitle:'Mine'},{type:'ai-title',aiTitle:'Robot'}]);
t('custom survives', st2.title, 'Mine');

print('\n=== formatTokens ===');
t('millions', formatTokens(532_600_000), '532.6M');
t('thousands', formatTokens(1416), '1k');
t('small', formatTokens(42), '42');

print('\n=== local-day bucketing (the UTC rollover bug) ===');
// 21:30 local on Nov 8 is already Nov 9 in UTC
const evening = new Date(2026, 10, 8, 21, 30).getTime();
t('local day, not UTC day', localDay(evening), '2026-11-08');
t('UTC slice would have said', new Date(evening).toISOString().slice(0,10), '2026-11-09');
const st3={lastTs:0,branch:null,title:null,titleIsCustom:false,usage:emptyUsage(),byDay:{}};
foldRecords(st3,[{timestamp:new Date(evening).toISOString(),
                  message:{usage:{input_tokens:7}}}]);
t('evening work lands on the local day', Object.keys(st3.byDay), ['2026-11-08']);
t('bad timestamp -> null day', localDay(NaN), null);

print('\n=== addAcc vs addUsage: the shapes are different ===');
const dst=emptyUsage();
addAcc(dst,{input:5,cacheRead:50,cacheWrite:2,output:3});
t('addAcc sums folded buckets', totalTokens(dst), 60);
const wrong=emptyUsage();
addUsage(wrong,{input:5,cacheRead:50,output:3});   // folded shape, wrong fn
t('addUsage on a folded bucket adds nothing', totalTokens(wrong), 0);
const right=emptyUsage();
addUsage(right,{input_tokens:5,cache_read_input_tokens:50,output_tokens:3});
t('addUsage on the raw API shape works', totalTokens(right), 58);
t('addAcc tolerates null', totalTokens(addAcc(emptyUsage(),null)), 0);

print('\n=== REAL scan of ~/.claude/projects ===');
const root=GLib.build_filenamev([GLib.get_home_dir(),'.claude','projects']);
const cache=new Map();
let t0=GLib.get_monotonic_time();
const r1=scanSessions(root,cache);
const cold=(GLib.get_monotonic_time()-t0)/1000;
t0=GLib.get_monotonic_time();
const r2=scanSessions(root,cache);
const warm=(GLib.get_monotonic_time()-t0)/1000;
print(`  sessions=${r1.sessions.length} active=${r1.active.length}`);
print(`  today (${r1.today}) = ${formatTokens(totalTokens(r1.todayUsage))} tokens`);
print(`  cold scan ${cold.toFixed(0)} ms -> warm rescan ${warm.toFixed(0)} ms`);
for (const s of r1.sessions.slice(0,3))
  print(`    ${formatTokens(totalTokens(s.usage)).padStart(7)}  ${sessionLabel(s).slice(0,56)}`);
t('found sessions', r1.sessions.length > 10, true);
t('warm rescan is far cheaper', warm < cold/5, true);
t('totals stable across rescans',
  totalTokens(r1.sessions[0].usage), totalTokens(r2.sessions[0].usage));
t('today total is non-zero when sessions ran today',
  totalTokens(r1.todayUsage) > 0, true);
t('today total equals the sum of per-session day buckets',
  totalTokens(r1.todayUsage),
  r1.sessions.reduce((n,s)=>n+(s.byDay[r1.today]?totalTokens(s.byDay[r1.today]):0),0));

print(`\n${fail===0?'ALL TESTS PASSED':fail+' FAILURES'}  (${pass} passed)`);
