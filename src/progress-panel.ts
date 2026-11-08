import {jobProgressText, submittedJobText, type HubStatus, type JobState, type ImageProgress} from './progress';

interface ProgressActions {
 pause:()=>void;
 resume:(id:string)=>void;
 history:()=>void;
}

let rememberedOpen=true;

/** Renders job state; networking and polling belong to the hub controller. */
export class ProgressPanel {
 readonly element=document.createElement('div');
 readonly details=document.createElement('details');
 readonly cpuSelect:HTMLSelectElement;
 readonly noticeElement:HTMLElement;
 private readonly cpu:HTMLElement;
 private readonly text:HTMLElement;
 private readonly total:HTMLElement;
 private readonly meter:HTMLProgressElement;
 private readonly pause:HTMLButtonElement;
 private readonly resume:HTMLButtonElement;
 private readonly history:HTMLButtonElement;
 private readonly grid:HTMLElement;
 private readonly summary:HTMLElement;
 private readonly rows=new Map<number,HTMLElement>();
 private resumableId='';

 constructor(parent:HTMLElement, actions:ProgressActions){
  this.element.className='ah-toolbar';
  this.element.innerHTML=`
   <select data-cpu-target aria-label="CPU目標" title="PC全体のCPU使用率の目安。画像生成中もCPU・メモリの余裕に応じて圧縮を続けます。全速はCPU調整を解除します。変更は処理中にも反映します。">
    <option value="30">CPU目標 30%</option><option value="50">CPU目標 50%</option>
    <option value="70" selected>CPU目標 70%</option><option value="90">CPU目標 90%</option><option value="full">全速</option>
   </select>
   <span data-cpu-current class="ah-detail" title="PC全体の実測CPU使用率。2秒間隔で取得します。"></span>
   <span data-total-progress class="ah-total-meter" hidden>全体<progress class="ah-run-meter" aria-label="全体の処理進捗" max="1" value="0" hidden></progress></span>
   <span data-progress class="ah-progress"></span>
   <button data-stop hidden>一時停止</button><button data-resume hidden>再開</button><button data-jobs>処理履歴</button>
   <span class="ah-notice" role="status"></span>`;
  this.cpuSelect=this.element.querySelector('[data-cpu-target]')!;
  this.noticeElement=this.element.querySelector('.ah-notice')!;
  this.cpu=this.element.querySelector('[data-cpu-current]')!;
  this.text=this.element.querySelector('[data-progress]')!;
  this.total=this.element.querySelector('[data-total-progress]')!;
  this.meter=this.element.querySelector('progress')!;
  this.pause=this.element.querySelector('[data-stop]')!;
  this.resume=this.element.querySelector('[data-resume]')!;
  this.history=this.element.querySelector('[data-jobs]')!;
  this.text.title='直近約30秒の完了枚数÷実時間。失敗・既処理スキップを除く。開いてから5秒後に表示し、待機時間も含めます。';
  this.pause.onclick=actions.pause;
  this.resume.onclick=()=>actions.resume(this.resumableId);
  this.history.onclick=actions.history;

  this.details.className='ah-work';
  this.details.open=rememberedOpen;
  this.details.hidden=true;
  this.details.innerHTML='<summary>処理中の画像</summary><div class="ah-work-grid"></div>';
  this.details.addEventListener('toggle',()=>{rememberedOpen=this.details.open;});
  this.grid=this.details.querySelector('.ah-work-grid')!;
  this.summary=this.details.querySelector('summary')!;
  parent.append(this.element,this.details);
 }

 showSubmitted(job:JobState){
  this.text.textContent=submittedJobText(job);
 }

 render(state:HubStatus, rate:number|null):string|null {
  const job=state.job;
  const running=job?.status==='running';
  this.cpu.textContent=running&&job.cpu_percent!=null?`CPU使用率 ${Math.round(job.cpu_percent)}%`:'';
  this.history.textContent=state.attention?`処理履歴 · 要確認 ${state.attention}`:'処理履歴';
  this.renderImages(running?job.progress||[]:[]);
  if(!job)return null;

  const text=jobProgressText(job,state.queue.length,rate);
  this.text.textContent=text;
  this.meter.hidden=this.total.hidden=!running;
  this.meter.max=job.total;
  this.meter.value=job.done;
  this.pause.hidden=!running;
  this.pause.disabled=Boolean(job.stopping);
  this.resumableId=job.id;
  this.resume.hidden=running||!['paused','error'].includes(job.status)||job.done>=job.total;
  return text;
 }

 private renderImages(items:ImageProgress[]){
  this.details.hidden=!items.length;
  this.summary.textContent=`処理中の画像 ${items.length}件`;
  const slots=new Set(items.map(item=>item.slot));
  for(const [slot,row] of this.rows){
   if(!slots.has(slot)){row.remove();this.rows.delete(slot);}
  }
  for(const item of items){
   let row=this.rows.get(item.slot);
   if(!row){
    row=document.createElement('div');
    row.className='ah-work-item';
    row.dataset.slot=String(item.slot);
    row.innerHTML='<span class="ah-work-name"></span><span class="ah-work-phase"></span><progress max="100"></progress><span class="ah-work-time"></span>';
    this.rows.set(item.slot,row);
   }
   const name=row.querySelector<HTMLElement>('.ah-work-name')!;
   name.textContent=name.title=item.name;
   row.querySelector('.ah-work-phase')!.textContent=item.phase+(item.percent==null?'':` ${item.percent}%`);
   const meter=row.querySelector('progress')!;
   meter.setAttribute('aria-label',`${item.name} ${item.phase}`);
   if(item.percent==null)meter.removeAttribute('value');else meter.value=item.percent;
   row.querySelector('.ah-work-time')!.textContent=`${Math.floor(item.elapsed_s||0)}秒`;
   this.grid.append(row);
  }
 }
}
