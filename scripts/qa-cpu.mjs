import {comfy, python, port, base} from './qa-config.mjs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'outputs',`qa-cpu-${Date.now()}`),output=path.join(out,'output');
const loadFile=path.join(out,'cpu-62');
for(const dir of ['output','input','temp','user','models'])await fs.mkdir(path.join(out,dir),{recursive:true});
const generated=spawnSync(python,['-c',`from pathlib import Path
from PIL import Image,PngImagePlugin
import sys
p=Path(sys.argv[1]);info=PngImagePlugin.PngInfo();info.add_text('workflow','{"nodes":[],"links":[]}')
im=Image.new('RGBA',(256,256));im.putdata([(x%256,y%256,(x+y)%256,0 if x%4==0 else 180) for y in range(256) for x in range(256)])
im.save(p/'item-000.png',pnginfo=info,compress_level=0)
for i in range(1,128):(p/f'item-{i:03}.png').hardlink_to(p/'item-000.png')`,output],{windowsHide:true,encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
try{await fetch(base+'/system_stats');throw Error('検証ポートが使用中です。');}catch(e){if(e.message.startsWith('検証ポート'))throw e;}
// Controlled telemetry and a delay keep concurrency observable without loading
// the user's CPU. The real native codec and storage operations still run.
const wrapper=`import sys,runpy,psutil,subprocess,time,threading,os
from pathlib import Path
from types import SimpleNamespace
psutil.cpu_percent=lambda *a,**kw:62.0 if Path(os.environ['ASSET_HUB_QA_LOAD']).exists() else 95.0
psutil.virtual_memory=lambda:SimpleNamespace(available=8*1024**3,total=16*1024**3,used=8*1024**3,percent=50)
original=subprocess.Popen
class Observable(original):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        if isinstance(self.args,list) and Path(self.args[0]).name=='cwebp.exe':
            try:print('QA_CODEC_PRIORITY',int(psutil.Process(self.pid).nice()),flush=True)
            except psutil.NoSuchProcess:pass
    def communicate(self,*args,**kwargs):
        result=super().communicate(*args,**kwargs)
        if isinstance(self.args,list) and Path(self.args[0]).name=='cwebp.exe':time.sleep(.8)
        return result
subprocess.Popen=Observable
# Simulate a continuously nonempty generation queue only in this QA process.
# No GPU workload is launched; this checks gating, not generation performance.
def generation_queue():
    while True:
        queue=getattr(sys.modules.get('execution'),'PromptQueue',None)
        if queue is not None:
            queue.get_tasks_remaining=lambda self:1
            return
        time.sleep(.05)
threading.Thread(target=generation_queue,daemon=True).start()
sys.argv[0]='main.py'
runpy.run_path('main.py',run_name='__main__')
`;
let child,browser,page,log='';const report={out,simulation:'CPU telemetry switches between 95% and 62%; generation queue reports one pending task throughout; native cwebp completion delayed 0.8s only in QA child. No GPU workload, not a performance benchmark.',checks:[],pageErrors:[]};
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);console.log('PASS',label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await sleep(100);}throw Error('timed out');}
async function json(url,body){const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;}
async function start(){
 child=spawn(python,['-c',wrapper,'--cpu','--listen','127.0.0.1','--port',String(port),'--disable-auto-launch','--disable-all-custom-nodes','--whitelist-custom-nodes','comfy-asset-hub','--output-directory',output,'--input-directory',path.join(out,'input'),'--temp-directory',path.join(out,'temp'),'--user-directory',path.join(out,'user'),'--models-directory',path.join(out,'models')],{cwd:comfy,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',ASSET_HUB_QA_LOAD:loadFile}});
 child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 await until(async()=>{if(child.exitCode!==null)throw Error(log.slice(-7000));try{return(await fetch(base+'/asset_hub/status')).ok;}catch{return false;}},120000);
}
async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}child=null;}
async function open(){await page.goto(base,{waitUntil:'domcontentloaded'});await sleep(3500);await page.keyboard.press('Escape');await page.locator('.side-toolbar-container').getByRole('button',{name:/素材庫/}).click();await page.waitForSelector('.ib-card.is-file');await until(()=>page.getByLabel('処理モード').isEnabled());}
async function select(label,value){await page.getByLabel(label,{exact:true}).selectOption(value);await until(()=>page.getByLabel(label,{exact:true}).isEnabled());}
try{
 await start();browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',e=>report.pageErrors.push(e.message));await page.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());await open();
 check('normal mode is the default without adding a panel',await page.getByLabel('処理モード').inputValue()==='normal'&&await page.locator('[data-background]').count()===0);
 await select('処理モード','30');await select('並列数','1');
 const items=Array.from({length:128},(_,i)=>({type:'output',subfolder:'',name:`item-${String(i).padStart(3,'0')}.png`}));
 const job=await json('/asset_hub/prepare',{archive:true,workers:1,items});
 const waiting=await until(async()=>{const s=await json('/asset_hub/status');return s.job?.id===job.id&&s.job.active_limit===0&&s.job.running.length===0&&s.job.cpu_percent===95&&s;});
 check('30 percent target stops new work under measured 95 percent CPU',waiting.job.done<128&&waiting.job.status==='running');
 await until(async()=>(await page.locator('[data-cpu-current]').textContent()).includes('95%'));
 check('current CPU is displayed beside the target',true);
 check('QA generation queue remains nonempty',(await json('/prompt')).exec_info.queue_remaining===1);
 await select('処理モード','70');await fs.writeFile(loadFile,'62');
 const concurrent=await until(async()=>{const s=await json('/asset_hub/status?progress=1');return s.job.cpu_percent===62&&s.job.succeeded>=waiting.job.succeeded+2&&s.job.background&&s;});
 check('70 percent target continues compression at 62 percent CPU with generation queued',concurrent.job.active_limit>0&&!concurrent.job.wait_reason&&(await json('/prompt')).exec_info.queue_remaining===1);
 await until(async()=>{const text=await page.locator('[data-progress]').textContent();return (await page.locator('[data-cpu-current]').textContent()).includes('62%')&&!text.includes('画像生成を優先');});
 await page.screenshot({path:path.join(out,'generation-concurrent.png')});
 await fs.unlink(loadFile);
 await until(async()=>{const s=await json('/asset_hub/status?progress=1');return s.job.cpu_percent===95&&s.job.active_limit===0&&s.job.running.length===0&&s.job.wait_reason.includes('CPU');});
 check('high CPU still stops new compression while generation stays queued',true);
 await select('並列数','16');
 const limited=await json('/asset_hub/status');check('worker limit changes in the existing job',limited.job.id===job.id&&limited.job.workers===16);
 const queued=await json('/asset_hub/prepare',{archive:true,workers:1,items:[items[0]]});
 await select('処理モード','normal');
 const full=await until(async()=>{const s=await json('/asset_hub/status');return s.job.id===job.id&&s.job.running.length===16&&s;});
 check('full speed admits all 16 workers despite high measured CPU',full.job.active_limit===16&&!full.job.background);
 check('normal codec processes use Windows normal priority',log.includes('QA_CODEC_PRIORITY 32'));
 check('queued job receives updated worker limit and mode',(await json('/asset_hub/jobs')).jobs.find(j=>j.id===queued.id)?.workers===16);
 await until(async()=>{const text=await page.locator('[data-progress]').textContent();return text.includes('16/16並列')&&!text.includes('CPUの空き');});
 check('full speed UI reflects 16 active workers and clears CPU wait',true);
 await until(async()=>await page.locator('.ah-work-item').count()>1&&/圧縮中 \d+%/.test(await page.locator('.ah-work').innerText()));
 check('real native codec progress reaches concurrent per-image rows',true);
 await page.screenshot({path:path.join(out,'full.png')});
 await select('処理モード','background');
 const osBackground=await until(async()=>{const s=await json('/asset_hub/status?progress=1');return s.job.mode==='background'&&s.job.cpu_percent===95&&s.job.active_limit===16&&s;});
 check('other-work mode keeps 16 slots open at 95 percent CPU',!osBackground.job.wait_reason&&osBackground.performance.mode==='background');
 await until(()=>log.includes('QA_CODEC_PRIORITY 16384'));
 check('other-work mode launches real codecs below normal priority',true);
 await page.screenshot({path:path.join(out,'other-work.png')});
 await select('並列数','2');
 await until(async()=>{const s=await json('/asset_hub/status');return s.job.workers===2&&s.job.running.length===2&&s.job.active_limit===2;});
 check('lowering live limit lets in-flight images finish then uses two workers',true);
 await select('処理モード','50');
 await until(async()=>{const s=await json('/asset_hub/status');return s.job.active_limit===0&&s.job.running.length===0&&s.job.cpu_target===50;});
 check('target mode can be re-enabled on the same job',true);
 await until(async()=>(await page.locator('[data-progress]').textContent()).includes('0/2並列'));
 await page.screenshot({path:path.join(out,'target.png')});
 for(const payload of [{cpu_target:0,workers:4},{cpu_target:100,workers:4},{cpu_target:70,workers:17},{cpu_target:true,workers:4}]){
  const response=await fetch(base+'/asset_hub/performance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(response.status,400);
 }
 check('invalid CPU targets and worker limits are rejected',true);
 await page.getByLabel('圧縮方法').selectOption('speed');
 await until(async()=>(await json('/asset_hub/status')).compression==='speed');
 await page.locator('[data-stop]').click();await until(async()=>(await json('/asset_hub/status')).job.status==='paused');
 await stop();await start();const recovered=await json('/asset_hub/status');
 check('target and worker settings survive ComfyUI restart',recovered.performance.mode==='cpu'&&recovered.performance.cpu_target===50&&recovered.performance.workers===2);
 await open();check('UI restores persisted target and limit',await page.getByLabel('処理モード').inputValue()==='50'&&await page.getByLabel('並列数').inputValue()==='2');
 check('compression choice survives restart',recovered.compression==='speed'&&await page.getByLabel('圧縮方法').inputValue()==='speed');
 await page.getByLabel('圧縮方法').selectOption('size');
 await until(async()=>(await json('/asset_hub/status')).compression==='size');
 await select('処理モード','normal');await select('並列数','16');await page.locator('[data-jobs]').click();
 await page.locator(`[data-job="${job.id}"]`).getByRole('button',{name:'再開',exact:true}).click();
 const finished=await until(async()=>{const s=await json('/asset_hub/status');return s.job.id===job.id&&s.job.status==='done'&&s;});
 check('resume completes all images after live tuning',finished.job.done===128&&finished.job.succeeded===128&&finished.job.error_count===0);
 const verified=spawnSync(python,['-c',`from PIL import Image\nfrom pathlib import Path\nimport sys\np=Path(sys.argv[1]);expected=bytes(v for y in range(256) for x in range(256) for v in (x%256,y%256,(x+y)%256,0 if x%4==0 else 180))\nfor f in p.glob('*.webp'):\n im=Image.open(f);assert im.convert('RGBA').tobytes()==expected;assert 'workflow:' in im.getexif()[271]\nassert len(list(p.glob('*.webp')))==128`,output],{windowsHide:true,encoding:'utf8'});
 check('all 128 real WebP outputs preserve RGBA and workflow metadata',verified.status===0);
 check('no browser exceptions',report.pageErrors.length===0);
 await fs.writeFile(path.join(root,'outputs/latest-cpu-qa.json'),JSON.stringify(report,null,2));
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-ui.txt'),await page.locator('body').innerText());}}
finally{await browser?.close();await stop();await fs.writeFile(path.join(out,'server.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Artifacts:',out);}
