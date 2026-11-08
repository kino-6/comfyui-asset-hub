export interface ImageProgress {
 slot:number;
 name:string;
 phase:string;
 percent:number|null;
 elapsed_s:number;
}

export interface JobState {
 id:string;
 action:string;
 status:string;
 total:number;
 done:number;
 succeeded:number;
 workers:number;
 started?:number;
 skipped?:number;
 not_smaller?:number;
 error_count?:number;
 message?:string;
 stopping?:boolean;
 wait_reason?:string;
 cpu_percent?:number|null;
 running?:unknown[];
 progress?:ImageProgress[];
}

export interface HubStatus {
 job:JobState|null;
 queue:JobState[];
 attention:number;
 performance:{cpu_target:number|null;workers:number};
}

export const actionLabels:Record<string,string> = {
 prepare:'候補作成', archive:'圧縮・保管', commit:'保管', restore:'PNGに戻す', discard:'候補破棄',
};

export function submittedJobText(job:JobState):string {
 const action=actionLabels[job.action];
 if(job.status==='queued')return `${action} ${job.total}件を待ち行列に追加`;
 return `${action} ${job.done||0}/${job.total}`;
}

export function jobProgressText(job:JobState, queued:number, rate:number|null):string {
 if(job.status==='running'){
  const parts=[`${actionLabels[job.action]} ${job.done}/${job.total}`, `${job.running?.length||0}/${job.workers}並列`];
  if(job.stopping)parts.push('処理中の画像が終わったら一時停止');
  else if(job.wait_reason)parts.push(job.wait_reason);
  else parts.push(rate===null?'速度計測中':`直近 ${rate.toFixed(1)}枚/秒`);
  if(queued)parts.push(`待ち ${queued}件`);
  return parts.join(' · ');
 }
 if(['paused','cancelled'].includes(job.status))return `一時停止 · ${job.done}/${job.total}件処理済み`;
 if(job.status==='error')return `処理停止 · ${job.message||'処理履歴を確認してください'}`;
 const retained=job.not_smaller||0;
 const skipped=Math.max(0,(job.skipped||0)-retained);
 const parts=[`${job.succeeded}件完了`];
 if(retained)parts.push(`原本保持 ${retained}件（削減なし）`);
 if(skipped)parts.push(`${skipped}件スキップ`);
 if(job.error_count)parts.push(`${job.error_count}件失敗`);
 return parts.join(' · ');
}

// Wall-clock throughput of successful work observed in this view. Historical
// elapsed time and skipped/error tasks must not masquerade as encoding speed.
export class RecentRate {
 private key='';
 private samples:{at:number,count:number}[]=[];
 sample(job:JobState|null|undefined, now:number):number|null {
  const key=job?.status==='running'?`${job.id}:${job.started??''}`:'';
  const count=job?.succeeded??0, last=this.samples.at(-1);
  if(!key||key!==this.key||last&&(count<last.count||now-last.at>60000||now<last.at))this.samples=[];
  this.key=key;
  if(!key)return null;
  if(!last||last.at!==now||!this.samples.length)this.samples.push({at:now,count});
  // Retain one point just before the window boundary for an honest denominator.
  while(this.samples.length>2&&this.samples[1].at<=now-30000)this.samples.shift();
  const first=this.samples[0], seconds=(now-first.at)/1000;
  return seconds>=5?(count-first.count)/seconds:null;
 }
}
