import {app} from '/scripts/app.js';
import {openShellOverlay, safeViewSettings} from '@laurigates/comfy-modal-kit';
import {SANDBOXED_TYPES, imageThumbURL} from '../vendor/image-browser/src/api';
import {openImageBrowser} from '../vendor/image-browser/src/browser';
import {openRelations} from './relations';
import {RecentRate, actionLabels as actions} from './progress';
import {ProgressPanel} from './progress-panel';
import {ensureHubStyles} from './hub-styles';

const mb=(n:number)=>n<1e6?(n/1000).toFixed(1)+' KB':(n/1e6).toFixed(1)+' MB';
const esc=(s:any)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
async function api(tail:string,body?:any){
 const response=await fetch('/asset_hub/'+tail,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);return result;
}
const labels:Record<string,string>={prepared:'候補',placing:'置き換え途中',compacted:'WebP',restoring:'PNGへ復元途中',restored:'PNG',discarded:'破棄',not_smaller:'削減なし・原本保持'};

let activeHub:any = null;
let openingHub:Promise<any>|null = null;
let rememberedAllScope:any = null;

export function openHub(){
 if(activeHub?.dialog.isConnected)return Promise.resolve(activeHub);
 if(openingHub)return openingHub;
 openingHub=createHub().then(modal=>{activeHub=modal;return modal;}).finally(()=>{openingHub=null;});
 return openingHub;
}

