import {comfy, python, port, base} from './qa-config.mjs';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'outputs',`qa-${Date.now()}`);for(const dir of ['output','input','temp','user','models'])await fs.mkdir(path.join(out,dir),{recursive:true});
const sample='qa-sample.png';
const madeSample=spawnSync(python,[path.join(root,'scripts/make-fixtures.py'),path.join(out,'output')],{windowsHide:true,encoding:'utf8'});assert.equal(madeSample.status,0,madeSample.stderr);
try{await fetch(base+'/system_stats');throw Error('検証ポートが使用中です。既存プロセスには触れません。');}catch(e){if(e.message.startsWith('検証ポート'))throw e;}
const child=spawn(python,['main.py','--cpu','--listen','127.0.0.1','--port',String(port),'--disable-auto-launch','--disable-all-custom-nodes','--whitelist-custom-nodes','comfy-asset-hub','--output-directory',path.join(out,'output'),'--input-directory',path.join(out,'input'),'--temp-directory',path.join(out,'temp'),'--user-directory',path.join(out,'user'),'--models-directory',path.join(out,'models')],{cwd:comfy,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
let log='';child.stdout.on('data',x=>{log+=x;});child.stderr.on('data',x=>{log+=x;});
let browser,page;const report={out,checks:[],pageErrors:[]};
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);console.log('PASS',label);};
async function json(url,body){const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;}
async function waitJob(action='prepare'){let state;for(let i=0;i<240;i++){state=await json('/asset_hub/status');if(state.job?.action===action&&state.job.status!=='running')break;await new Promise(r=>setTimeout(r,500));}if(state.job?.action!==action||state.job.status==='running')throw Error('処理が完了しませんでした。');if(state.job.errors.length)throw Error(JSON.stringify(state.job.errors));await page.waitForTimeout(1400);return state;}
try{
 let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(log.slice(-7000));try{const s=await fetch(base+'/asset_hub/status');if(s.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,800));}if(!ready)throw Error('ComfyUIが起動しませんでした。'+log.slice(-7000));
 check('real isolated ComfyUI loads extension',true);
 const light=await json('/asset_hub/status?progress=1');
 check('progress endpoint omits history and disk-size scanning results','performance' in light&&'attention' in light&&!('records' in light)&&!('staged_bytes' in light));
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
 page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(url.hostname))return route.continue();return route.abort();});
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForTimeout(4000);
 await page.keyboard.press('Escape');await page.waitForTimeout(500);
 await fs.writeFile(path.join(out,'initial-ui.txt'),await page.locator('body').innerText());
 await page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/}).click({timeout:30000});
 await page.waitForSelector('.ib-card.is-file',{timeout:60000});check('synthetic image appears in reused browser',await page.locator('.ib-card.is-file').count()===1);
 check('compression selector defaults to size priority',await page.getByLabel('圧縮方法').inputValue()==='size'&&light.compression==='size');
 await page.locator('.ib-card.is-file').click({position:{x:60,y:60}});await page.locator('.ah-toolbar [data-archive]').click();
 const state=await waitJob('archive'),r=state.records[0];report.record=r;
 check('Windows archive uses bundled native cwebp backend',r.encoding?.backend==='cwebp-1.6.0-windows-x64');
 check('new archives use size priority m1/q50 with lossless and exact enabled',r.encoding?.method===1&&r.encoding?.quality===50&&r.encoding?.lossless===true&&r.encoding?.exact===true);
 check('archive replaces verified PNG without confirmation',r.state==='compacted'&&await fs.access(path.join(out,'output',sample)).then(()=>false,()=>true));
 check('lossless archive is smaller',r.webp_bytes<r.original_bytes);
 await page.getByRole('button',{name:'履歴',exact:true}).click();await page.locator('.ah-record').first().waitFor();
 const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'PNGで取り出す',exact:true}).click();const download=await downloadEvent;await download.saveAs(path.join(out,'restored-download.png'));
 await page.locator('.ah-panel [data-close]').click();await page.waitForSelector('.ib-card.is-file');
 await page.locator('.ib-card.is-file [data-action=workflow]').click();await page.waitForTimeout(2000);
 report.graph=await page.evaluate(async()=>{const {app}=await import('/scripts/app.js');return {nodes:app.graph._nodes.length,types:app.graph._nodes.map(n=>n.type)};});
 check('archived WebP opens native workflow graph',report.graph.nodes===1&&report.graph.types[0]==='EmptyLatentImage');
 await page.screenshot({path:path.join(out,'workflow.png')});
 await page.keyboard.press('Escape');await page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/}).click();
 await page.waitForFunction(()=>document.querySelector('.ib-card.is-file [data-asset-action]')?.textContent==='PNGに戻す');
 await page.locator('.ib-card.is-file [data-asset-action]').click();await waitJob('restore');
 check('restore works directly from gallery without history',await page.locator('.ah-panel').count()===0);
 await page.getByLabel('圧縮方法').selectOption('speed');
 await page.waitForFunction(()=>!document.querySelector('[data-compression]').disabled);
 check('speed priority is saved through the UI',(await json('/asset_hub/status')).compression==='speed');
 await page.getByLabel('並列数').selectOption('8');
 await page.waitForFunction(()=>document.querySelector('.ib-card.is-file [data-asset-action]')?.textContent==='圧縮');
 await page.locator('.ib-card.is-file [data-asset-action]').click();const again=await waitJob('archive');check('UI concurrency setting reaches worker job',again.job.workers===8);
 check('next archive uses selected speed profile',again.records[0].encoding.quality===20);
 await page.getByLabel('圧縮方法').selectOption('size');
 await page.waitForFunction(()=>!document.querySelector('[data-compression]').disabled);
 check('size priority can be restored',(await json('/asset_hub/status')).compression==='size');
 await page.getByRole('button',{name:'全選択',exact:true}).click();await page.locator('.ah-toolbar [data-restore]').click();await waitJob('restore');
 check('gallery select all restores matching managed files',true);
 check('restore recreates PNG and removes managed WebP',await fs.stat(path.join(out,'output',sample)).then(()=>true)&&await fs.access(path.join(out,'output',r.target_name)).then(()=>false,()=>true));
 const verifyCode="from PIL import Image\nimport sys,json\na=Image.open(sys.argv[1]);b=Image.open(sys.argv[2])\nassert a.tobytes()==b.tobytes()\nassert json.loads(a.info['workflow'])==json.loads(b.info['workflow'])\nassert json.loads(a.info['prompt'])==json.loads(b.info['prompt'])";
 const verified=spawnSync(python,['-c',verifyCode,path.join(out,'output',sample),path.join(out,'restored-download.png')],{windowsHide:true,encoding:'utf8'});check('download and restored pixels plus metadata agree',verified.status===0);
 await json('/asset_hub/prepare',{items:[{type:'output',subfolder:'../input',name:'outside.png'}]});await page.waitForTimeout(1000);check('path traversal is rejected',(await json('/asset_hub/status')).job.error_count===1);
 // Controlled UI telemetry only: exercise a long-lived job with a recent rate
 // of one success/second and deliberately slow status replies. No speed claim.
 const snapshot=await json('/asset_hub/status');let activePolls=0,maxPolls=0,lightPolls=0,legacyBackend=false;
 const rateStart=performance.now();
 await page.route('**/asset_hub/status*',async route=>{
  activePolls++;maxPolls=Math.max(maxPolls,activePolls);
  const isLight=new URL(route.request().url()).searchParams.get('progress')==='1';if(isLight)lightPolls++;
  const done=26000+Math.floor((performance.now()-rateStart)/1000);
  const progress=Array.from({length:8},(_,i)=>({slot:i+1,name:`progress-image-${i+1}.png`,phase:i===0?'照合中':'圧縮中',percent:i===0?null:i*10,elapsed_s:i+2}));
  const state={...snapshot,job:{...snapshot.job,id:'qa-rate',started:1,status:'running',action:'archive',done,succeeded:done,total:36786,elapsed_s:58000,running:progress.map(p=>({name:p.name})),workers:8,wait_reason:'',stopping:false,cpu_percent:52,progress}};
  if(legacyBackend)delete state.compression;
  if(isLight){delete state.records;delete state.total;delete state.staged_bytes;}
  await new Promise(r=>setTimeout(r,800));
  try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(state)});}finally{activePolls--;}
 });
 await page.waitForFunction(()=>document.querySelector('[data-progress]')?.textContent.includes('速度計測中'));
 // A control change requests another poll while the preceding request is live.
 for(let i=0;i<60&&!activePolls;i++)await page.waitForTimeout(50);
 await page.getByLabel('処理モード',{exact:true}).selectOption('50');
 await page.waitForFunction(()=>/直近 (0\.[89]|1\.[012])枚\/秒/.test(document.querySelector('[data-progress]')?.textContent||''),{},{timeout:20000});
 check('long-running job displays recent throughput instead of historical 0.4/s',true);
 check('slow progress requests remain single-flight and use lightweight endpoint',maxPolls===1&&lightPolls>=3);
 check('CPU usage and overall progress have distinct labels',(await page.locator('[data-cpu-current]').textContent())==='CPU使用率 52%'&&await page.getByRole('progressbar',{name:'全体の処理進捗',exact:true}).count()===1);
 check('each active image shows filename, phase, codec percentage and elapsed time',await page.locator('.ah-work-item').count()===8&&(await page.locator('.ah-work-item').last().innerText()).includes('圧縮中 70%')&&(await page.locator('.ah-work-item').first().innerText()).includes('照合中'));
 check('verification phase has no fabricated percentage',await page.locator('.ah-work-item').first().locator('progress').getAttribute('value')===null);
 await page.screenshot({path:path.join(out,'recent-throughput.png')});
 await page.locator('.ah-work summary').click();await page.waitForTimeout(2000);
 check('image progress stays collapsed across polling',await page.locator('.ah-work').getAttribute('open')===null);
 legacyBackend=true;
 await page.waitForFunction(()=>document.querySelector('[data-compression]').value==='unavailable');
 check('old running backend does not falsely display size priority',await page.getByLabel('圧縮方法').isDisabled());
 legacyBackend=false;
 await page.waitForFunction(()=>document.querySelector('[data-compression]').value==='size'&&!document.querySelector('[data-compression]').disabled);
 check('selector enables when the new backend is available',true);
 check('no browser exceptions',report.pageErrors.length===0);
 await fs.writeFile(path.join(root,'outputs/latest-qa.json'),JSON.stringify(report,null,2));
}catch(e){report.failure=e.stack;console.error(e.stack);if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-ui.txt'),await page.locator('body').innerText());}process.exitCode=1;}
finally{await browser?.close();child.kill();await fs.writeFile(path.join(out,'server.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts:',out);}
