import GLib from 'gi://GLib';
import {parseReport, classifyTiger, parseSize, parseReclaimable,
        isPreview, previewUrl, TIGER_STATE} from './tiger.js';
let pass=0,fail=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);
  if(ok){pass++;print(`  PASS  ${n}: ${JSON.stringify(g)}`);}
  else{fail++;print(`  FAIL  ${n}: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);}};

print('=== parseSize ===');
t('GB', parseSize('81.7GB'), 81.7e9);
t('MB', parseSize('980.6MB'), 980.6e6);
t('zero', parseSize('0B'), 0);
t('junk is 0', parseSize('wat'), 0);
t('reclaimable strips pct', parseReclaimable('41.21GB (50%)'), 41.21e9);

print('\n=== isPreview / previewUrl ===');
t('branch container', isPreview('nutrition-br-app-walkthrough-web'), true);
t('branches router', isPreview('deal-flow-crm-branches-router-1'), true);
t('plain app is not', isPreview('portfolio-web-1'), false);
t('preview url', previewUrl('nutrition-br-app-walkthrough-web'),
  'https://nutrition-app-walkthrough.horowitz.com');

print('\n=== parse REAL tiger output ===');
// Resolve beside this module, not against the caller's working directory.
const here=GLib.path_get_dirname(import.meta.url.replace(/^file:\/\//,''));
const [ok,bytes]=GLib.file_get_contents(GLib.build_filenamev([here,'_fixture_tiger.txt']));
const r=parseReport(new TextDecoder().decode(bytes));
print(`  running=${r.running} unhealthy=${r.unhealthy.length} restarting=${r.restarting.length} exited=${r.exited}`);
print(`  disk=${r.disk.pct}% (${r.disk.usedGb.toFixed(0)}/${r.disk.totalGb.toFixed(0)} GB)  reclaimable=${r.reclaimableGb.toFixed(1)} GB`);
print(`  previews=${r.previews.map(c=>c.name).join(', ')}`);
t('found containers', r.running > 30, true);
t('no unhealthy right now', r.unhealthy.length, 0);
t('disk pct parsed', r.disk.pct, 68);
t('reclaimable ~88GB', Math.round(r.reclaimableGb), 88);
t('exited parsed', r.exited > 0, true);
t('previews detected', r.previews.length >= 3, true);

print('\n=== classification ===');
t('real state is warn (reclaimable)', classifyTiger(r).state, TIGER_STATE.WARN);
t('unreachable', classifyTiger(null,false).state, TIGER_STATE.UNREACHABLE);
const healthy={running:5,unhealthy:[],restarting:[],previews:[],exited:1,
               disk:{pct:40,usedGb:40,totalGb:100},reclaimableGb:2};
t('healthy -> ok', classifyTiger(healthy).state, TIGER_STATE.OK);
t('unhealthy beats disk', classifyTiger({...healthy,
   unhealthy:[{name:'x'}],disk:{pct:95}}).state, TIGER_STATE.CRITICAL);
t('full disk -> critical', classifyTiger({...healthy,disk:{pct:95}}).state, TIGER_STATE.CRITICAL);
t('80% disk -> warn', classifyTiger({...healthy,disk:{pct:85}}).state, TIGER_STATE.WARN);
t('many exited -> warn', classifyTiger({...healthy,exited:40}).state, TIGER_STATE.WARN);
t('verdict names the container', classifyTiger({...healthy,
   restarting:[{name:'boom-web-1'}]}).verdict.includes('boom-web-1'), true);

print(`\n${fail===0?'ALL TESTS PASSED':fail+' FAILURES'}  (${pass} passed)`);
