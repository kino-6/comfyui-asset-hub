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
const paging=path.join(out,'output','paging');await fs.mkdir(paging);
const tiny=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
for(let i=0;i<201;i++)await fs.writeFile(path.join(paging,`page-${String(i).padStart(3,'0')}.png`),tiny);
const mixed=path.join(out,'output','mixed');await fs.mkdir(mixed);
const generated=spawnSync(python,['-c',"from PIL import Image\nfrom pathlib import Path\nimport sys\np=Path(sys.argv[1])\nfor i in range(100): Image.new('RGB',(64,64),(i,90,150)).save(p/('test-%03d.png'%i),compress_level=0)",mixed],{windowsHide:true,encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
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
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
 page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(url.hostname))return route.continue();return route.abort();});
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForTimeout(4000);
 await page.keyboard.press('Escape');await page.waitForTimeout(500);
 await fs.writeFile(path.join(out,'initial-ui.txt'),await page.locator('body').innerText());
 await page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/}).click({timeout:30000});
 await page.waitForSelector('.ib-card.is-file',{timeout:60000});
 const firstItems=Array.from({length:30},(_,i)=>({type:'output',subfolder:'mixed',name:`test-${String(i).padStart(3,'0')}.png`}));
 await json('/asset_hub/prepare',{items:firstItems,archive:true,workers:4});const first=await waitJob('archive');
 check('fixture contains 30 converted images',first.job.succeeded===30);
 const stamps=new Map();for(let i=0;i<30;i++){const name=`test-${String(i).padStart(3,'0')}.webp`;stamps.set(name,(await fs.stat(path.join(mixed,name))).mtimeMs);}
 await page.locator('.ib-card.is-dir[data-name="mixed"]').click();
 await page.getByRole('button',{name:'全選択',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 70件'&&document.querySelector('[data-restore]')?.textContent==='復元 30件');
 check('all selection separates 70 PNG and 30 converted targets',(await page.locator('.ah-toolbar [data-count]').textContent()).includes('選択 100件 · 変換済み 30件（圧縮対象外）'));
 await page.screenshot({path:path.join(out,'mixed-selection.png')});
 const search=page.getByPlaceholder('フォルダ全体からファイル名を検索');
 const filtered=page.waitForResponse(r=>r.url().endsWith('/asset_hub/list')&&r.request().postDataJSON()?.query==='.webp');await search.fill('.webp');await filtered;
 await page.getByRole('button',{name:'全選択',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 0件'&&document.querySelector('[data-restore]')?.textContent==='復元 30件');
 check('converted-only selection disables compression',await page.locator('[data-archive]').isDisabled());check('converted-only selection allows restore',await page.locator('.ah-toolbar [data-restore]').isEnabled());
 const unfiltered=page.waitForResponse(r=>r.url().endsWith('/asset_hub/list')&&r.request().postDataJSON()?.query==='');await search.fill('');await unfiltered;
 await page.getByRole('button',{name:'全選択',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 70件');
 const accepted=page.waitForResponse(r=>r.url().endsWith('/asset_hub/prepare')&&!!r.request().postDataJSON()?.plan);
 await page.locator('[data-archive]').click();await accepted;const finished=await waitJob('archive');
 check('execution total matches the shown 70 targets',finished.job.total===70&&finished.job.succeeded===70);
 for(const [name,stamp] of stamps)assert.equal((await fs.stat(path.join(mixed,name))).mtimeMs,stamp);
 check('30 existing WebPs were not rewritten',true);
 await page.getByRole('button',{name:'全選択',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 0件'&&document.querySelector('[data-restore]')?.textContent==='復元 100件');
 check('completed selection shows zero compression and 100 restore targets',await page.locator('[data-archive]').isDisabled());
 await json('/asset_hub/prepare',{items:[firstItems[0]],archive:true});const skipped=await waitJob('archive');check('stale queued PNG is skipped without re-encoding',skipped.job.skipped===1&&skipped.job.error_count===0);
 await page.getByRole('button',{name:'解除',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 0件');check('clearing selection disables both actions',await page.locator('[data-archive]').isDisabled()&&await page.locator('.ah-toolbar [data-restore]').isDisabled());
 await page.getByLabel('フォルダ',{exact:true}).selectOption('output');await page.locator('.ib-card.is-dir[data-name="paging"]').click();
 await page.getByRole('button',{name:'全選択',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 201件');
 await page.locator('.ah-pages [data-next]').click();await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 201件'&&document.querySelector('.ah-pages')?.textContent.includes('2/2'));
 check('global selection count persists across pages',true);
 await page.getByRole('button',{name:'解除',exact:true}).click();await page.locator('.ib-card.is-file').first().click({position:{x:60,y:60}});await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 1件');
 await page.locator('.ah-pages [data-prev]').click();await page.waitForFunction(()=>document.querySelector('[data-archive]')?.textContent==='圧縮 1件'&&document.querySelector('.ah-pages')?.textContent.includes('1/2'));
 check('individual selection count persists across pages',true);
 check('no browser exceptions',report.pageErrors.length===0);
 await fs.writeFile(path.join(root,'outputs/latest-selection-qa.json'),JSON.stringify(report,null,2));
}catch(e){report.failure=e.stack;console.error(e.stack);if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-ui.txt'),await page.locator('body').innerText());}process.exitCode=1;}
finally{await browser?.close();child.kill();await fs.writeFile(path.join(out,'server.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts:',out);}