async function createHub(){
 const folders=(await api('folders')).roots;
 for(const root of folders)if(!SANDBOXED_TYPES.includes(root.type))SANDBOXED_TYPES.push(root.type);
 const rootLabel=(type:string)=>folders.find((r:any)=>r.type===type)?.path.split(/[\\/]/).filter(Boolean).pop()||({output:'Output',input:'Input',temp:'Temp'} as any)[type]||type;
 let noticeEl:HTMLElement|undefined;
 let cardAction:(action:string,file:any)=>void=()=>{};
 const assets=new Map<string,any>();
 const decorateCard=(card:HTMLElement,file:any)=>{
  let box=card.querySelector('.ah-asset') as HTMLElement;
  if(!box){box=document.createElement('div');box.className='ah-asset';card.querySelector('.ib-actions')?.before(box);}
  const r=file.asset;if(r)assets.set(r.id,r);
  const noSaving=r?.state==='not_smaller'&&r.no_saving_current;
  box.textContent=r?.state==='compacted'?`WebP · −${mb(r.saving_bytes)} (${Math.round(100*r.saving_bytes/r.original_bytes)}%)`:r?.state==='prepared'?'圧縮候補':r?.state==='restored'?'PNG · 復元済み':`${(file.ext||'').slice(1).toUpperCase()} · ${mb(file.size||0)}`;
  if(r){const sizes=document.createElement('small');sizes.textContent=mb(r.original_bytes)+' → '+mb(r.webp_bytes);box.append(sizes);}
  if(r?.state==='not_smaller')box.textContent=noSaving?'PNG · 削減なし（原本保持）':'PNG · 再評価対象';
  box.dataset.state=r?.state||'';
  box.title=r?`${mb(r.original_bytes)} → ${mb(r.webp_bytes)} · ${r.workflow_nodes}ノード`:file.name;
  let button=card.querySelector('[data-asset-action]') as HTMLButtonElement;
  if(!button){button=document.createElement('button');button.className='ib-act ah-card-primary';button.dataset.assetAction='';card.querySelector('.ib-actions')?.append(button);}
  const action=r?.state==='compacted'?'restore':r?.state==='prepared'||r?.state==='placing'?'commit':file.ext?.toLowerCase()==='.png'?'archive':'';
  button.hidden=!action;button.textContent=action==='restore'?'PNGに戻す':action==='commit'?'保管':'圧縮';
  button.disabled=Boolean(noSaving);if(noSaving)button.textContent='削減なし';
  button.onclick=e=>{e.stopPropagation();cardAction(action,{...file,asset:r});};
 };

 const notice=(value:any)=>{if(noticeEl)noticeEl.textContent=typeof value==='string'?value:value.message||value.detail||value.summary||String(value);};
 ensureHubStyles();
 let disposeHub=()=>{};
 return openImageBrowser({resumeKey:'asset-hub',onClose:()=>disposeHub(),title:'素材庫',compact:true,decorateCard,onNotice:notice,rootLabel,listing:params=>api('list',params),mount({modal,selection,refresh,selectAll,clearSelection,navigate,query,pageItems,updateAssets}){
  modal.dialog.classList.add('ah-compact-ui');
  modal.searchEl.placeholder='フォルダ全体からファイル名を検索';
  modal.footerEl.textContent='クリックで選択 · Shift＋クリックで範囲選択 · Wでグラフ';
  let concurrency=4, performanceRevision=0, savingPerformance=false;
  let compressionRevision=0, savingCompression=false;
  let allScope:any=rememberedAllScope, listing:any=null, selectedCount=0, panel:any=null;
  let selectionPlan:any=null, selectionRevision=0, selectionTimer:ReturnType<typeof setTimeout>;
  let historyOffset=0, historyState='', historyAll=false, historyTotal=0, historyAnchor=-1;
  const historySelected=new Set<string>(), historyStates=new Map<string,string>(), rowCache=new Map<string,any>();
  let galleryDirty=false;
  let historyRows:any[]=[], pollTimer:ReturnType<typeof setTimeout>, lastJob='', panelPage='';
  let firstStatus=true;
  let polling=false, pollRequested=false, statusRevision=0;
  const recentRate=new RecentRate();
  disposeHub=()=>{rememberedAllScope=allScope?{...allScope}:null;clearTimeout(pollTimer);clearTimeout(selectionTimer);selectionRevision++;};
  const status=(progressOnly=false)=>api(progressOnly?'status?progress=1':`status?offset=${historyOffset}&state=${encodeURIComponent(historyState)}`);
  const bar=document.createElement('div');bar.className='ah-toolbar';
  bar.innerHTML='<select aria-label="フォルダ"><option value="output">Output</option><option value="input">Input</option><option value="temp">Temp</option></select><button data-folder>フォルダ追加</button><button data-all>全選択</button><button data-clear>解除</button><span data-count class="ah-count"></span><button data-archive class="ah-primary" title="可逆圧縮し、照合後にPNGをWebPへ置き換えます">圧縮 0件</button><button data-restore>復元 0件</button><select data-compression aria-label="圧縮方法" title="どちらも可逆圧縮。変更は次に処理を開始する画像から反映し、再起動後も保持します。サイズ優先でも、画像によって大小が逆転する場合があります。"><option value="size">サイズ優先</option><option value="speed">速度優先</option></select><select data-workers aria-label="並列数"><option value="1">1並列</option><option value="2">2並列</option><option value="4">4並列</option><option value="8">8並列</option><option value="16">16並列</option></select><button data-history>履歴</button>';
  const relationButton=document.createElement('button');relationButton.className='ib-density-seg';relationButton.textContent='関連図';relationButton.disabled=true;
  relationButton.title='画像同士を共通プロンプトや見た目でつなぐ。複数選択時は選択画像、未選択・1枚選択時は検索結果全体から探します。';
  modal.dialog.querySelector('.ah-view-switch')!.append(relationButton);
  relationButton.onclick=()=>{const chosen=selection(),scope=query();const items=chosen.length>1&&!allScope?chosen:scope?.safeHide?pageItems():null;void openRelations(modal,items?{items,center:chosen[0]||items[0]}:{all:{...scope},center:chosen[0]||pageItems()[0]},api);};
  modal.toolbarEl.prepend(bar);
  const progressView=new ProgressPanel(modal.toolbarEl,{
   pause:()=>void api('cancel',{}).then(()=>{notice('');schedulePoll();}).catch(notice),
   resume:id=>void api(`jobs/${id}/resume`,{}).then(job=>{lastJob='';showSubmitted(job);schedulePoll();}).catch(notice),
   history:()=>void openJobs(),
  });
  noticeEl=progressView.noticeElement;
  const workerSelect=bar.querySelector('[data-workers]') as HTMLSelectElement;workerSelect.value=String(concurrency);
  workerSelect.title='同時処理数の上限。変更は実行中と待ち行列にも反映します。減らした場合、処理中の画像は完了させます。';
  const cpuSelect=progressView.cpuSelect;
  const compressionSelect=bar.querySelector('[data-compression]') as HTMLSelectElement;
  compressionSelect.disabled=true;
  compressionSelect.onchange=async()=>{
   compressionRevision++;savingCompression=true;compressionSelect.disabled=true;
   try{
    await api('compression',{compression:compressionSelect.value});
    notice('');updateCount();await refreshAssets();
   }catch(e){notice(e);}
   finally{savingCompression=false;schedulePoll();}
  };
  workerSelect.disabled=cpuSelect.disabled=true;
  const savePerformance=async()=>{
   performanceRevision++;savingPerformance=true;concurrency=Number(workerSelect.value);workerSelect.disabled=cpuSelect.disabled=true;
   try{const value=await api('performance',{cpu_target:cpuSelect.value==='full'?null:Number(cpuSelect.value),workers:Number(workerSelect.value)});concurrency=value.workers;notice('');}
   catch(e){notice(e);}
   finally{savingPerformance=false;schedulePoll();}
  };
  workerSelect.onchange=cpuSelect.onchange=()=>void savePerformance();
  async function refreshAssets(){const items=pageItems();if(items.length){const data=await api('records',{items});updateAssets(data.records);}}
  cardAction=async(action,file)=>{try{
   const job=action==='archive'?await api('prepare',{items:[{type:file.type,subfolder:file.subfolder,name:file.name}],archive:true,workers:concurrency}):await api('operate',{action,ids:[file.asset.id],workers:concurrency});
   showSubmitted(job);schedulePoll();
  }catch(e){notice(e);}};
  bar.querySelector('[data-restore]')!.addEventListener('click',async()=>{try{
   if(!selectionPlan?.restore)return;
   const plan=selectionPlan.plan;selectionPlan=null;setActionCounts(0,0);
   const job=await api('operate',{action:'restore',plan,workers:concurrency});
   allScope=null;clearSelection();updateCount();showSubmitted(job);schedulePoll();
  }catch(e){notice(e);}});
  const rootSelect=bar.querySelector('select[aria-label="フォルダ"]')!;

  const addRoot=(root:any)=>{const option=document.createElement('option');option.value=root.type;option.textContent=root.path;rootSelect.append(option);};folders.forEach(addRoot);
  const countEl=bar.querySelector('[data-count]')!;
  function setActionCounts(archive:number,restore:number,pending=false){
   const compress=bar.querySelector('[data-archive]') as HTMLButtonElement, expand=bar.querySelector('[data-restore]') as HTMLButtonElement;
   compress.textContent=pending?'圧縮 …':`圧縮 ${archive}件`;expand.textContent=pending?'復元 …':`復元 ${restore}件`;
   compress.disabled=pending||archive===0;expand.disabled=pending||restore===0;
   compress.title='選択中のPNGだけを圧縮します。変換済みWebPは対象外です。';expand.title='選択中の管理下WebPだけをPNGに戻します。';
  }
  function updateCount(){
   const revision=++selectionRevision;clearTimeout(selectionTimer);selectionPlan=null;
   if(!allScope&&!selectedCount){countEl.textContent='';setActionCounts(0,0);return;}
   const body=allScope?{all:{...allScope}}:{items:selection()};
   countEl.textContent=`選択 ${allScope?listing?.file_count||0:selectedCount}件 · 対象を集計中`;setActionCounts(0,0,true);
   selectionTimer=setTimeout(async()=>{try{
    const result=await api('selection',body);if(revision!==selectionRevision||!modal.dialog.isConnected)return;
    selectionPlan=result;
    countEl.textContent=`選択 ${result.selected}件${result.converted?' · 変換済み '+result.converted+'件（圧縮対象外）':''}${result.unchanged?' · 削減なし '+result.unchanged+'件（圧縮対象外）':''}${result.other?' · その他 '+result.other+'件':''}`;
    setActionCounts(result.archive,result.restore);
   }catch(e){if(revision===selectionRevision){setActionCounts(0,0);countEl.textContent='対象を取得できませんでした';notice(e);}}},120);
  }
  updateCount();
  rootSelect.onchange=()=>{allScope=null;void navigate(rootSelect.value as any);};
  bar.querySelector('[data-folder]')!.addEventListener('click',()=>{
   const overlay=openShellOverlay(modal);overlay.card.classList.add('ah-panel');
   overlay.card.innerHTML='<h2>フォルダ追加</h2><input data-path aria-label="フォルダのパス" placeholder="画像フォルダの絶対パス"><div class="ah-controls"><button data-save>開く</button><button data-close>閉じる</button><span class="ah-notice"></span></div>';
   overlay.card.querySelector('[data-close]').onclick=()=>overlay.close();
   const input=overlay.card.querySelector('[data-path]');input.focus();
   const submit=async()=>{try{const root=await api('folders',{path:input.value});if(!folders.some((r:any)=>r.type===root.type)){folders.push(root);SANDBOXED_TYPES.push(root.type);addRoot(root);}rootSelect.value=root.type;overlay.close();await navigate(root.type);}catch(e:any){overlay.card.querySelector('.ah-notice').textContent=e.message;}};
   overlay.card.querySelector('[data-save]').onclick=submit;input.onkeydown=(e:KeyboardEvent)=>{if(e.key==='Enter')void submit();};
  });
  (bar.querySelector('[data-all]') as HTMLButtonElement).disabled=true;
  modal.dialog.addEventListener('hub-loading',((e:CustomEvent)=>{relationButton.disabled=true;if(!e.detail.preserve){allScope=null;listing=null;clearSelection();updateCount();}(bar.querySelector('[data-all]') as HTMLButtonElement).disabled=true;}) as EventListener);
  bar.querySelector('[data-all]')!.addEventListener('click',()=>{
   clearSelection();selectAll();
   if(listing?.token&&!query()?.safeHide){allScope={...query()};}else allScope=null;
   updateCount();
  });
  bar.querySelector('[data-clear]')!.addEventListener('click',()=>{allScope=null;clearSelection();updateCount();});
  modal.dialog.addEventListener('hub-selection',((e:CustomEvent)=>{selectedCount=e.detail.count;updateCount();}) as EventListener);
  modal.dialog.addEventListener('hub-user-selection',()=>{allScope=null;updateCount();});
  modal.dialog.addEventListener('hub-list',((e:CustomEvent)=>{
   listing=e.detail;
   relationButton.disabled=!listing.file_count;
   (bar.querySelector('[data-all]') as HTMLButtonElement).disabled=!listing.file_count;
   if(allScope){const {token:oldToken,...previous}=allScope,{token:newToken,...next}=listing.query;allScope=JSON.stringify(previous)===JSON.stringify(next)?{...listing.query}:null;}
   if(allScope)setTimeout(selectAll,0);
   rootSelect.value=listing.query.type;updateCount();setTimeout(()=>void refreshAssets().catch(notice),0);
   bar.querySelector('[data-all]')!.setAttribute('title',listing.query.safeHide?'このページの表示画像を全選択':'ページ外も含め検索結果の画像を全選択');
  }) as EventListener);
  bar.querySelector('[data-archive]')!.addEventListener('click',async()=>{
   try{
    if(!selectionPlan?.archive)return;
    const plan=selectionPlan.plan;selectionPlan=null;setActionCounts(0,0);
    const job=await api('prepare',{plan,archive:true,workers:concurrency});
    allScope=null;clearSelection();updateCount();notice('');showSubmitted(job);schedulePoll();
   }catch(e){notice(e);}
  });
  bar.querySelector('[data-history]')!.addEventListener('click',()=>void openHistory());
  function showSubmitted(job:any){progressView.showSubmitted(job);}
  function schedulePoll(){statusRevision++;clearTimeout(pollTimer);if(polling){pollRequested=true;return;}pollTimer=setTimeout(poll,100);}
  async function poll(){
   if(!modal.dialog.isConnected)return;
   if(polling){pollRequested=true;return;}
   polling=true;let delay=3000;
   try{
    const revision=performanceRevision, codecRevision=compressionRevision, requestRevision=statusRevision, historyKey=historyState+':'+historyOffset;
    const state=await status(!panel), job=state.job, running=job?.status==='running';
    if(!modal.dialog.isConnected||requestRevision!==statusRevision)return;
    const rate=recentRate.sample(job,performance.now());delay=running?1000:3000;
    if(codecRevision===compressionRevision&&!savingCompression){
     const available=['size','speed'].includes(state.compression);
     if(!available&&!compressionSelect.querySelector('[value="unavailable"]'))compressionSelect.add(new Option('再起動で有効','unavailable'));
     if(available)compressionSelect.querySelector('[value="unavailable"]')?.remove();
     compressionSelect.value=available?state.compression:'unavailable';compressionSelect.disabled=!available;
    }
    if(firstStatus){lastJob=job?.id||'';firstStatus=false;}
    if(revision===performanceRevision&&!savingPerformance){
     const target=state.performance.cpu_target===null?'full':String(state.performance.cpu_target);
     concurrency=running?job.workers:state.performance.workers;
     if(!Array.from(cpuSelect.options).some(o=>o.value===target))cpuSelect.add(new Option(`CPU目標 ${target}%`,target));
     if(!Array.from(workerSelect.options).some(o=>o.value===String(concurrency)))workerSelect.add(new Option(`${concurrency}並列`,String(concurrency)));
     cpuSelect.value=target;workerSelect.value=String(concurrency);workerSelect.disabled=cpuSelect.disabled=false;
    }
    if(running||galleryDirty||(job&&lastJob!==job.id))await refreshAssets();
    if(!modal.dialog.isConnected||requestRevision!==statusRevision)return;
    const progressText=progressView.render(state,rate);
    for(const card of modal.dialog.querySelectorAll('.ib-card.is-file')){
     const name=(card as HTMLElement).dataset.name;
     card.classList.toggle('ah-processing',running&&(job.running||[]).some((item:any)=>typeof item==='object'?item.name===name:[assets.get(item)?.item.name,assets.get(item)?.target_name].includes(name)));
    }

    if(job){
     if(panel)panel.card.querySelector('[data-job]').textContent=progressText;
     if(!running&&lastJob!==job.id){lastJob=job.id;if(allScope||selectedCount)updateCount();galleryDirty=true;if(!panel&&!selectedCount&&!allScope){galleryDirty=false;void refresh().catch(notice);}}
    }
    if(panel&&state.records&&historyKey===historyState+':'+historyOffset)renderHistory(state);
   }catch(e){notice(e);}
   finally{polling=false;if(modal.dialog.isConnected){clearTimeout(pollTimer);pollTimer=setTimeout(poll,pollRequested?100:delay);}pollRequested=false;}
  }
  async function openJobs(){
   const overlay=openShellOverlay(modal);overlay.card.classList.add('ah-panel');
   let offset=0,errorKey='',errorOffset=0;
   overlay.card.innerHTML='<div class="ah-head"><h2>処理履歴</h2><button data-close>閉じる</button></div><div class="ah-records" data-tasks></div><div class="ah-controls"><button data-back hidden>一覧へ</button><button data-prev>前へ</button><span data-page></span><button data-next>次へ</button><button data-refresh>更新</button></div><span class="ah-notice" role="status"></span>';
   const card=overlay.card,rows=card.querySelector('[data-tasks]');
   card.querySelector('[data-close]').onclick=()=>overlay.close();
   const fail=(e:any)=>{card.querySelector('.ah-notice').textContent=e.message||String(e);};
   const load=async()=>{try{
    const data=errorKey?await api(`jobs/${errorKey}/errors?offset=${errorOffset}`):await api(`jobs?offset=${offset}`);
    if(!card.isConnected)return;rows.replaceChildren();
    card.querySelector('[data-back]').hidden=!errorKey;
    const position=errorKey?errorOffset:offset,size=errorKey?100:20;
    card.querySelector('[data-page]').textContent=`${data.total}件 · ${data.total?Math.floor(position/size)+1:0}/${Math.ceil(data.total/size)}`;
    card.querySelector('[data-prev]').disabled=position===0;card.querySelector('[data-next]').disabled=position+size>=data.total;
    if(errorKey){for(const error of data.errors){const row=document.createElement('div');row.className='ah-task';row.textContent=`${error.name} · ${error.error}`;rows.append(row);}return;}
    for(const job of data.jobs){
     const row=document.createElement('div');row.className='ah-task';row.dataset.job=job.id;
     const text=document.createElement('span');text.textContent=`${new Date(job.created*1000).toLocaleString('ja-JP')} · ${actions[job.action]} · ${job.done}/${job.total}件 · ${{running:'処理中',queued:'待機',paused:'一時停止',done:'完了',error:'停止'}[job.status]||job.status}${job.error_count?' · 失敗 '+job.error_count+'件':''}${job.name?' · '+job.name+(job.total>1?' ほか':''):''}`;row.append(text);
     const button=(label:string,handler:()=>Promise<void>)=>{const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await handler();}catch(e){fail(e);b.disabled=false;}};row.append(b);};
     if(!['running','queued'].includes(job.status)){
      if(job.remaining)button('再開',async()=>{await api(`jobs/${job.id}/resume`,{});lastJob='';schedulePoll();await load();});
      else if(job.error_count)button('失敗分を再試行',async()=>{await api(`jobs/${job.id}/resume`,{retry:true});lastJob='';schedulePoll();await load();});
     }
     if(job.error_count)button('失敗の詳細',async()=>{errorKey=job.id;errorOffset=0;await load();});
     rows.append(row);
    }
   }catch(e){fail(e);}};
   card.querySelector('[data-back]').onclick=()=>{errorKey='';void load();};
   card.querySelector('[data-prev]').onclick=()=>{if(errorKey)errorOffset=Math.max(0,errorOffset-100);else offset=Math.max(0,offset-20);void load();};
   card.querySelector('[data-next]').onclick=()=>{if(errorKey)errorOffset+=100;else offset+=20;void load();};
   card.querySelector('[data-refresh]').onclick=()=>void load();
   await load();
  }
  function closeHistory(){panel?.close();panel=null;rowCache.clear();panelPage='';if(galleryDirty&&!selectedCount&&!allScope){galleryDirty=false;void refresh().catch(notice);}}
  async function openHistory(){
   if(panel)return;
   panel=openShellOverlay(modal,{onDismiss:()=>{panel=null;rowCache.clear();panelPage='';}});panel.card.classList.add('ah-panel');
   panel.card.innerHTML='<div class="ah-head"><h2>保管・復元</h2><button data-close>閉じる</button></div><div class="ah-controls"><select data-state aria-label="保管状態"><option value="">すべて</option><option value="prepared">候補</option><option value="compacted">WebP</option><option value="restored">PNGに復元済み</option></select><button data-all>全選択</button><button data-clear>解除</button><span data-count class="ah-count"></span><button data-op="commit">保管</button><button data-op="restore">PNGに戻す</button><button data-op="discard">候補破棄</button></div><div data-metrics class="ah-detail"></div><div data-job class="ah-progress"></div><div class="ah-records"></div><div class="ah-controls"><button data-prev>前へ</button><span data-page class="ah-detail"></span><button data-next>次へ</button><span data-error class="ah-notice" role="status"></span></div><details class="ah-detail"><summary>保管について</summary>画素・生成情報を保持してWebPへ置き換えます。PNGの元バイト列とは異なります。PNGで取り出す際に自動復元します。展開キャッシュは最大512MB。</details>';
   panel.card.querySelector('[data-close]').onclick=closeHistory;
   const stateSelect=panel.card.querySelector('[data-state]');stateSelect.value=historyState;
   stateSelect.onchange=async()=>{historyState=stateSelect.value;historyOffset=0;historyAll=false;historySelected.clear();await reloadHistory();};
   panel.card.querySelector('[data-all]').onclick=()=>{historyAll=true;historySelected.clear();historyRows.forEach(r=>historySelected.add(r.id));updateHistorySelection();};
   panel.card.querySelector('[data-clear]').onclick=()=>{historyAll=false;historySelected.clear();updateHistorySelection();};
   panel.card.querySelector('[data-prev]').onclick=async()=>{historyOffset=Math.max(0,historyOffset-100);await reloadHistory();};
   panel.card.querySelector('[data-next]').onclick=async()=>{historyOffset+=100;await reloadHistory();};
   for(const button of panel.card.querySelectorAll('[data-op]'))button.onclick=()=>void operate(button.dataset.op);
   const rows=panel.card.querySelector('.ah-records');
   rows.addEventListener('click',(event:MouseEvent)=>{
    const target=event.target as HTMLElement;
    if(target.closest('button'))return;
    const row=target.closest('[data-id]') as HTMLElement;if(!row)return;
    const index=historyRows.findIndex(r=>r.id===row.dataset.id);
    if(event.shiftKey){for(let i=Math.min(historyAnchor<0?index:historyAnchor,index);i<=Math.max(historyAnchor<0?index:historyAnchor,index);i++)historySelected.add(historyRows[i].id);}
    else{const checked=target.tagName==='INPUT'?(target as HTMLInputElement).checked:!historySelected.has(row.dataset.id!);if(checked)historySelected.add(row.dataset.id!);else historySelected.delete(row.dataset.id!);historyAnchor=index;}
    historyAll=false;updateHistorySelection();
   });
   await reloadHistory();
  }
  async function reloadHistory(){try{renderHistory(await status());}catch(e){notice(e);}}
  function updateHistorySelection(){
   if(!panel)return;
   for(const [id,row] of rowCache){const checked=historyAll||historySelected.has(id);row.input.checked=checked;row.el.classList.toggle('is-selected',checked);}
   panel.card.querySelector('[data-count]').textContent=historyAll?`全${historyTotal}件`:historySelected.size?`${historySelected.size}件`:'';
  }
  function renderHistory(state:any){
   if(!panel)return;historyTotal=state.total;historyRows=state.records;
   const rows=panel.card.querySelector('.ah-records'), key=historyState+':'+historyOffset;
   if(panelPage!==key){rows.replaceChildren();rowCache.clear();historyAnchor=-1;panelPage=key;}
   const keep=new Set(historyRows.map(r=>r.id));
   for(const [id,row] of rowCache)if(!keep.has(id)){row.el.remove();rowCache.delete(id);}
   for(let index=0;index<historyRows.length;index++){
    const r=historyRows[index];historyStates.set(r.id,r.state);let row=rowCache.get(r.id);
    if(!row){
     const el=document.createElement('div');el.className='ah-record';el.dataset.id=r.id;
     el.innerHTML=`<input type="checkbox" aria-label="${esc(r.item.name)}"><img class="ah-record-thumb" loading="lazy" alt=""><span><strong></strong><small></small></span><button data-download>PNGで取り出す</button>`;
     row={el,input:el.querySelector('input'),name:el.querySelector('strong'),detail:el.querySelector('small'),download:el.querySelector('button')};rowCache.set(r.id,row);
     row.download.onclick=()=>void downloadPNG(r.id,row.download);
    }
    row.name.textContent=r.item.name;
    const thumb=row.el.querySelector('img');const url=imageThumbURL(r.item.type,r.item.subfolder,r.state==='compacted'?r.target_name:r.item.name,'',r.state+':'+r.webp_hash);
    if(thumb.getAttribute('src')!==url){thumb.src=url;thumb.onerror=()=>thumb.style.opacity='.2';thumb.onload=()=>thumb.style.opacity='1';}

    row.detail.textContent=`${rootLabel(r.item.type)}${r.item.subfolder?'/'+r.item.subfolder:''} · ${labels[r.state]||r.state} · ${mb(r.original_bytes)}${r.state==='not_smaller'?'':` → ${mb(r.webp_bytes)}`}`;
    row.download.hidden=!['prepared','placing','compacted'].includes(r.state);
    if(rows.children[index]!==row.el)rows.insertBefore(row.el,rows.children[index]||null);
   }
   panel.card.querySelector('[data-metrics]').textContent=`削減 ${mb(state.saved_bytes)} · 候補 ${mb(state.staged_bytes)} · 展開キャッシュ ${mb(state.cache_bytes)}`;
   panel.card.querySelector('[data-page]').textContent=`${state.total}件 · ${state.total?Math.floor(historyOffset/100)+1:0}/${Math.ceil(state.total/100)}`;
   panel.card.querySelector('[data-prev]').disabled=historyOffset===0;
   panel.card.querySelector('[data-next]').disabled=historyOffset+100>=state.total;
   panel.card.querySelector('[data-error]').textContent=state.job?.error_count?`${state.job.error_count}件失敗 · ${state.job.errors.at(-1)?.error||''}`:'';
   updateHistorySelection();
  }
  async function downloadPNG(id:string,button:HTMLButtonElement){
   if(button.disabled)return;button.disabled=true;button.textContent='復元中…';
   try{
    const response=await fetch('/asset_hub/png/'+id);if(!response.ok)throw Error((await response.json()).error);
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=historyRows.find(r=>r.id===id)?.item.name||'restored.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
   }catch(e){notice(e);}finally{button.disabled=false;button.textContent='PNGで取り出す';}
  }
  async function operate(action:string){
   try{
    const allowed=action==='commit'?['prepared','placing']:action==='restore'?['compacted']:['prepared'];
    let body:any;
    if(historyAll&&(!historyState||allowed.includes(historyState)))body={action,all_state:historyState||'*'};
    else{
     const ids=[...historySelected].filter(id=>allowed.includes(historyStates.get(id)||''));
     if(!ids.length){panel.card.querySelector('[data-error]').textContent=`${actions[action]}できる画像を選んでください。`;return;}
     body={action,ids};
    }
    const job=await api('operate',{...body,workers:concurrency});historyAll=false;historySelected.clear();updateHistorySelection();showSubmitted(job);schedulePoll();
   }catch(e:any){if(panel)panel.card.querySelector('[data-error]').textContent=e.message;else notice(e);}
  }
  void poll();
 }});
}
app.registerExtension({
 name:'local.asset-hub',
 settings:[...safeViewSettings()],
 commands:[{id:'asset-hub.open',label:'素材庫を開く',function:openHub}],
 menuCommands:[{path:['Extensions'],commands:['asset-hub.open']}],
 actionBarButtons:[{icon:'pi pi-images',label:'素材庫',tooltip:'画像と生成グラフの管理',onClick:openHub}],
 setup(){
  const legacyButton=document.createElement('button');
  legacyButton.dataset.assetHubLauncher='';legacyButton.textContent='素材庫';legacyButton.title='素材庫を開く';legacyButton.onclick=()=>void openHub();
  const legacyMenu=app.ui.menuContainer;
  legacyMenu.insertBefore(legacyButton,legacyMenu.children[1]||null);
  app.extensionManager.registerSidebarTab({
   id:'asset-hub',icon:'pi pi-images',title:'素材庫',label:'素材庫',tooltip:'素材庫を開く',type:'custom',
   async onToggle(){await openHub();return true;},
   render(element:HTMLElement){
    const button=document.createElement('button');button.textContent='素材庫を開く';button.onclick=()=>void openHub();element.replaceChildren(button);
   },
  });
 },
});
