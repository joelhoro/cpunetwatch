import GLib from 'gi://GLib';
import {parseUsage, classifyUsage, usageCommand, USAGE_STATE,
        WARN_PCT, CRIT_PCT} from './usage.js';
let pass=0,fail=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);
  if(ok){pass++;print(`  PASS  ${n}: ${JSON.stringify(g)}`);}
  else{fail++;print(`  FAIL  ${n}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}};

print('=== parse REAL /usage output ===');
const here=GLib.path_get_dirname(import.meta.url.replace(/^file:\/\//,''));
const [ok,bytes]=GLib.file_get_contents(GLib.build_filenamev([here,'_fixture_usage.txt']));
const u=parseUsage(new TextDecoder().decode(bytes));
print(`  rows: ${u.rows.map(r=>`${r.label}=${r.pct}%`).join(', ')}`);
t('found three limit rows', u.rows.length, 3);
t('session pct', u.session.pct, 18);
t('week pct', u.week.pct, 11);
t('per-model row detected', u.model.label.includes('Fable'), true);
t('session reset captured', u.session.resets, 'Nov 22, 7:40pm');
t('timezone captured', u.session.tz, 'America/New_York');
t('week is not mistaken for the model row', u.week.label, 'Current week (all models)');

print('\n=== classification ===');
const mk=(s,w)=>({ok:true,rows:[1],
  session:{label:'Current session',pct:s,resets:'Nov 22, 7:40pm'},
  week:{label:'Current week (all models)',pct:w,resets:'Nov 28, 6pm'}});
t('low usage -> ok', classifyUsage(mk(18,11)).state, USAGE_STATE.OK);
t('ok verdict quotes both', classifyUsage(mk(18,11)).verdict.includes('18%') &&
  classifyUsage(mk(18,11)).verdict.includes('11%'), true);
t('session over warn -> warn', classifyUsage(mk(WARN_PCT,5)).state, USAGE_STATE.WARN);
t('week over warn -> warn', classifyUsage(mk(5,WARN_PCT)).state, USAGE_STATE.WARN);
t('over crit -> critical', classifyUsage(mk(CRIT_PCT,5)).state, USAGE_STATE.CRITICAL);
t('worst of the two wins', classifyUsage(mk(20,95)).worst.pct, 95);
t('warn verdict names which limit',
  classifyUsage(mk(5,95)).verdict.includes('weekly'), true);
t('warn verdict gives the reset',
  classifyUsage(mk(95,5)).verdict.includes('Nov 22'), true);

print('\n=== degenerate input ===');
t('empty text', parseUsage('').ok, false);
t('null text', parseUsage(null).ok, false);
t('unparseable -> unknown', classifyUsage(parseUsage('garbage')).state, USAGE_STATE.UNKNOWN);
t('null -> unknown', classifyUsage(null).state, USAGE_STATE.UNKNOWN);
t('prose mentioning percent is ignored',
  parseUsage('You have used 50% of something else\n').rows.length, 0);

print('\n=== command shape ===');
t('invokes the slash command', usageCommand('/bin/claude'), ['/bin/claude','-p','/usage']);

print(`\n${fail===0?'ALL TESTS PASSED':fail+' FAILURES'}  (${pass} passed)`);
