import {openShellOverlay, ensureStyleOnce} from '@laurigates/comfy-modal-kit';
import {imageThumbURL} from '../vendor/image-browser/src/api';

type Point={x:number,y:number};
const NS='http://www.w3.org/2000/svg';
const svgElement=(tag:string,attrs:Record<string,string|number>={})=>{const el=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el;};
const thumb=(node:any)=>imageThumbURL(node.item.type,node.item.subfolder,node.item.name,'',node.id);

export async function openRelations(modal:any,body:any,api:(tail:string,body?:any)=>Promise<any>){
 ensureStyleOnce('asset-hub-relations-v1',`
 .ah-relations{width:min(1380px,96vw)!important;max-width:none!important;height:calc(100dvh - 32px);max-height:none!important;display:flex;flex-direction:column;padding:14px!important;gap:10px;color:#e7eeec}
 .ah-relation-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ah-relation-head h2{font-size:18px;margin:0}.ah-relation-head select,.ah-relation-head button,.ah-relation-detail button{background:#2d3a3e;border:1px solid #50635f;color:inherit;border-radius:6px;padding:7px 10px;cursor:pointer}.ah-relation-head [data-close]{margin-left:auto}
 .ah-relation-status{color:#a9bbb5;font-size:12px;min-height:18px}.ah-relation-body{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:12px;flex:1;min-height:0}.ah-relation-canvas{min-width:0;min-height:0;border:1px solid #38433f;border-radius:8px;background:#14191b;position:relative;overflow:hidden}.ah-relation-canvas svg{width:100%;height:100%;touch-action:none;user-select:none;display:block}.ah-relation-help{position:absolute;bottom:8px;left:10px;color:#8ea39c;font-size:11px;pointer-events:none}.ah-relation-legend{position:absolute;top:8px;left:10px;font-size:11px;pointer-events:none}.ah-relation-empty{position:absolute;inset:40% 10px auto;text-align:center;color:#9eafa9;pointer-events:none}
 .ah-relation-node{cursor:pointer}.ah-relation-node:focus rect{stroke:#fff;stroke-width:3}.ah-relation-detail{overflow:auto;min-width:0;font-size:13px}.ah-relation-detail h3{font-size:14px;overflow-wrap:anywhere;margin:8px 0}.ah-relation-pair{display:flex;gap:8px}.ah-relation-pair img{width:calc(50% - 4px);height:105px;object-fit:contain;background:#121719;border-radius:5px}.ah-relation-detail p{line-height:1.6;overflow-wrap:anywhere}.ah-relation-tags{display:flex;gap:5px;flex-wrap:wrap}.ah-relation-tags span{padding:3px 6px;background:#25453d;border-radius:4px;overflow-wrap:anywhere}.ah-relation-prompt{white-space:pre-wrap;max-height:180px;overflow:auto;color:#a9bbb5}.ah-relation-detail small{color:#9aaba5;line-height:1.5;display:block}.ah-relation-head [data-errors]{color:#e4c391}.ah-relations button:disabled{opacity:.45;cursor:default}
 @media(max-width:850px){.ah-relation-body{grid-template-columns:minmax(0,1fr) 210px}.ah-relation-head{gap:5px}.ah-relation-pair img{height:80px}}
 `);
 let closed=false,jobId='',center:string|null=null,mode='combined',offset=0,timer:ReturnType<typeof setTimeout>,data:any=null,selected:string|null=null,requestVersion=0,cancelling=false;
 let positions=new Map<string,Point>(),view={x:0,y:0,scale:1},viewTouched=false,layoutCenter:string|null=null;
 const dispose=()=>{if(closed)return;closed=true;clearTimeout(timer);resize.disconnect();if(jobId)void api('relations/cancel',{id:jobId}).catch(()=>{});};
 const overlay=openShellOverlay(modal,{onDismiss:dispose}),card=overlay.card as HTMLElement;card.classList.add('ah-relations');
 card.innerHTML='<div class="ah-relation-head"><h2>画像の関連図</h2><select aria-label="関連の基準"><option value="combined">総合</option><option value="prompt">共通プロンプト</option><option value="visual">見た目（色・配置・輪郭）</option></select><button data-fit>全体表示</button><button data-stop>解析を停止</button><button data-errors hidden>解析失敗</button><button data-close>一覧へ</button></div><div class="ah-relation-status" role="status">解析を開始しています…</div><div class="ah-relation-body"><div class="ah-relation-canvas"><svg aria-label="画像同士の関連図"></svg><div class="ah-relation-empty">画像を解析しています…</div><div class="ah-relation-help">画像・線をクリックで共通点 · 画像をドラッグで配置 · 背景ドラッグ／ホイールで移動・拡大</div></div><aside class="ah-relation-detail"><p>画像または線を選ぶと、共通プロンプトや見た目の近さを表示します。</p><small>見た目は色調・配置・輪郭で比較します。被写体の意味を判定する機能ではありません。</small></aside></div>';
 const svg=card.querySelector('svg')!,viewport=card.querySelector('.ah-relation-canvas') as HTMLElement,detail=card.querySelector('aside')!,status=card.querySelector('.ah-relation-status')!,empty=card.querySelector('.ah-relation-empty') as HTMLElement;
 const group=svgElement('g'),edgeLayer=svgElement('g'),nodeLayer=svgElement('g');group.append(edgeLayer,nodeLayer);svg.append(group);
 const legend=document.createElement('div');legend.className='ah-relation-legend';legend.innerHTML='<span style="color:#65bfa4">━ 共通語句</span>　<span style="color:#d3ac6a">━ 見た目</span>　<span style="color:#ad9ad1">━ 両方</span>';viewport.append(legend);
 const stopButton=card.querySelector('[data-stop]') as HTMLButtonElement;
 const previous=document.createElement('button'),next=document.createElement('button');previous.textContent='前の20枚';next.textContent='次の20枚';previous.hidden=next.hidden=true;stopButton.before(previous,next);
 previous.onclick=()=>{offset=Math.max(0,offset-20);selected=null;viewTouched=false;void query();};next.onclick=()=>{offset+=20;selected=null;viewTouched=false;void query();};
 const resize=new ResizeObserver(()=>{if(data&&!viewTouched)fit();});resize.observe(viewport);
 card.querySelector('[data-close]')!.addEventListener('click',()=>{dispose();overlay.close();});
 function transform(){group.setAttribute('transform',`translate(${view.x} ${view.y}) scale(${view.scale})`);}
 function fit(){
  if(!data?.nodes.length)return;
  const points=data.nodes.map((node:any)=>positions.get(node.id)!);const minX=Math.min(...points.map((p:Point)=>p.x))-65,maxX=Math.max(...points.map((p:Point)=>p.x))+65,minY=Math.min(...points.map((p:Point)=>p.y))-52,maxY=Math.max(...points.map((p:Point)=>p.y))+52;
  const width=viewport.clientWidth,height=viewport.clientHeight;view.scale=Math.min(1.6,(width-40)/(maxX-minX),(height-55)/(maxY-minY));view.x=width/2-(minX+maxX)/2*view.scale;view.y=(height-20)/2-(minY+maxY)/2*view.scale;transform();
 }
 card.querySelector('[data-fit]')!.addEventListener('click',()=>{viewTouched=false;fit();});
 function arrange(){
  if(layoutCenter!==data.center){positions=new Map();layoutCenter=data.center;viewTouched=false;}
  let added=false;
  data.nodes.forEach((node:any,index:number)=>{if(!positions.has(node.id)){added=true;const angle=index*2.39996,radius=160*Math.sqrt(index);positions.set(node.id,{x:index?Math.cos(angle)*radius:0,y:index?Math.sin(angle)*radius:0});}});
  if(!added)return;
  const ids=data.nodes.map((node:any)=>node.id);
  for(let iteration=0;iteration<130;iteration++){
   const force=new Map<string,Point>(ids.map((id:string)=>[id,{x:0,y:0}]));
   for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
    const a=positions.get(ids[i])!,b=positions.get(ids[j])!,dx=a.x-b.x,dy=a.y-b.y,d=Math.max(1,Math.hypot(dx,dy)),push=25000/(d*d);
    force.get(ids[i])!.x+=dx/d*push;force.get(ids[i])!.y+=dy/d*push;force.get(ids[j])!.x-=dx/d*push;force.get(ids[j])!.y-=dy/d*push;
   }
   for(const edge of data.edges){const a=positions.get(edge.source)!,b=positions.get(edge.target)!,dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),pull=(d-(180+(1-edge.score)*70))*.018;force.get(edge.source)!.x+=dx/d*pull;force.get(edge.source)!.y+=dy/d*pull;force.get(edge.target)!.x-=dx/d*pull;force.get(edge.target)!.y-=dy/d*pull;}
   for(const id of ids){if(id===data.center)continue;const p=positions.get(id)!,f=force.get(id)!;p.x+=Math.max(-6,Math.min(6,f.x));p.y+=Math.max(-6,Math.min(6,f.y));}
  }
  // Resolve rectangular thumbnail collisions after spring placement.
  for(let pass=0;pass<100;pass++){
   let overlaps=0;
   for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
    const a=positions.get(ids[i])!,b=positions.get(ids[j])!,dx=a.x-b.x,dy=a.y-b.y,ox=124-Math.abs(dx),oy=100-Math.abs(dy);
    if(ox<=0||oy<=0)continue;overlaps++;
    const axis=ox<oy?'x':'y',distance=(axis==='x'?ox:oy)+.1,direction=(axis==='x'?dx:dy)>=0?1:-1;
    const aFixed=ids[i]===data.center,bFixed=ids[j]===data.center;
    if(!aFixed)a[axis]+=direction*distance*(bFixed?1:.5);
    if(!bFixed)b[axis]-=direction*distance*(aFixed?1:.5);
   }
   if(!overlaps)break;
  }
 }
 function showDetails(node:any,edge?:any){
  selected=node.id;detail.replaceChildren();
  const pair=document.createElement('div');pair.className='ah-relation-pair';
  const source=edge?data.nodes.find((candidate:any)=>candidate.id===edge.source):data.nodes.find((candidate:any)=>candidate.id===data.center);
  for(const picture of [source,node]){if(!picture)continue;const image=document.createElement('img');image.src=thumb(picture);image.alt=picture.item.name;pair.append(image);if(source?.id===node.id)break;}
  detail.append(pair);const name=document.createElement('h3');name.textContent=node.item.name;detail.append(name);
  if(node.image_missing){const missing=document.createElement('p');missing.textContent='画像が移動・削除されています。一覧を更新して関連図を開き直してください。';detail.append(missing);}
  if(edge){
   const from=document.createElement('small');from.textContent=`比較元：${source.item.name}`;detail.append(from);
   const heading=document.createElement('p');heading.textContent='共通プロンプト';detail.append(heading);
   const tags=document.createElement('div');tags.className='ah-relation-tags';
   if(!edge.common.length)tags.textContent='共通語句なし';
   for(const term of edge.common){const tag=document.createElement('span');tag.textContent=term;tags.append(tag);}detail.append(tags);
   const appearance=document.createElement('p');appearance.textContent=`見た目の近さ：${Math.round(edge.visual*100)}/100\n色調 ${edge.features.color} · 配置 ${edge.features.layout} · 輪郭 ${edge.features.shape}`;appearance.style.whiteSpace='pre-line';detail.append(appearance);
   const note=document.createElement('small');note.textContent='色・配置・輪郭の比較値です。同じ被写体である確率ではありません。'+(edge.unknown_prompt?' 正負を判別できない抽出テキストを含みます。':'');detail.append(note);
  }
  const label=document.createElement('p');label.textContent=node.prompt_source==='positive'?'正のプロンプト':node.prompt_source==='unknown'?'抽出テキスト（正負不明）':'プロンプト情報なし';detail.append(label);
  if(node.prompt){const prompt=document.createElement('p');prompt.className='ah-relation-prompt';prompt.textContent=node.prompt;detail.append(prompt);}
  if(node.id!==data.center){const focus=document.createElement('button');focus.textContent='この画像を中心に';focus.dataset.center=node.id;focus.onclick=()=>{center=node.id;offset=0;selected=null;void query();};detail.append(focus);}
  else{const hint=document.createElement('small');hint.textContent='線や画像を選ぶと、この画像との共通点を表示します。';detail.append(hint);}
  highlight();
 }
 function highlight(){for(const node of nodeLayer.querySelectorAll<SVGGElement>('[data-node]')){const id=node.dataset.node!,rect=node.querySelector('rect')!;rect.setAttribute('stroke',id===selected?'#ffd878':id===data?.center?'#8cdabb':'#526763');rect.setAttribute('stroke-width',id===selected||id===data?.center?'3':'1');}for(const edge of edgeLayer.querySelectorAll('[data-edge]'))edge.setAttribute('opacity',selected&&selected!==data?.center&&!edge.getAttribute('data-edge')!.split(':').includes(selected)?'.12':'.7');}
 function draw(){
  edgeLayer.replaceChildren();nodeLayer.replaceChildren();
  for(const edge of data.edges){
   const a=positions.get(edge.source)!,b=positions.get(edge.target)!,line=svgElement('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:edge.prompt>=.15?(edge.visual>=.88?'#ad9ad1':'#65bfa4'):'#d3ac6a','stroke-width':2+edge.score*2,opacity:.7});
   line.setAttribute('data-edge',`${edge.source}:${edge.target}`);line.style.cursor='pointer';
   const title=svgElement('title');title.textContent=edge.common.length?`共通：${edge.common.join('、')}`:`色・配置・輪郭の近さ ${Math.round(edge.visual*100)}/100`;line.append(title);
   line.addEventListener('click',()=>showDetails(data.nodes.find((node:any)=>node.id===edge.target),edge));edgeLayer.append(line);
  }
  for(const node of data.nodes){
   const p=positions.get(node.id)!,el=svgElement('g',{transform:`translate(${p.x} ${p.y})`,tabindex:0,role:'button','aria-label':node.item.name});el.classList.add('ah-relation-node');el.setAttribute('data-node',node.id);
   const border=svgElement('rect',{x:-56,y:-44,width:112,height:88,rx:7,fill:'#24322f'}),picture=svgElement('image',{x:-51,y:-39,width:102,height:62,href:thumb(node),preserveAspectRatio:'xMidYMid meet'}),name=svgElement('text',{x:0,y:37,'text-anchor':'middle',fill:'#e2eae7','font-size':10});name.textContent=node.item.name.length>18?node.item.name.slice(0,16)+'…':node.item.name;
   const title=svgElement('title');title.textContent=node.item.name;el.append(border,picture,name,title);
   const inspect=()=>{const edge=data.edges.find((edge:any)=>edge.source===data.center&&edge.target===node.id);showDetails(node,edge);};
   el.addEventListener('keydown',event=>{const key=event as KeyboardEvent;if(key.key==='Enter'||key.key===' '){key.preventDefault();inspect();}});
   el.addEventListener('dblclick',()=>{center=node.id;offset=0;selected=null;void query();});
   nodeLayer.append(el);
  }
  highlight();transform();
 }
 let drag:{id:string|null,x:number,y:number,moved:boolean}|null=null;
 svg.addEventListener('pointerdown',event=>{if(event.button!==0)return;const target=event.target as Element;if(target.closest('[data-edge]'))return;drag={id:target.closest('[data-node]')?.getAttribute('data-node')||null,x:event.clientX,y:event.clientY,moved:false};svg.setPointerCapture(event.pointerId);});
 svg.addEventListener('pointermove',event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)<2&&!drag.moved)return;drag.moved=true;viewTouched=true;drag.x=event.clientX;drag.y=event.clientY;if(drag.id){const p=positions.get(drag.id)!;p.x+=dx/view.scale;p.y+=dy/view.scale;draw();}else{view.x+=dx;view.y+=dy;transform();}});
 svg.addEventListener('pointerup',event=>{if(!drag)return;const finished=drag;drag=null;svg.releasePointerCapture(event.pointerId);if(finished.id&&!finished.moved){const node=data.nodes.find((n:any)=>n.id===finished.id),edge=data.edges.find((e:any)=>e.source===data.center&&e.target===finished.id);showDetails(node,edge);}});
 svg.addEventListener('pointercancel',()=>{drag=null;});
 svg.addEventListener('wheel',event=>{event.preventDefault();const rect=svg.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,scale=Math.max(.12,Math.min(4,view.scale*Math.exp(-event.deltaY*.001)));view.x=x-(x-view.x)*scale/view.scale;view.y=y-(y-view.y)*scale/view.scale;view.scale=scale;viewTouched=true;transform();},{passive:false});
 card.querySelector('select')!.addEventListener('change',event=>{mode=(event.target as HTMLSelectElement).value;offset=0;selected=null;void query();});
 card.querySelector('[data-errors]')!.addEventListener('click',()=>{detail.replaceChildren();const title=document.createElement('h3');title.textContent=`解析できなかった画像 ${data.job.error_count}件`;detail.append(title);for(const error of data.job.errors){const p=document.createElement('p');p.textContent=`${error.name}：${error.error}`;detail.append(p);}if(data.job.error_count>20){const p=document.createElement('small');p.textContent='直近20件を表示しています。';detail.append(p);}});
 stopButton.onclick=async()=>{try{if(data?.job.status==='cancelled'){await begin();return;}cancelling=true;stopButton.disabled=true;await api('relations/cancel',{id:jobId});void query();}catch(error:any){status.textContent=error.message;}};
 async function query(){
  if(!jobId||closed)return;clearTimeout(timer);const revision=++requestVersion;
  try{
   const result=await api('relations/query',{id:jobId,center,mode,offset});if(closed||revision!==requestVersion)return;
   if(drag){timer=setTimeout(query,200);return;}
   data=result;if(result.center)center=result.center;offset=result.offset;
   const job=data.job,running=job.status==='running';
   status.textContent=`${running?'解析中':job.status==='cancelled'?'解析を停止':job.status==='error'?'解析でエラー':'解析済み'} ${job.done}/${job.total}枚 · 関連 ${data.related_total}枚${data.related_total?'（'+(offset+1)+'–'+(offset+data.nodes.length-1)+'枚目）':''}${job.cached?' · 再利用 '+job.cached+'枚':''}${job.error_count?' · 失敗 '+job.error_count+'件':''}`;
   previous.hidden=next.hidden=data.related_total<=20;previous.disabled=offset===0;next.disabled=offset+20>=data.related_total;
   stopButton.hidden=job.status==='done'||job.status==='error';stopButton.textContent=job.status==='cancelled'?'解析を再開':cancelling?'停止中…':'解析を停止';stopButton.disabled=running&&cancelling;if(!running)cancelling=false;
   (card.querySelector('[data-errors]') as HTMLElement).hidden=!job.error_count;
   empty.hidden=data.nodes.length>1;empty.textContent=data.nodes.length?(running?'近い画像を探しています。解析の途中でも基準を切り替えられます。':'関連する画像が見つかりませんでした。別の基準や中心画像を選んでください。'):running?'画像を解析しています…':'解析できる画像がありません。';
   if(!drag){arrange();draw();if(!viewTouched)fit();}
   if(!selected||!data.nodes.some((node:any)=>node.id===selected)){selected=data.center;if(data.nodes[0])showDetails(data.nodes[0]);}
   if(running)timer=setTimeout(query,1200);
  }catch(error:any){if(!closed&&revision===requestVersion)status.textContent=error.message;}
 }
 async function begin(){
  stopButton.disabled=true;const seed=data?.nodes.find((node:any)=>node.id===center)?.item||body.center;
  const started=await api('relations/start',{...body,center:seed});jobId=started.id;
  if(closed){await api('relations/cancel',{id:jobId});return;}
  cancelling=false;await query();
 }
 try{await begin();}catch(error:any){if(!closed){status.textContent=error.message;empty.textContent='解析を開始できませんでした。';stopButton.hidden=true;}}
}
