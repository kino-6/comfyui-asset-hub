import {comfy, python, port, base} from './qa-config.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'outputs',`qa-space-${Date.now()}`),output=path.join(out,'output'),capacity=path.join(out,'free.txt');
for(const dir of ['output','input','temp','user','models'])await fs.mkdir(path.join(out,dir),{recursive:true});
const fixtureCode=`from pathlib import Path
from PIL import Image,PngImagePlugin
import sys,json
p=Path(sys.argv[1]);Image.new('RGB',(8,8),'#112233').save(p/'tiny.png')
im=Image.new('RGBA',(256,256));im.putdata([(x%256,y%256,(x+y)%256,0 if x%4==0 else 180) for y in range(256) for x in range(256)])
info=PngImagePlugin.PngInfo();info.add_text('workflow',json.dumps({'nodes':[],'links':[]}));info.add_text('prompt','{}')
for name in ['first','second']:im.save(p/(name+'.png'),pnginfo=info,compress_level=0)
`;
function pythonRun(code,...args){const r=spawnSync(python,['-c',code,...args],{cwd:root,windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}
pythonRun(fixtureCode,output);
const originals=new Map();for(const name of ['tiny.png','first.png','second.png'])originals.set(name,await fs.readFile(path.join(output,name)));
async function free(bytes){await fs.writeFile(capacity+'.next',String(bytes));await fs.rename(capacity+'.next',capacity);}
await free(1024**3);
try{await fetch(base+'/system_stats');throw Error('検証ポートが使用中です。');}catch(e){if(e.message.startsWith('検証ポート'))throw e;}
// Fault injection is confined to this child and its private QA directories.
// No disk-filling files or production test switches are used.
const wrapper=`import sys,runpy,shutil
from pathlib import Path
from types import SimpleNamespace
qa=Path(sys.argv.pop(1)).resolve();control=Path(sys.argv.pop(1));real=shutil.disk_usage
def controlled(path):
    usage=real(path)
    if Path(path).resolve().is_relative_to(qa):
        free=int(control.read_text());return SimpleNamespace(total=usage.total,used=usage.total-free,free=free)
    return usage
shutil.disk_usage=controlled
sys.argv[0]='main.py'
runpy.run_path('main.py',run_name='__main__')
`;
const child=spawn(python,['-c',wrapper,out,capacity,'--cpu','--listen','127.0.0.1','--port',String(port),'--disable-auto-launch','--disable-all-custom-nodes','--whitelist-custom-nodes','comfy-asset-hub','--output-directory',output,'--input-directory',path.join(out,'input'),'--temp-directory',path.join(out,'temp'),'--user-directory',path.join(out,'user'),'--models-directory',path.join(out,'models')],{cwd:comfy,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
let log='',browser,page;child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
const report={out,capacitySimulation:'shutil.disk_usage overridden only in isolated ComfyUI child for its QA paths',checks:[],pageErrors:[]};
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);console.log('PASS',label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const v=await predicate();if(v)return v;await sleep(150);}throw Error('timed out');}
async function json(url,body){const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;}
const item=name=>({type:'output',subfolder:'',name});
const done=id=>until(async()=>{const s=await json('/asset_hub/status');return s.job?.id===id&&s.job.status==='done'&&s;});
const waiting=id=>until(async()=>{const s=await json('/asset_hub/status');return s.job?.id===id&&s.job.wait_reason?.includes('空き容量待ち')&&s;});
try{
 await until(async()=>{if(child.exitCode!==null)throw Error(log.slice(-7000));try{return(await fetch(base+'/asset_hub/status')).ok;}catch{return false;}},120000);
 await json('/asset_hub/background',{enabled:false});
 const tinyStat=await fs.stat(path.join(output,'tiny.png'));
 const first=await json('/asset_hub/prepare',{archive:true,items:[item('tiny.png')]});
 const tiny=await done(first.id),record=tiny.records.find(r=>r.item.name==='tiny.png');
 check('non-shrinking result is saved and counted as retained original',record?.state==='not_smaller'&&tiny.job.not_smaller===1&&tiny.job.error_count===0);
 check('non-shrinking original bytes and modification time are unchanged',(await fs.readFile(path.join(output,'tiny.png'))).equals(originals.get('tiny.png'))&&(await fs.stat(path.join(output,'tiny.png'))).mtimeMs===tinyStat.mtimeMs);
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 await page.goto(base,{waitUntil:'domcontentloaded'});await sleep(3500);await page.keyboard.press('Escape');await page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/}).click();await page.waitForSelector('.ib-card.is-file');
 await until(async()=>(await page.locator('[data-progress]').textContent()).includes('原本保持 1件（削減なし）'));
 check('completion explains why original was retained',true);
 const card=page.locator('.ib-card.is-file[data-name="tiny.png"]');
 check('non-shrinking card explains status and disables redundant compression',await card.getByRole('button',{name:'削減なし',exact:true}).isDisabled());
 await page.getByRole('button',{name:'全選択',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 2件');
 check('select all excludes cached non-shrinking PNG', (await page.locator('.ah-toolbar [data-count]').textContent()).includes('削減なし 1件（圧縮対象外）'));
 await page.screenshot({path:path.join(out,'selection.png')});
 await page.getByRole('button',{name:'履歴',exact:true}).click();
 const retainedRow=page.locator(`.ah-record[data-id="${record.id}"]`);
 await retainedRow.waitFor();
 check('storage history does not claim that a retained PNG was replaced',!(await retainedRow.innerText()).includes('→')&&(await retainedRow.innerText()).includes('削減なし・原本保持'));
 await page.locator('.ah-panel [data-close]').click();
 await free(32*1024**2);
 const repeated=await json('/asset_hub/prepare',{archive:true,items:[item('tiny.png')]});const reused=await done(repeated.id);
 check('cached result is reused even when disk is below headroom',reused.job.not_smaller===1&&reused.job.error_count===0&&reused.total===tiny.total&&reused.records.find(r=>r.item.name==='tiny.png').id===record.id);
 const submit=page.waitForResponse(r=>r.url().endsWith('/asset_hub/prepare')&&!!r.request().postDataJSON()?.plan);
 await page.locator('[data-archive]').click();const job=await(await submit).json();const low=await waiting(job.id);
 check('low space prevents new conversion even with background mode disabled',!low.background&&low.job.done===0&&low.job.running.length===0);
 await until(async()=>(await page.locator('[data-progress]').textContent()).includes('空き容量待ち'));
 check('space wait displays needed and available capacity', (await page.locator('[data-progress]').textContent()).includes('必要')&&(await page.locator('[data-progress]').textContent()).includes('空き'));
 await page.screenshot({path:path.join(out,'waiting.png')});
 check('space wait leaves both originals untouched',(await fs.readFile(path.join(output,'first.png'))).equals(originals.get('first.png'))&&(await fs.readFile(path.join(output,'second.png'))).equals(originals.get('second.png'))&&!(await fs.readdir(output)).some(n=>n.endsWith('.webp')));
 await page.locator('[data-stop]').click();const paused=await until(async()=>{const s=await json('/asset_hub/status');return s.job.status==='paused'&&s;});
 check('waiting task can be paused without dropping targets',paused.job.done===0&&paused.job.remaining===2);
 await until(()=>page.locator('[data-resume]').isVisible());await page.locator('[data-resume]').click();await waiting(job.id);
 check('resume retains disk admission control',true);
 await free(1024**3);const archived=await done(job.id);
 check('recovered space automatically continues the same job',archived.job.succeeded===2&&archived.job.error_count===0&&archived.job.done===2);
 const ids=archived.records.filter(r=>r.state==='compacted').map(r=>r.id);
 await free(32*1024**2);const restore=await json('/asset_hub/operate',{action:'restore',ids,workers:4});await waiting(restore.id);
 check('restoration also waits for cache and destination space',!(await fs.readdir(output)).includes('first.png'));
 await free(1024**3);const restored=await done(restore.id);check('restoration continues after space recovers',restored.job.succeeded===2&&restored.job.error_count===0);
 // Verify pixels including RGB under zero alpha, and embedded generation metadata.
 const reference=path.join(out,'reference.png');await fs.writeFile(reference,originals.get('first.png'));
 pythonRun(`from PIL import Image\nfrom pathlib import Path\nimport sys\na=Image.open(sys.argv[1])\nfor name in ['first.png','second.png']:\n b=Image.open(Path(sys.argv[2])/name);assert a.convert('RGBA').tobytes()==b.convert('RGBA').tobytes();assert a.info['workflow']==b.info['workflow'];assert a.info['prompt']==b.info['prompt']`,reference,output);
 check('archive and restore preserve exact RGBA and workflow metadata',true);
 await fs.writeFile(path.join(output,'tiny.png'),originals.get('first.png'));
 const changed=await json('/asset_hub/selection',{items:[item('tiny.png')]});check('modified original is eligible for reevaluation',changed.archive===1&&changed.unchanged===0);
 const updated=await json('/asset_hub/prepare',{archive:true,items:[item('tiny.png')]});const reevaluated=await done(updated.id);
 check('changed image is actually recompressed',reevaluated.job.succeeded===1&&reevaluated.records.find(r=>r.item.name==='tiny.png'&&r.state==='compacted'));
 check('no browser exceptions',report.pageErrors.length===0);
 await fs.writeFile(path.join(root,'outputs/latest-space-qa.json'),JSON.stringify(report,null,2));
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-ui.txt'),await page.locator('body').innerText());}}
finally{await browser?.close();if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await fs.writeFile(path.join(out,'server.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts:',out);}
