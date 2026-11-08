import {comfy, python, port, base} from './qa-config.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'outputs',`qa-resume-${Date.now()}`),output=path.join(out,'output');
for(const folder of ['output','input','temp','user','models'])await fs.mkdir(path.join(out,folder),{recursive:true});
const fixtureCode=`from pathlib import Path
import json,random,sys
from PIL import Image,ImageDraw,PngImagePlugin
p=Path(sys.argv[1]);size=(1536,2048)
im=Image.frombytes('RGB',size,random.Random(7).randbytes(size[0]*size[1]*3))
ImageDraw.Draw(im).rectangle((0,0,1000,1800),fill='#246388')
info=PngImagePlugin.PngInfo();info.add_text('workflow',json.dumps({'nodes':[],'links':[]}));info.add_text('prompt','{}')
im.save(p/'fixture.png',pnginfo=info)
for i in range(32):(p/f'item-{i:02}.png').hardlink_to(p/'fixture.png')
(p/'good.png').hardlink_to(p/'fixture.png')
(p/'changed.png').write_bytes((p/'fixture.png').read_bytes())
for i in range(25):(p/f'bad-{i:02}.png').write_bytes(b'broken PNG')
`;
const fixture=spawnSync(python,['-c',fixtureCode,output],{windowsHide:true,encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
try{await fetch(base+'/system_stats');throw Error('検証ポートが使用中です。');}catch(e){if(e.message.startsWith('検証ポート'))throw e;}
let child,browser,page,log='';const report={out,checks:[],pageErrors:[]};
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);console.log('PASS',label);};
async function json(url,body){const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await sleep(150);}throw Error('timed out');}
async function start(){
 child=spawn(python,['main.py','--cpu','--listen','127.0.0.1','--port',String(port),'--disable-auto-launch','--disable-all-custom-nodes','--whitelist-custom-nodes','comfy-asset-hub','--output-directory',output,'--input-directory',path.join(out,'input'),'--temp-directory',path.join(out,'temp'),'--user-directory',path.join(out,'user'),'--models-directory',path.join(out,'models')],{cwd:comfy,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 await until(async()=>{if(child.exitCode!==null)throw Error(log.slice(-7000));try{return (await fetch(base+'/asset_hub/status')).ok;}catch{return false;}},120000);
}
async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}child=null;}
async function open(){await page.goto(base,{waitUntil:'domcontentloaded'});await sleep(3500);await page.keyboard.press('Escape');await page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/}).click();await page.waitForSelector('.ib-card.is-file');}
const item=name=>({type:'output',subfolder:'',name});
const history=async id=>(await json('/asset_hub/jobs')).jobs.find(j=>j.id===id);
const done=id=>until(async()=>{const j=await history(id);return j?.status==='done'&&j;});
try{
 await start();
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 await open();
 check('CPU target is visible and defaults to 70 percent',await page.getByLabel('CPU目標').inputValue()==='70');
 await page.getByLabel('CPU目標').selectOption('full');await until(async()=>!(await json('/asset_hub/status')).background);
 check('background control reaches the server',true);
 const errors=await json('/asset_hub/prepare',{archive:true,workers:4,items:[item('good.png'),...Array.from({length:25},(_,i)=>item(`bad-${String(i).padStart(2,'0')}.png`))]});
 const failed=await done(errors.id);check('all 25 failures are counted beyond previous 20-entry limit',failed.error_count===25&&failed.succeeded===1);
 const goodStamp=(await fs.stat(path.join(output,'good.webp'))).mtimeMs;
 const job=await json('/asset_hub/prepare',{archive:true,workers:1,items:Array.from({length:32},(_,i)=>item(`item-${String(i).padStart(2,'0')}.png`))});
 await until(async()=>{const s=await json('/asset_hub/status');return s.job.id===job.id&&s.job.done>0&&s.job.status==='running';});
 const queued=await json('/asset_hub/prepare',{archive:true,workers:1,items:[item('item-31.png'),item('changed.png')]});check('second job is queued',queued.status==='queued');
 await page.locator('[data-stop]').click();
 const paused=await until(async()=>{const s=await json('/asset_hub/status');return s.job.id===job.id&&s.job.status==='paused'&&s;});
 check('pause retains unfinished work and pauses queued jobs',paused.job.done<32&&paused.job.done>0&&paused.queue.length===0&&(await history(queued.id)).status==='paused');
 await fs.appendFile(path.join(output,'changed.png'),'changed while paused');
 const completedBefore=paused.records.filter(r=>r.item.name.startsWith('item-')&&r.state==='compacted');
 const stamps=new Map();for(const r of completedBefore)stamps.set(r.target_name,(await fs.stat(path.join(output,r.target_name))).mtimeMs);
 await until(async()=>await page.locator('[data-resume]').isVisible());
 await page.screenshot({path:path.join(out,'paused.png')});
 await page.locator('[data-resume]').click();
 await until(async()=>{const s=await json('/asset_hub/status');return s.job.id===job.id&&s.job.done>paused.job.done&&s.job.status==='running';});
 await stop(); // Deliberately interrupt a running job in the isolated server.
 // Only the isolated QA database is downgraded to exercise startup migration.
 const legacy=spawnSync(python,['-c',`from pathlib import Path
import sqlite3,sys
from contextlib import closing
from record_codec import unpack_text
paths=list(Path(sys.argv[1]).rglob('records.sqlite3'));assert len(paths)==1
with closing(sqlite3.connect(paths[0])) as db:
 for key,value in db.execute('SELECT id,payload FROM records').fetchall():
  db.execute('UPDATE records SET payload=? WHERE id=?',(unpack_text(value),key))
 db.execute('DROP TABLE asset_hub_storage');db.commit()
`,path.join(out,'user')],{cwd:root,windowsHide:true,encoding:'utf8'});
 assert.equal(legacy.status,0,legacy.stderr);
 await start();
 const migrated=spawnSync(python,['-c',`from pathlib import Path
import sqlite3,sys,gzip,json
from contextlib import closing
paths=list(Path(sys.argv[1]).rglob('records.sqlite3'));assert len(paths)==1
p=paths[0];backups=list(p.parent.glob('records-before-compression-*.sqlite3.gz'));assert len(backups)==1
with closing(sqlite3.connect(p)) as db:
 assert db.execute("SELECT value FROM asset_hub_storage WHERE key='compact_pending'").fetchone()[0]=='0'
 assert db.execute("SELECT count(*) FROM records WHERE typeof(payload)='blob'").fetchone()[0]>0
old=p.parent/'rollback-test.sqlite3';old.write_bytes(gzip.decompress(backups[0].read_bytes()))
with closing(sqlite3.connect(old)) as db:
 for value, in db.execute('SELECT payload FROM records'):json.loads(value)
old.unlink()
`,path.join(out,'user')],{cwd:root,windowsHide:true,encoding:'utf8'});
 check('startup migrates legacy database and retains readable rollback backup',migrated.status===0);
 const recovered=await history(job.id);
 check('process restart retains checkpoints and recovers interrupted job as paused',recovered.status==='paused'&&recovered.done>paused.job.done&&recovered.done<32);
 check('queued work and all failure details survive restart',(await history(queued.id)).status==='paused'&&(await json(`/asset_hub/jobs/${errors.id}/errors`)).errors.length===25);
 check('background preference persists',!(await json('/asset_hub/status')).background);
 await open();
 await page.locator('[data-jobs]').click();
 await page.locator(`[data-job="${job.id}"]`).getByRole('button',{name:'再開',exact:true}).click();
 const finish=await done(job.id);check('resume completes remaining images without errors',finish.done===32&&finish.succeeded+finish.skipped===32&&finish.error_count===0);
 for(const [name,stamp] of stamps)assert.equal((await fs.stat(path.join(output,name))).mtimeMs,stamp);
 check('already completed WebP files are not recompressed',true);
 const panel=page.locator('.ah-panel').last();await panel.locator('[data-refresh]').click();
 await page.locator(`[data-job="${errors.id}"]`).getByRole('button',{name:'失敗の詳細'}).click();
 await until(async()=>await panel.locator('.ah-task').count()===25);
 check('UI shows all 25 persisted failures',await panel.locator('.ah-task').count()===25);
 await page.screenshot({path:path.join(out,'errors.png')});
 await panel.locator('[data-back]').click();
 await fs.copyFile(path.join(output,'fixture.png'),path.join(output,'bad-00.png'));
 await page.locator(`[data-job="${errors.id}"]`).getByRole('button',{name:'失敗分を再試行'}).click();
 const retried=await until(async()=>{const j=await history(errors.id);return j.status==='done'&&j.succeeded===2&&j;});
 check('retry processes failures only and accepts repaired image',retried.succeeded===2&&retried.error_count===24&&(await fs.stat(path.join(output,'good.webp'))).mtimeMs===goodStamp);
 // A queued source changed after registration must not be silently converted.
 await panel.locator('[data-close]').click();
 const completedCount=(await json('/asset_hub/status')).total;
 const mutation=await json(`/asset_hub/jobs/${queued.id}/resume`,{});await done(mutation.id);
 const resumedQueue=await history(queued.id);
 check('resumed stale PNG entry safely skips an already converted file',resumedQueue.skipped===1&&(await json('/asset_hub/status')).total===completedCount);
 check('changed queued source is rejected and retained',resumedQueue.error_count===1&&resumedQueue.errors[0].error.includes('原本が変更')&&(await fs.readFile(path.join(output,'changed.png'))).subarray(-20).toString()==='changed while paused');
 await page.getByLabel('CPU目標').selectOption('70');await until(async()=>(await json('/asset_hub/status')).background);
 check('background mode can be re-enabled',true);
 await page.screenshot({path:path.join(out,'finished.png')});
 check('no browser exceptions',report.pageErrors.length===0);
 await fs.writeFile(path.join(root,'outputs/latest-resume-qa.json'),JSON.stringify(report,null,2));
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await browser?.close();await stop();await fs.writeFile(path.join(out,'server.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts:',out);}
