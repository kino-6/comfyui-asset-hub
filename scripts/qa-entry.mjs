import {comfy, python, port, base} from './qa-config.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'outputs',`qa-entry-${Date.now()}`);for(const dir of ['output','input','temp','user','models'])await fs.mkdir(path.join(out,dir),{recursive:true});
const fixture=spawnSync(python,[path.join(root,'scripts/make-fixtures.py'),path.join(out,'output')],{windowsHide:true,encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
const sessionFolder=path.join(out,'input','session');await fs.mkdir(sessionFolder);
for(let i=0;i<430;i++)await fs.link(path.join(out,'output','qa-sample.png'),path.join(sessionFolder,`batch-${String(i).padStart(3,'0')}.png`));
try{await fetch(base+'/system_stats');throw Error('検証ポートが使用中です。');}catch(e){if(e.message.startsWith('検証ポート'))throw e;}
const child=spawn(python,['main.py','--cpu','--listen','127.0.0.1','--port',String(port),'--disable-auto-launch','--disable-all-custom-nodes','--whitelist-custom-nodes','comfy-asset-hub','--output-directory',path.join(out,'output'),'--input-directory',path.join(out,'input'),'--temp-directory',path.join(out,'temp'),'--user-directory',path.join(out,'user'),'--models-directory',path.join(out,'models')],{cwd:comfy,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
let browser,page,log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
const report={out,checks:[],pageErrors:[]},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);console.log('PASS',label);};
async function until(predicate,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(150);}throw Error('timed out');}
const graph=()=>page.evaluate(async()=>{const {app}=await import('/scripts/app.js');return JSON.stringify(app.graph.serialize());});
try{
 await until(async()=>{if(child.exitCode!==null)throw Error(log.slice(-6000));try{return(await fetch(base+'/asset_hub/status')).ok;}catch{return false;}},120000);
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 await page.goto(base,{waitUntil:'domcontentloaded'});await sleep(4000);await page.keyboard.press('Escape');
 await fs.writeFile(path.join(out,'sidebar.html'),await page.locator('.side-toolbar-container').innerHTML());
 const entry=page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/});
 check('sidebar has one visible direct entry',await entry.count()===1&&await entry.isVisible());
 const menuStyle=await page.evaluate(async()=>{
  const {app}=await import('/scripts/app.js');
  await app.loadGraphData({last_node_id:1,last_link_id:0,nodes:[{id:1,type:'EmptyLatentImage',pos:[320,220],size:[315,106],flags:{},order:0,mode:0,inputs:[],outputs:[{name:'LATENT',type:'LATENT',links:null}],properties:{},widgets_values:[640,512,1]}],links:[],groups:[],config:{},extra:{},version:0.4});
  return app.extensionManager.setting.get('Comfy.UseNewMenu');
 });
 const before=await graph();
 await page.screenshot({path:path.join(out,'entry.png')});
 await entry.click();await page.waitForSelector('.ib-card.is-file');
 check('single sidebar click opens the image library',await page.locator('.ib-card.is-file').count()===1);
 await page.screenshot({path:path.join(out,'opened.png')});
 await page.locator('.cmp-close').click();await page.waitForSelector('.ib-card.is-file',{state:'detached'});
 check('opening and closing preserves the editing workflow',await graph()===before);
 await entry.click();await page.waitForSelector('.ib-card.is-file');await page.locator('.cmp-close').click();
 check('entry can reopen the library without opening an empty sidebar',await page.evaluate(async()=>{const {app}=await import('/scripts/app.js');return app.extensionManager.sidebarTab.activeSidebarTabId!=='asset-hub';}));
 await page.evaluate(async()=>{const {app}=await import('/scripts/app.js');await app.extensionManager.setting.set('Comfy.UseNewMenu','Disabled');});
 await sleep(1000);const legacy=page.locator('[data-asset-hub-launcher]');
 check('legacy menu has a visible direct entry',await legacy.isVisible());
 const legacyBefore=await graph();
 await page.screenshot({path:path.join(out,'legacy.png')});
 await legacy.click();await page.waitForSelector('.ib-card.is-file');
 check('legacy menu also opens the library in one click',true);await page.locator('.cmp-close').click();
 check('legacy entry preserves the editing workflow',await graph()===legacyBefore);
 await page.evaluate(async value=>{const {app}=await import('/scripts/app.js');await app.extensionManager.setting.set('Comfy.UseNewMenu',value);},menuStyle);
 await until(()=>entry.isVisible());
 await page.setViewportSize({width:900,height:700});await sleep(500);
 check('sidebar entry remains visible at narrow width',await entry.isVisible());
 await page.setViewportSize({width:1440,height:900});
 await entry.click();await page.waitForSelector('.ib-card.is-file');
 await page.getByLabel('フォルダ',{exact:true}).selectOption('input');
 await page.locator('.ib-card.is-dir[data-name="session"]').click();
 await until(async()=>await page.locator('.ib-card.is-file').count()===200);
 await page.locator('select[title="Sort"]').selectOption('name:asc');
 await page.getByPlaceholder('フォルダ全体からファイル名を検索').fill('batch');
 await until(async()=>(await page.locator('.ah-pages').innerText()).includes('430'));
 await sleep(500);await page.locator('.ah-pages [data-next]').click();
 await until(async()=>(await page.locator('.ah-pages').innerText()).includes('2/3'));
 await page.locator('.ah-view-switch [data-density="list"]').click();
 await page.locator('.ib-card.is-file').nth(20).click({position:{x:100,y:30}});
 await page.locator('.ib-card.is-file').nth(23).click({position:{x:100,y:30},modifiers:['Shift']});
 await until(async()=>(await page.locator('.ah-count').innerText()).includes('選択 4件'));
 await page.locator('.ib-dialog .cmp-body').evaluate(el=>{el.scrollTop=2200;});await sleep(400);
 const snapshot=()=>page.evaluate(()=>({
  folder:document.querySelector('[aria-label="フォルダ"]').value,
  search:document.querySelector('.ib-dialog input[type="search"]').value,
  page:document.querySelector('.ah-pages').textContent,
  first:document.querySelector('.ib-card.is-file').dataset.name,
  selected:[...document.querySelectorAll('.ib-card.is-selected')].map(el=>el.dataset.name),
  density:document.querySelector('.ib-grid').dataset.density,
  sort:document.querySelector('select[title="Sort"]').value,
  scroll:document.querySelector('.ib-dialog .cmp-body').scrollTop,
 }));
 const saved=await snapshot(), editing=await graph();
 await page.screenshot({path:path.join(out,'session-before.png')});
 await page.locator('.cmp-close').click();await entry.click();
 await until(async()=>(await page.locator('.ah-pages').innerText()).includes('2/3'));
 await until(async()=>(await page.locator('.ah-count').innerText()).includes('選択 4件'));await sleep(700);
 const reopened=await snapshot();
 check('reopen restores root subfolder search page sort and density', ['folder','search','page','first','density','sort'].every(k=>saved[k]===reopened[k]));
 check('reopen preserves explicit selection',JSON.stringify(saved.selected)===JSON.stringify(reopened.selected));
 check('reopen restores scrolled position',saved.scroll>1000&&Math.abs(saved.scroll-reopened.scroll)<5);
 check('returning to library keeps the editing workflow intact',await graph()===editing);
 await page.screenshot({path:path.join(out,'session-after.png')});
 await page.locator('.ib-card.is-file').nth(25).click({position:{x:100,y:30},modifiers:['Shift']});
 await until(async()=>(await page.locator('.ah-count').innerText()).includes('選択 6件'));
 check('Shift selection continues from the restored anchor',true);
 await page.getByRole('button',{name:'全選択',exact:true}).click();
 await until(async()=>(await page.locator('.ah-count').innerText()).includes('選択 430件'));
 await page.locator('.cmp-close').click();await entry.click();
 await until(async()=>(await page.locator('.ah-count').innerText()).includes('選択 430件'));
 check('whole-search selection survives closing and reopening',true);
 await page.getByRole('button',{name:'解除',exact:true}).click();
 await page.locator('.ib-card.is-file').nth(3).locator('[data-action="workflow"]').click();
 await page.waitForSelector('.ib-dialog',{state:'detached'});await entry.click();
 await until(async()=>(await page.locator('.ah-pages').innerText()).includes('2/3'));
 check('loading a workflow then returning keeps the same library page',await page.getByLabel('フォルダ',{exact:true}).inputValue()==='input');
 await page.getByPlaceholder('フォルダ全体からファイル名を検索').fill('batch-02');
 await page.locator('.cmp-close').click();await entry.click();
 await until(async()=>await page.locator('.ib-card.is-file').count()===10);
 check('closing during debounced search restores the new query',await page.getByPlaceholder('フォルダ全体からファイル名を検索').inputValue()==='batch-02');
 await page.locator('.cmp-close').click();
 check('no browser exceptions',report.pageErrors.length===0);
 await fs.writeFile(path.join(root,'outputs/latest-entry-qa.json'),JSON.stringify(report,null,2));
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-ui.txt'),await page.locator('body').innerText());}}
finally{await browser?.close();if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await fs.writeFile(path.join(out,'server.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts:',out);}
