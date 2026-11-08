import {comfy, python, port, base} from './qa-config.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'outputs',`qa-relations-${Date.now()}`),output=path.join(out,'output');for(const dir of ['output','input','temp','user','models'])await fs.mkdir(path.join(out,dir),{recursive:true});
const fixture=spawnSync(python,['-c',`from pathlib import Path
from PIL import Image,ImageDraw,PngImagePlugin
import sys,json
p=Path(sys.argv[1])
def make(name,color,positive,shape='circle'):
 im=Image.new('RGB',(256,256),color);draw=ImageDraw.Draw(im)
 if shape=='circle':draw.ellipse((60,45,195,210),fill='#eeeeee')
 else:draw.rectangle((20,90,235,165),fill='#111111')
 graph={'1':{'class_type':'CLIPTextEncode','inputs':{'text':positive}},'2':{'class_type':'CLIPTextEncode','inputs':{'text':'blue ocean, low quality'}},'3':{'class_type':'KSampler','inputs':{'positive':['1',0],'negative':['2',0]}}}
 info=PngImagePlugin.PngInfo();info.add_text('prompt',json.dumps(graph));info.add_text('workflow','{"nodes":[],"links":[]}')
 im.save(p/name,pnginfo=info,compress_level=0)
make('zz-neighbor.png','#493ca4','red dress, portrait')
make('unrelated-000.png','#20b840','spaceship, galaxy','rectangle')
for i in range(1,201):(p/f'unrelated-{i:03}.png').hardlink_to(p/'unrelated-000.png')
make('semantic.png','#1022b8','red dress, portrait')
make('visual.png','#b82210','green valley, landscape')
make('reference.png','#b82210','red dress, portrait, masterpiece')
`,output],{windowsHide:true,encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
try{await fetch(base+'/system_stats');throw Error('検証ポートが使用中です。');}catch(e){if(e.message.startsWith('検証ポート'))throw e;}
const child=spawn(python,['main.py','--cpu','--listen','127.0.0.1','--port',String(port),'--disable-auto-launch','--disable-all-custom-nodes','--whitelist-custom-nodes','comfy-asset-hub','--output-directory',output,'--input-directory',path.join(out,'input'),'--temp-directory',path.join(out,'temp'),'--user-directory',path.join(out,'user'),'--models-directory',path.join(out,'models')],{cwd:comfy,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
let browser,page,log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
const report={out,checks:[],pageErrors:[]},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);console.log('PASS',label);};
async function until(predicate,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await sleep(150);}throw Error('timed out');}
async function json(url,body){const r=await fetch(base+'/asset_hub/'+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;}
const item=name=>({type:'output',subfolder:'',name});
const currentGraph=()=>page.evaluate(async()=>{const {app}=await import('/scripts/app.js');return JSON.stringify(app.graph.serialize());});
try{
 await until(async()=>{if(child.exitCode!==null)throw Error(log.slice(-7000));try{return(await fetch(base+'/asset_hub/status')).ok;}catch{return false;}},120000);
 await json('performance',{cpu_target:null,workers:2});const compressed=await json('prepare',{archive:true,items:[item('visual.png')]});await until(async()=>{const s=await json('status');return s.job.id===compressed.id&&s.job.status==='done';});
 const before=await fs.readFile(path.join(output,'reference.png')),stamp=(await fs.stat(path.join(output,'reference.png'))).mtimeMs;
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>report.pageErrors.push(e.message));
 await page.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 await page.goto(base,{waitUntil:'domcontentloaded'});await sleep(4000);await page.keyboard.press('Escape');
 await page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/}).click();await page.waitForSelector('.ib-card.is-file');
 check('related fixture is outside the visible gallery page',await page.locator('.ib-card.is-file[data-name="zz-neighbor.png"]').count()===0);
 await page.locator('.ib-card.is-file[data-name="reference.png"]').click({position:{x:40,y:40}});
 const editorBefore=await currentGraph();
 const start=page.waitForResponse(r=>r.url().endsWith('/asset_hub/relations/start'));
 await page.getByRole('button',{name:'関連図',exact:true}).click();const started=await(await start).json();
 const complete=await until(async()=>{const result=await json('relations/query',{id:started.id});return result.job.status==='done'&&result;});
 check('whole search scope beyond 200-image page is indexed',complete.job.total===205&&complete.job.indexed===205&&complete.job.error_count===0);
 check('reference is the selected seed and neighbor outside the visible page is found',complete.nodes[0].item.name==='reference.png'&&complete.nodes.some(n=>n.item.name==='zz-neighbor.png'));
 const panel=page.locator('.ah-relations');await until(async()=>(await panel.locator('.ah-relation-status').textContent()).includes('解析済み'));
 check('graph shows image nodes and evidence edges',await panel.locator('[data-node]').count()>=4&&await panel.locator('[data-edge]').count()>=3);
 await page.screenshot({path:path.join(out,'combined.png')});
 await panel.getByLabel('関連の基準').selectOption('prompt');
 await until(async()=>await panel.locator('[data-node][aria-label="semantic.png"]').count()===1&&await panel.locator('[data-node][aria-label="visual.webp"]').count()===0);
 await panel.locator('[data-node][aria-label="semantic.png"]').click();
 check('prompt link explains shared positive terms and excludes negative terms',(await panel.locator('.ah-relation-tags').innerText()).includes('red dress')&&!(await panel.locator('.ah-relation-tags').innerText()).includes('ocean'));
 await page.screenshot({path:path.join(out,'prompt.png')});
 await panel.getByLabel('関連の基準').selectOption('visual');
 await until(async()=>await panel.locator('[data-node][aria-label="visual.webp"]').count()===1&&await panel.locator('[data-node][aria-label="semantic.png"]').count()===0);
 await panel.locator('[data-node][aria-label="visual.webp"]').click();
 check('visual mode links managed WebP and explains color layout and contours',(await panel.locator('aside').innerText()).includes('色調')&&(await panel.locator('.ah-relation-tags').innerText()).includes('共通語句なし'));
 await page.screenshot({path:path.join(out,'visual.png')});
 const visualId=await panel.locator('[data-node][aria-label="visual.webp"]').getAttribute('data-node');
 const recenter=page.waitForResponse(r=>r.url().endsWith('/asset_hub/relations/query')&&r.request().postDataJSON()?.center===visualId);
 await panel.getByRole('button',{name:'この画像を中心に'}).click();const centered=await(await recenter).json();
 check('selected image becomes the new exploration center',centered.center===visualId&&centered.nodes[0].item.name==='visual.webp');
 await until(async()=>(await panel.locator('aside h3').textContent())==='visual.webp');
 const layer=panel.locator('svg > g'),oldTransform=await layer.getAttribute('transform');
 await panel.locator('svg').hover({position:{x:100,y:100}});await page.mouse.wheel(0,-300);await sleep(250);
 check('wheel zoom changes graph view',await layer.getAttribute('transform')!==oldTransform);
 await panel.getByRole('button',{name:'全体表示'}).click();
 const node=panel.locator('[data-node][aria-label="reference.png"]'),oldPosition=await node.getAttribute('transform'),box=await node.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+35,box.y+box.height/2+25,{steps:5});await page.mouse.up();
 check('nodes can be dragged without changing the editing workflow',await node.getAttribute('transform')!==oldPosition&&await currentGraph()===editorBefore);
 await panel.getByRole('button',{name:'一覧へ',exact:true}).click();
 check('analysis does not change source bytes or modification time',(await fs.readFile(path.join(output,'reference.png'))).equals(before)&&(await fs.stat(path.join(output,'reference.png'))).mtimeMs===stamp);
 const reopened=page.waitForResponse(r=>r.url().endsWith('/asset_hub/relations/start'));await page.getByRole('button',{name:'関連図',exact:true}).click();const reused=await(await reopened).json();
 const cached=await until(async()=>{const value=await json('relations/query',{id:reused.id});return value.job.status==='done'&&value;});
 check('reopening reuses all persisted image features',cached.job.cached===205);
 await page.setViewportSize({width:900,height:700});await sleep(300);
 const bounds=await panel.boundingBox();check('graph and controls fit a narrow viewport',bounds.x>=0&&bounds.width<=900&&bounds.y>=0&&bounds.height<=700);
 await panel.getByRole('button',{name:'一覧へ',exact:true}).click();await page.setViewportSize({width:1440,height:900});
 await page.locator('.ib-card.is-file[data-name="semantic.png"]').click({position:{x:40,y:40}});
 const selectedRequest=page.waitForResponse(r=>r.url().endsWith('/asset_hub/relations/start'));await page.getByRole('button',{name:'関連図',exact:true}).click();const selected=await(await selectedRequest).json();
 check('multiple selection restricts graph analysis to those images',selected.total===2);
 await panel.getByRole('button',{name:'一覧へ',exact:true}).click();
 await page.getByRole('button',{name:'解除',exact:true}).click();await page.locator('.ib-card.is-file[data-name^="unrelated-"]').first().click({position:{x:40,y:40}});
 await page.getByRole('button',{name:'関連図',exact:true}).click();await until(async()=>await panel.locator('[data-node]').count()===21);
 await page.screenshot({path:path.join(out,'neighborhood.png')});
 check('dense collection renders a bounded 21-node neighborhood',await panel.locator('[data-edge]').count()<=40);
 const boxes=await panel.locator('[data-node] > rect').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
 check('dense neighborhood thumbnails do not overlap',boxes.every((a,i)=>boxes.slice(i+1).every(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1)));
 const firstPage=await panel.locator('[data-node]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-node')));
 await panel.getByRole('button',{name:'次の20枚'}).click();await until(async()=>(await panel.locator('.ah-relation-status').textContent()).includes('21–40枚目'));
 const secondPage=await panel.locator('[data-node]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-node')));
 check('additional neighbors can be paged without losing the center',firstPage.filter(id=>secondPage.includes(id)).length===1);
 await panel.getByRole('button',{name:'一覧へ',exact:true}).click();
 const stale=await json('relations/start',{items:[item('visual.png')]});const resolved=await until(async()=>{const value=await json('relations/query',{id:stale.id});return value.job.status==='done'&&value;});
 check('stale PNG address resolves to managed WebP',resolved.nodes[0].item.name==='visual.webp'&&resolved.job.error_count===0);
 const tracking=await json('relations/start',{items:[item('reference.png'),item('semantic.png')]});await until(async()=>(await json('relations/query',{id:tracking.id})).job.status==='done');
 const moving=await json('prepare',{archive:true,items:[item('reference.png')]});const moved=await until(async()=>{const s=await json('status');return s.job.id===moving.id&&s.job.status==='done'&&s;});
 const tracked=await json('relations/query',{id:tracking.id});
 check('graph resolves current thumbnail name after compression',tracked.nodes[0].item.name==='reference.webp'&&!tracked.nodes[0].image_missing);
 const archived=moved.records.find(r=>r.item.name==='reference.png'&&r.state==='compacted');
 const restoring=await json('operate',{action:'restore',ids:[archived.id]});await until(async()=>{const s=await json('status');return s.job.id===restoring.id&&s.job.status==='done';});
 const trackedBack=await json('relations/query',{id:tracking.id});
 check('graph resolves current thumbnail name after restoration',trackedBack.nodes[0].item.name==='reference.png'&&!trackedBack.nodes[0].image_missing);
 const forbidden=await fetch(base+'/asset_hub/relations/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{type:'output',subfolder:'../../',name:'outside.png'}]})});check('unregistered traversal path is rejected',forbidden.status===400);
 check('no browser exceptions',report.pageErrors.length===0);
 await fs.writeFile(path.join(root,'outputs/latest-relations-qa.json'),JSON.stringify(report,null,2));
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-ui.txt'),await page.locator('body').innerText());}}
finally{await browser?.close();if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await fs.writeFile(path.join(out,'server.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts:',out);}
