/* ── Toast notifications (replaces alert()) ── */
function showToast(msg, type='error'){
  let wrap=document.getElementById('toastWrap');
  if(!wrap){
    wrap=document.createElement('div');
    wrap.id='toastWrap';
    wrap.style.cssText='position:fixed;top:68px;right:16px;z-index:999;display:flex;flex-direction:column;gap:8px;max-width:380px;';
    document.body.appendChild(wrap);
  }
  const t=document.createElement('div');
  const bg=type==='error'?'rgba(239,68,68,.95)':type==='warn'?'rgba(234,179,8,.95)':'rgba(52,211,153,.95)';
  t.style.cssText=`background:${bg};color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.5;
    box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer;word-break:break-word;`;
  t.textContent=msg;
  t.addEventListener('click',()=>t.remove());
  wrap.appendChild(t);
  setTimeout(()=>t.remove(), type==='error'?8000:4000);
  // Also log to console for debugging
  if(type==='error') console.error('[AI Detection]', msg);
  else console.log('[AI Detection]', msg);
}

/* ── State ── */
const state = {
  allFiles:[], filtered:[], filter:'all', page:1, pageSize:30,
  currentFile:null, annotations:null, aiResults:null, aiResultsAll:{},
  fileLabels:{},
  zoom:1, panX:0, panY:0, isDragging:false, dragStart:{x:0,y:0}, panAtDrag:{x:0,y:0},
  hoveredIdx:null, showSigs:true, showLogos:true, showAI:true,
  batchRunning:false, batchStopped:false,
};

/* ── DOM ── */
const $=id=>document.getElementById(id);
const fileList=$('fileList'), pagination=$('pagination'), headerStats=$('headerStats');
const viewerContainer=$('viewerContainer'), viewerViewport=$('viewerViewport');
const viewerEmpty=$('viewerEmpty'), viewerLoading=$('viewerLoading');
const mainImage=$('mainImage'), bboxCanvas=$('bboxCanvas'), ctx=bboxCanvas.getContext('2d');
const toolbarFilename=$('toolbarFilename'), zoomLabel=$('zoomLabel');
const detailEmpty=$('detailEmpty'), detailContent=$('detailContent');
const detailFileName=$('detailFileName'), detailMeta=$('detailMeta');
const sigList=$('sigList'), logoList=$('logoList'), aiList=$('aiList');
const sigCountBadge=$('sigCountBadge'), logoCountBadge=$('logoCountBadge'), aiCountBadge=$('aiCountBadge');
const sigSection=$('sigSection'), logoSection=$('logoSection'), aiSection=$('aiSection');
const btnDetect=$('btnDetect');

/* ── Colours ── */
const COL_SIG_KNOWN  ={stroke:'#f97316',fill:'rgba(249,115,22,.12)'};
const COL_SIG_UNKNOWN={stroke:'#6b7280',fill:'rgba(107,114,128,.10)'};
const COL_LOGO       ={stroke:'#60a5fa',fill:'rgba(96,165,250,.12)'};
const COL_AI         ={stroke:'#a855f7',fill:'rgba(168,85,247,.12)'};

/* ── Config (localStorage) ── */
const DEFAULT_PROMPT=`You are an expert in document forensics. Locate all handwritten signatures in this scanned document image.

A SIGNATURE is a person's name written by hand as a personal mark — typically at the end of a letter or on a signature line.

NOT a signature: printed text, stamps, logos, handwritten notes, initials alone.

There may be ZERO, ONE, or MULTIPLE signatures. Find ALL, invent NONE.

CRITICAL REQUIREMENT for bounding boxes:
The bounding box MUST be a TIGHT FIT around the signature. The edges of the box (x, y, w, h) must EXACTLY wrap the visible ink of the signature, leaving minimal empty space. DO NOT guess the size based on experience; calculate the exact boundaries.

Reply with JSON only — no explanation, no markdown.
All coordinate values are PERCENTAGES of the image dimensions, ranging from 0.0 to 100.0.
Example for a signature in the lower-right area:
{"has_signatures": true, "signatures": [{"x_pct": 55.0, "y_pct": 72.0, "w_pct": 22.0, "h_pct": 8.0}]}

Your response:
{
  "has_signatures": true or false,
  "signatures": [
    {"x_pct": <0.0–100.0>, "y_pct": <0.0–100.0>, "w_pct": <0.0–100.0>, "h_pct": <0.0–100.0>}
  ]
}`;


function getConfig(){
  return {
    apiUrl: localStorage.getItem('cfg_api_url')||'',
    apiKey: localStorage.getItem('cfg_api_key')||'',
    model:  localStorage.getItem('cfg_model')||'gpt-4o',
    scale:  localStorage.getItem('cfg_scale')||'0.5',
    prompt: localStorage.getItem('cfg_prompt')||DEFAULT_PROMPT,
  };
}
function saveConfig(){
  localStorage.setItem('cfg_api_url', $('cfgApiUrl').value.trim());
  localStorage.setItem('cfg_api_key', $('cfgApiKey').value.trim());
  localStorage.setItem('cfg_model',   $('cfgModel').value.trim()||'gpt-4o');
  localStorage.setItem('cfg_scale',   $('cfgScale').value);
  localStorage.setItem('cfg_prompt',  $('cfgPrompt').value);
  closeSettings();
}
function loadConfigToForm(){
  const c=getConfig();
  $('cfgApiUrl').value=c.apiUrl;
  $('cfgApiKey').value=c.apiKey;
  $('cfgScale').value=c.scale;
  $('cfgPrompt').value=c.prompt;
  // Restore saved model into select
  const sel=$('cfgModel');
  if(c.model && ![...sel.options].some(o=>o.value===c.model)){
    const opt=document.createElement('option');
    opt.value=opt.textContent=c.model;
    sel.insertBefore(opt, sel.options[1]||null);
  }
  if(c.model) sel.value=c.model;
}

async function fetchModels(){
  const btn=$('btnFetchModels'), hint=$('modelHint');
  const apiUrl=$('cfgApiUrl').value.trim();
  const apiKey=$('cfgApiKey').value.trim();
  if(!apiUrl||!apiKey){hint.style.color='#f87171';hint.textContent='请先填写 API 地址和 Key';return;}
  btn.disabled=true; btn.textContent='获取中…'; hint.textContent='';
  try{
    const params=new URLSearchParams({api_url:apiUrl,api_key:apiKey});
    const resp=await fetch('/api/models?'+params);
    const data=await resp.json();
    if(!resp.ok){hint.style.color='#f87171';hint.textContent=data.error||'获取失败';return;}
    const sel=$('cfgModel');
    const prev=sel.value;
    sel.innerHTML='';
    data.forEach(m=>{const o=document.createElement('option');o.value=o.textContent=m;sel.appendChild(o);});
    if(data.includes(prev)) sel.value=prev;
    hint.style.color='var(--green)'; hint.textContent=`获取到 ${data.length} 个模型`;
  }catch(e){hint.style.color='#f87171';hint.textContent='请求失败: '+e.message;}
  finally{btn.disabled=false;btn.textContent='获取列表';}
}

/* ── Settings drawer ── */
function openSettings(){ loadConfigToForm(); $('drawerOverlay').hidden=false; $('settingsDrawer').hidden=false; }
function closeSettings(){ $('drawerOverlay').hidden=true; $('settingsDrawer').hidden=true; }

/* ── Init ── */
async function init(){
  setupViewerInteraction(); setupToolbar(); setupSettings(); setupStats(); setupBatch();
  const [files, aiSummary]=await Promise.all([
    fetch('/api/files').then(r=>r.json()),
    fetch('/api/results').then(r=>r.json()),
  ]);
  state.allFiles=files;
  state.aiResultsAll=aiSummary||{};
  applyFilter(); renderStats();
  loadFileLabels();
}

/* ── Stats ── */
function renderStats(){
  const total=state.allFiles.length;
  const sigs=state.allFiles.filter(f=>f.has_signature).length;
  const aiDone=Object.keys(state.aiResultsAll).length;
  const headerStats=document.getElementById('headerStats');
  if(!headerStats) return;
  headerStats.innerHTML=`<div class="stat-chip">${total} 文档</div>
    <div class="stat-chip sig">✍ ${sigs} 含签名</div>
    ${aiDone?`<div class="stat-chip" style="color:var(--purple);border-color:rgba(168,85,247,.3);background:var(--purple-dim)">AI ${aiDone} 已检测</div>`:''}`;
}

/* ── Filter & pagination ── */
function applyFilter(){
  const f=state.filter;
  const ai=state.aiResultsAll;
  state.filtered=state.allFiles.filter(file=>{
    const hasAI   = !!ai[file.name];
    const aiHasSig= hasAI && ai[file.name].has_signatures;
    if(f==='all')       return true;
    if(f==='signature') return file.has_signature;
    if(f==='ai')        return hasAI;
    if(f==='hit')       return file.has_signature && hasAI && aiHasSig;   // TP
    if(f==='miss')      return file.has_signature && hasAI && !aiHasSig;  // FN
    if(f==='skewed')    return state.fileLabels[file.name]==='偏' || state.fileLabels[file.name]==='partial';
    return true;
  });
  state.page=1; renderFileList(); renderPagination();
}

function renderFileList(){
  const start=(state.page-1)*state.pageSize;
  const slice=state.filtered.slice(start,start+state.pageSize);
  fileList.innerHTML='';
  if(!slice.length){fileList.innerHTML='<li style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">无匹配文件</li>';return;}
  slice.forEach(file=>{
    const li=document.createElement('li');
    li.className='file-item'+(state.currentFile===file.name?' active':'');
    li.dataset.name=file.name;
    const aiResult = state.aiResultsAll[file.name];
    const badges=[];
    if(file.has_signature) badges.push(`<span class="badge badge-sig">✍ ${file.sig_count}</span>`);
    if(file.has_logo)      badges.push(`<span class="badge badge-logo">◈ ${file.logo_count}</span>`);
    if(aiResult) badges.push(`<span class="badge badge-ai" title="${aiResult.model||'AI'} · ${aiResult.scale?Math.round(aiResult.scale*100)+'%':''}">AI</span>`);
    li.innerHTML=`<span class="file-item-name" title="${file.name}">${file.name}</span><span class="file-badges">${badges.join('')}</span>`;
    li.addEventListener('click',()=>loadFile(file.name));
    fileList.appendChild(li);
  });
}

function renderPagination(){
  const total=state.filtered.length, pages=Math.ceil(total/state.pageSize);
  pagination.innerHTML='';
  if(pages<=1) return;
  const addBtn=(label,page,disabled=false)=>{
    const btn=document.createElement('button');
    btn.className='page-btn'+(page===state.page?' active':'');
    btn.textContent=label; btn.disabled=disabled;
    btn.addEventListener('click',()=>{state.page=page;renderFileList();renderPagination();});
    pagination.appendChild(btn);
  };
  addBtn('‹',state.page-1,state.page===1);
  const w=2,lo=Math.max(1,state.page-w),hi=Math.min(pages,state.page+w);
  if(lo>1){addBtn('1',1);if(lo>2){const e=document.createElement('span');e.className='page-info';e.textContent='…';pagination.appendChild(e);}}
  for(let p=lo;p<=hi;p++) addBtn(String(p),p);
  if(hi<pages){if(hi<pages-1){const e=document.createElement('span');e.className='page-info';e.textContent='…';pagination.appendChild(e);}addBtn(String(pages),pages);}
  addBtn('›',state.page+1,state.page===pages);
  const info=document.createElement('span');info.className='page-info';info.textContent=`${total} 条`;pagination.appendChild(info);
}

/* ── Load file ── */
async function loadFile(name){
  if(state.currentFile===name) return;
  state.currentFile=name;
  document.querySelectorAll('.file-item').forEach(li=>li.classList.toggle('active',li.dataset.name===name));
  viewerEmpty.hidden=true; viewerViewport.hidden=true; viewerLoading.hidden=false;
  $('loadingText').textContent='正在加载…';
  toolbarFilename.textContent=name;
  btnDetect.disabled=false;
  try{
    const [ann,,aiRes]=await Promise.all([
      fetch(`/api/annotations/${name}`).then(r=>r.json()),
      loadImage(name),
      fetch(`/api/results/${name}`).then(r=>r.json()),
    ]);
    state.annotations=ann; state.aiResults=aiRes;
    renderDetailPanel(name,ann); renderAISection(aiRes);
    updateFileLabel();
    drawBBoxes();
    viewerLoading.hidden=true; viewerViewport.hidden=false;
  }catch(e){$('loadingText').textContent='加载失败，请重试';}
}

function loadImage(name){
  return new Promise((resolve,reject)=>{
    $('loadingText').textContent='正在转换图片…';
    mainImage.onload=()=>{bboxCanvas.width=mainImage.naturalWidth;bboxCanvas.height=mainImage.naturalHeight;fitToContainer();resolve();};
    mainImage.onerror=reject;
    mainImage.src=`/api/image/${name}?t=${Date.now()}`;
  });
}

/* ── Zoom / pan ── */
function fitToContainer(){
  const cw=viewerContainer.clientWidth,ch=viewerContainer.clientHeight;
  const iw=mainImage.naturalWidth,ih=mainImage.naturalHeight;
  const zoom=Math.min(cw/iw,ch/ih)*0.92;
  state.zoom=zoom; state.panX=(cw-iw*zoom)/2; state.panY=(ch-ih*zoom)/2;
  applyTransform();
}
function applyTransform(){
  viewerViewport.style.transform=`translate(${state.panX}px,${state.panY}px) scale(${state.zoom})`;
  zoomLabel.textContent=Math.round(state.zoom*100)+'%';
}
function adjustZoom(factor){
  if(!state.currentFile) return;
  const cw=viewerContainer.clientWidth,ch=viewerContainer.clientHeight;
  const cx=cw/2,cy=ch/2;
  const newZoom=Math.max(0.05,Math.min(20,state.zoom*factor));
  const ratio=newZoom/state.zoom;
  state.panX=cx-ratio*(cx-state.panX); state.panY=cy-ratio*(cy-state.panY);
  state.zoom=newZoom; applyTransform();
}

function setupViewerInteraction(){
  viewerContainer.addEventListener('wheel',e=>{
    e.preventDefault();
    if(!state.currentFile) return;
    const factor=e.deltaY<0?1.12:1/1.12;
    const rect=viewerContainer.getBoundingClientRect();
    const mx=e.clientX-rect.left,my=e.clientY-rect.top;
    const newZoom=Math.max(0.05,Math.min(20,state.zoom*factor));
    const ratio=newZoom/state.zoom;
    state.panX=mx-ratio*(mx-state.panX); state.panY=my-ratio*(my-state.panY);
    state.zoom=newZoom; applyTransform();
  },{passive:false});
  viewerContainer.addEventListener('mousedown',e=>{
    if(e.button!==0) return;
    state.isDragging=true;
    state.dragStart={x:e.clientX,y:e.clientY};
    state.panAtDrag={x:state.panX,y:state.panY};
  });
  window.addEventListener('mousemove',e=>{
    if(!state.isDragging) return;
    state.panX=state.panAtDrag.x+(e.clientX-state.dragStart.x);
    state.panY=state.panAtDrag.y+(e.clientY-state.dragStart.y);
    applyTransform();
  });
  window.addEventListener('mouseup',()=>{state.isDragging=false;});
  bboxCanvas.addEventListener('mousemove',e=>{
    if(!state.annotations&&!state.aiResults) return;
    const rect=bboxCanvas.getBoundingClientRect();
    const sx=bboxCanvas.width/rect.width,sy=bboxCanvas.height/rect.height;
    detectHover((e.clientX-rect.left)*sx,(e.clientY-rect.top)*sy);
  });
  bboxCanvas.addEventListener('mouseleave',()=>{if(state.hoveredIdx!==null){state.hoveredIdx=null;drawBBoxes();syncDetailHighlight();}});
}

/* ── Hover ── */
function detectHover(cx,cy){
  const ann=state.annotations;
  let found=null;
  if(state.showSigs&&ann) ann.signatures.forEach((s,i)=>{if(cx>=s.col&&cx<=s.col+s.width&&cy>=s.row&&cy<=s.row+s.height) found={type:'sig',index:i};});
  if(!found&&state.showLogos&&ann) ann.logos.forEach((l,i)=>{if(cx>=l.col&&cx<=l.col+l.width&&cy>=l.row&&cy<=l.row+l.height) found={type:'logo',index:i};});
  if(!found&&state.showAI&&state.aiResults){
    const iw=mainImage.naturalWidth,ih=mainImage.naturalHeight;
    state.aiResults.signatures.forEach((s,i)=>{
      const x=s.x_pct/100*iw,y=s.y_pct/100*ih,w=s.w_pct/100*iw,h=s.h_pct/100*ih;
      if(cx>=x&&cx<=x+w&&cy>=y&&cy<=y+h) found={type:'ai',index:i};
    });
  }
  const prev=state.hoveredIdx;
  if(!(prev&&found&&prev.type===found.type&&prev.index===found.index)){
    state.hoveredIdx=found;
    bboxCanvas.style.cursor=found?'pointer':'crosshair';
    drawBBoxes(); syncDetailHighlight();
  }
}

/* ── Canvas drawing ── */
function drawBBoxes(){
  ctx.clearRect(0,0,bboxCanvas.width,bboxCanvas.height);
  const ann=state.annotations;
  if(ann){
    if(state.showLogos) ann.logos.forEach((l,i)=>drawBox(l.col,l.row,l.width,l.height,COL_LOGO,state.hoveredIdx?.type==='logo'&&state.hoveredIdx?.index===i,null,i));
    if(state.showSigs)  ann.signatures.forEach((s,i)=>drawBox(s.col,s.row,s.width,s.height,s.author_id?COL_SIG_KNOWN:COL_SIG_UNKNOWN,state.hoveredIdx?.type==='sig'&&state.hoveredIdx?.index===i,s.author_id||'未知',i));
  }
  if(state.showAI&&state.aiResults){
    const iw=mainImage.naturalWidth,ih=mainImage.naturalHeight;
    state.aiResults.signatures.forEach((s,i)=>{
      const x=s.x_pct/100*iw,y=s.y_pct/100*ih,w=s.w_pct/100*iw,h=s.h_pct/100*ih;
      drawBox(x,y,w,h,COL_AI,state.hoveredIdx?.type==='ai'&&state.hoveredIdx?.index===i,`AI #${i+1}`,i);
    });
  }
}

function drawBox(x,y,w,h,col,hovered,label,idx){
  const lw=hovered?3:1.5;
  ctx.fillStyle=hovered?col.fill.replace(/[\d.]+\)$/,m=>Math.min(1,parseFloat(m)*3)+')'):col.fill;
  ctx.fillRect(x,y,w,h);
  ctx.strokeStyle=col.stroke; ctx.lineWidth=lw;
  ctx.strokeRect(x+lw/2,y+lw/2,w-lw,h-lw);
  if(label!==null&&(hovered||w>80)){
    const fs=Math.max(11,Math.min(18,w/10));
    ctx.font=`600 ${fs}px Inter,sans-serif`;
    ctx.textBaseline='top';
    const tw=ctx.measureText(label).width;
    const tx=x+4,ty=y-fs-3<0?y+3:y-fs-3;
    ctx.fillStyle='rgba(13,15,26,.75)';
    ctx.beginPath(); ctx.roundRect(tx-3,ty-2,tw+6,fs+4,3); ctx.fill();
    ctx.fillStyle=col.stroke; ctx.fillText(label,tx,ty);
  }
}

/* ── Detail panel ── */
function renderDetailPanel(name,ann){
  detailEmpty.hidden=true; detailContent.hidden=false;
  detailFileName.textContent=name+'.tif';
  detailMeta.textContent=ann.page_width?`${ann.page_width} × ${ann.page_height} px　|　${ann.signatures.length} 签名　${ann.logos.length} Logo`:'';
  sigCountBadge.textContent=ann.signatures.length;
  logoCountBadge.textContent=ann.logos.length;
  sigList.innerHTML='';
  if(!ann.signatures.length) sigList.innerHTML='<li class="ann-empty">无签名标注</li>';
  else ann.signatures.forEach((s,i)=>{
    const li=document.createElement('li');
    li.className='ann-item'; li.dataset.type='sig'; li.dataset.index=i;
    li.innerHTML=`<div class="ann-author ${s.author_id?'':'unknown'}">${s.author_id||'（未知签名人）'}</div><div class="ann-coords">x:${s.col} y:${s.row} &nbsp;${s.width}×${s.height}px</div>`;
    li.addEventListener('mouseenter',()=>setHoverFromDetail('sig',i));
    li.addEventListener('mouseleave',clearHoverFromDetail);
    sigList.appendChild(li);
  });
  logoList.innerHTML='';
  if(!ann.logos.length) logoList.innerHTML='<li class="ann-empty">无 Logo 标注</li>';
  else ann.logos.forEach((l,i)=>{
    const li=document.createElement('li');
    li.className='ann-item logo'; li.dataset.type='logo'; li.dataset.index=i;
    li.innerHTML=`<div class="ann-author">Logo #${i+1}</div><div class="ann-coords">x:${l.col} y:${l.row} &nbsp;${l.width}×${l.height}px</div>`;
    li.addEventListener('mouseenter',()=>setHoverFromDetail('logo',i));
    li.addEventListener('mouseleave',clearHoverFromDetail);
    logoList.appendChild(li);
  });
}

function renderAISection(aiRes){
  if(!aiRes){
    aiSection.hidden=true;
    aiList.innerHTML='';
    return;
  }
  aiSection.hidden=false;
  const sigs = aiRes.signatures || [];
  aiCountBadge.textContent = sigs.length;

  // Meta info: model / scale / time
  let metaEl = document.getElementById('aiMeta');
  if(!metaEl){
    metaEl = document.createElement('div');
    metaEl.id = 'aiMeta';
    metaEl.className = 'ai-meta';
    aiSection.insertBefore(metaEl, aiList);
  }
  const ts = aiRes.detected_at ? new Date(aiRes.detected_at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
  const scaleLabel = aiRes.scale ? Math.round(aiRes.scale*100)+'%' : '—';
  metaEl.innerHTML =
    `<span class="ai-meta-model" title="使用的模型">${aiRes.model||'—'}</span>`+
    `<span class="ai-meta-tag">分辨率 ${scaleLabel}</span>`+
    `<span class="ai-meta-tag">${ts}</span>`;

  aiList.innerHTML='';
  if(!sigs.length){
    aiList.innerHTML='<li class="ann-empty">模型未检测到签名</li>';
    return;
  }
  sigs.forEach((s,i)=>{
    const li=document.createElement('li');
    li.className='ann-item ai-item'; li.dataset.type='ai'; li.dataset.index=i;
    const conf = s.confidence!=null ? `<span class="ai-conf">${Math.round(s.confidence*100)}%</span>` : '';
    li.innerHTML=`<div class="ann-author">AI 签名 #${i+1} ${conf}</div>`+
      `<div class="ann-coords">${s.x_pct.toFixed(1)}%, ${s.y_pct.toFixed(1)}%  ${s.w_pct.toFixed(1)}×${s.h_pct.toFixed(1)}%</div>`;
    li.addEventListener('mouseenter',()=>setHoverFromDetail('ai',i));
    li.addEventListener('mouseleave',clearHoverFromDetail);
    aiList.appendChild(li);
  });
}

function setHoverFromDetail(type,index){state.hoveredIdx={type,index};drawBBoxes();syncDetailHighlight();scrollBBoxIntoView(type,index);}
function clearHoverFromDetail(){state.hoveredIdx=null;drawBBoxes();syncDetailHighlight();}
function syncDetailHighlight(){
  document.querySelectorAll('.ann-item').forEach(li=>{
    const match=state.hoveredIdx&&li.dataset.type===state.hoveredIdx.type&&parseInt(li.dataset.index)===state.hoveredIdx.index;
    li.classList.toggle('highlighted',match);
  });
}
function scrollBBoxIntoView(type,index){
  let col,row,width,height;
  const iw=mainImage.naturalWidth,ih=mainImage.naturalHeight;
  if(type==='ai'&&state.aiResults){
    const s=state.aiResults.signatures[index];
    col=s.x_pct/100*iw; row=s.y_pct/100*ih; width=s.w_pct/100*iw; height=s.h_pct/100*ih;
  } else {
    const ann=state.annotations;
    const b=type==='sig'?ann.signatures[index]:ann.logos[index];
    if(!b) return;
    col=b.col; row=b.row; width=b.width; height=b.height;
  }
  const cw=viewerContainer.clientWidth,ch=viewerContainer.clientHeight;
  const vx=state.panX+(col+width/2)*state.zoom;
  const vy=state.panY+(row+height/2)*state.zoom;
  if(vx<40||vx>cw-40||vy<40||vy>ch-40){
    state.panX=cw/2-(col+width/2)*state.zoom;
    state.panY=ch/2-(row+height/2)*state.zoom;
    applyTransform();
  }
}

/* ── AI Detection (single file) ── */
async function detectCurrentFile(){
  if(!state.currentFile) return;
  const cfg=getConfig();
  if(!cfg.apiUrl||!cfg.apiKey){showToast('请先在设置中填写 API 代理地址和 API Key');openSettings();return;}
  btnDetect.disabled=true; btnDetect.classList.add('running');
  try{
    const resp=await fetch(`/api/detect/${state.currentFile}`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({api_url:cfg.apiUrl,api_key:cfg.apiKey,model:cfg.model,scale:parseFloat(cfg.scale),prompt:cfg.prompt}),
    });
    const result=await resp.json();
    if(!resp.ok){
      const detail=result.raw?`\n原始返回: ${result.raw.slice(0,200)}`:''
      showToast('检测失败：'+(result.error||'未知错误')+detail);
      return;
    }
    state.aiResults=result;
    state.aiResultsAll[state.currentFile]=result;
    renderAISection(result); drawBBoxes(); renderFileList(); renderStats();
    updateFileLabel();
    if(!result.signatures||!result.signatures.length){
      showToast(`未检测到签名（模型返回 has_signatures=${result.has_signatures}）`,'warn');
    }
  }catch(e){showToast('请求失败：'+e.message);}
  finally{btnDetect.disabled=false;btnDetect.classList.remove('running');}
}

/* ── Stats ── */
let statsThreshold = 50; // percentage

function gtCoverage(gt, ai, pw, ph){
  if(!pw||!ph||!gt.width||!gt.height) return 0;
  const gx1=gt.col, gy1=gt.row, gx2=gx1+gt.width, gy2=gy1+gt.height;
  const ax1=ai.x_pct/100*pw, ay1=ai.y_pct/100*ph;
  const ax2=ax1+ai.w_pct/100*pw, ay2=ay1+ai.h_pct/100*ph;
  const ix1=Math.max(gx1,ax1), iy1=Math.max(gy1,ay1);
  const ix2=Math.min(gx2,ax2), iy2=Math.min(gy2,ay2);
  if(ix2<=ix1||iy2<=iy1) return 0;
  return (ix2-ix1)*(iy2-iy1)/(gt.width*gt.height);
}

function computeFileLabel(gt, aiRes){
  if(!aiRes) return null; // not AI-checked
  const gtSigs=gt.signatures||[], aiSigs=aiRes.signatures||[];
  const pw=gt.page_width||0, ph=gt.page_height||0;
  const thr=statsThreshold/100;
  if(!gtSigs.length&&!aiSigs.length) return{label:'TN',matched:0,total:0};
  if(!gtSigs.length) return{label:'FP',matched:0,total:0};
  if(!aiSigs.length) return{label:'FN',matched:0,total:gtSigs.length};
  // Greedy match
  const used=new Set(); let matched=0;
  for(const g of gtSigs){
    let best=0, bestI=-1;
    for(let i=0;i<aiSigs.length;i++){
      if(used.has(i)) continue;
      const c=gtCoverage(g,aiSigs[i],pw,ph);
      if(c>best){best=c;bestI=i;}
    }
    if(best>=thr&&bestI>=0){used.add(bestI);matched++;}
  }
  const label = matched===gtSigs.length?'TP': matched>0?'partial':'偏';
  return{label,matched,total:gtSigs.length};
}

const LABEL_TEXT = {
  TP:'✅ 正确命中', TN:'✅ 正确跳过',
  FP:'❌ 误报', FN:'❌ 漏检',
  partial:'⚠ 部分命中', '偏':'❌ 框位置偏', na:'— 未检测'
};

function updateFileLabel(){
  let el=document.getElementById('fileLabelBadge');
  if(!el){
    el=document.createElement('div');
    el.id='fileLabelBadge';
    el.className='file-label-badge na';
    const meta=document.getElementById('detailMeta');
    if(meta) meta.parentNode.insertBefore(el, meta.nextSibling);
  }
  if(!state.annotations||!state.aiResults){
    el.className='file-label-badge na'; el.textContent='— 未检测'; return;
  }
  const r=computeFileLabel(state.annotations,state.aiResults);
  if(!r){el.className='file-label-badge na';el.textContent='— 未检测';return;}
  el.className=`file-label-badge ${r.label}`;
  el.textContent=LABEL_TEXT[r.label]+(r.total>1?` (${r.matched}/${r.total})`:'');
}

function renderStatsScope(data, label){
  if(!data||!data.n) return `<div class="stats-scope"><div class="stats-scope-header"><span class="stats-scope-label">${label}</span></div><div class="stats-no-data">\u65e0\u5df2\u68c0\u6d4b\u6587\u4ef6</div></div>`;
  const rate=data.hit_rate;
  const cls=rate>=80?'good':rate>=60?'ok':'bad';
  const c=data.counts;
  const tags=['TP','TN','FN','FP','partial','偏'].map(k=>
    c[k]?`<span class="stats-tag ${k}">${LABEL_TEXT[k].replace(/[✅❌⚠] /,'')} ${c[k]}</span>`:''
  ).join('');
  const sub=[];
  if(data.box_recall!=null) sub.push(`<span>\u7b7e\u540d\u53ec\u56de\u7387 <b>${data.box_recall}%</b></span>`);
  if(data.avg_cov!=null)    sub.push(`<span>\u5e73\u5747GT\u8986\u76d6\u7387 <b>${data.avg_cov}%</b></span>`);
  return `<div class="stats-scope">
    <div class="stats-scope-header">
      <span class="stats-scope-label">${label}</span>
      <span class="stats-scope-n">${data.n} \u4e2a\u5df2\u68c0\u6d4b\u6587\u4ef6</span>
    </div>
    <div class="stats-scope-body">
      <div class="stats-hit-row">
        <div class="stats-hit-rate ${cls}">${rate}%</div>
        <div class="stats-breakdown">${tags}</div>
      </div>
      ${sub.length?`<div class="stats-sub">${sub.join('')}</div>`:''}
    </div>
  </div>`;
}

async function loadFileLabels(){
  try{
    const res=await fetch(`/api/stats?threshold=${statsThreshold}`);
    const data=await res.json();
    state.fileLabels={};
    (data.global?.files||[]).forEach(f=>{ state.fileLabels[f.name]=f.label; });
    // If currently on skewed filter, refresh list
    if(state.filter==='skewed') applyFilter();
  }catch(e){ console.warn('[loadFileLabels]',e); }
}
async function fetchAndRenderStats(){
  const grid=$('statsGrid');
  grid.innerHTML='<div class="stats-loading">\u6b63\u5728\u8ba1\u7b97\u2026</div>';
  const pageNames=getCurrentPageFiles().map(f=>f.name).join(',');
  try{
    const res=await fetch(`/api/stats?threshold=${statsThreshold}&names=${encodeURIComponent(pageNames)}`);
    const data=await res.json();
    grid.innerHTML=
      renderStatsScope(data.global,'\ud83c\udf10 \u5168\u5c40\uff08\u6240\u6709\u5df2\u68c0\u6d4b\u6587\u4ef6\uff09')+
      (data.page?renderStatsScope(data.page,`\ud83d\udcc4 \u5f53\u524d\u9875\uff08\u7b2c${state.page}\u9875\uff09`):'');
  }catch(e){
    grid.innerHTML=`<div class="stats-no-data">\u8ba1\u7b97\u5931\u8d25: ${e.message}</div>`;
  }
}

function openStats(){ $('statsOverlay').hidden=false; fetchAndRenderStats(); }
function closeStats(){ $('statsOverlay').hidden=true; }

function setupStats(){
  $('btnStats').addEventListener('click', openStats);
  $('btnCloseStats').addEventListener('click', closeStats);
  $('statsOverlay').addEventListener('click', e=>{ if(e.target===$('statsOverlay')) closeStats(); });
  $('thresholdSlider').addEventListener('input', e=>{
    statsThreshold=parseInt(e.target.value);
    $('thresholdVal').textContent=statsThreshold+'%';
    updateFileLabel();
    loadFileLabels();
    fetchAndRenderStats();
  });
}



function getCurrentPageFiles(){
  const start=(state.page-1)*state.pageSize;
  return state.filtered.slice(start,start+state.pageSize);
}

function openBatch(){
  const files=getCurrentPageFiles();
  const toRun=files.filter(f=>!state.aiResultsAll[f.name]);
  const skip=files.length-toRun.length;
  const totalPages = Math.ceil(state.filtered.length/state.pageSize);
  $('batchInfo').innerHTML=
    `仅检测<b>当前页</b>（第 ${state.page} / ${totalPages} 页）的 <b>${files.length}</b> 个文件。<br>`+
    `<span style="color:var(--text-muted);font-size:12px">如需检测其他页，切换页面后再次打开批量检测。</span>`;

  $('batchSkip').hidden=!skip;
  $('batchSkip').textContent=`跳过已检测 ${skip} 张，实际运行 ${toRun.length} 张`;
  $('progressWrap').hidden=true; $('batchError').hidden=true;
  $('btnStopBatch').hidden=true;
  $('btnStartBatchSkip').hidden=false;
  $('btnStartBatchForce').hidden = skip===0; // Hide force button if nothing is skipped

  $('btnStartBatchSkip').disabled = toRun.length===0;
  $('btnStartBatchForce').disabled = files.length===0;

  $('btnStartBatchSkip').textContent = skip>0?`仅检测新文件 (${toRun.length}张)`:`开始检测 (${files.length}张)`;
  $('btnStartBatchForce').textContent = `强制重跑全部 (${files.length}张)`;
  
  $('batchOverlay').hidden=false;
}
function closeBatch(){$('batchOverlay').hidden=true;}

async function runBatch(force=false){
  const cfg=getConfig();
  if(!cfg.apiUrl||!cfg.apiKey){showToast('请先在设置中填写 API 代理地址和 API Key');closeBatch();openSettings();return;}
  const files=getCurrentPageFiles();
  const toRun=force ? files : files.filter(f=>!state.aiResultsAll[f.name]);
  if(!toRun.length) return;
  state.batchRunning=true; state.batchStopped=false;
  $('btnStartBatchSkip').hidden=true; $('btnStartBatchForce').hidden=true; $('btnStopBatch').hidden=false;
  $('progressWrap').hidden=false; $('batchError').hidden=true;
  const fill=$('progressFill'),text=$('progressText');
  let done=0;
  for(const file of toRun){
    if(state.batchStopped) break;
    text.textContent=`${done} / ${toRun.length}　${file.name}`;
    try{
      const resp=await fetch(`/api/detect/${file.name}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({api_url:cfg.apiUrl,api_key:cfg.apiKey,model:cfg.model,scale:parseFloat(cfg.scale),prompt:cfg.prompt}),
      });
      const result=await resp.json();
      if(resp.ok){
        state.aiResultsAll[file.name]=result;
        if(state.currentFile===file.name){state.aiResults=result;renderAISection(result);drawBBoxes();}
      } else {
        $('batchError').hidden=false;
        $('batchError').textContent=`${file.name} 失败：${result.error||'未知'}`;
        console.error('[Batch]', file.name, result);
      }
    }catch(e){$('batchError').hidden=false;$('batchError').textContent=`${file.name} 请求失败: ${e.message}`;}
    done++;
    fill.style.width=(done/toRun.length*100)+'%';
    // 避免触发限流（429），每张之间等待 1 秒
    if(!state.batchStopped && done < toRun.length) await new Promise(r=>setTimeout(r,1000));

  }
  text.textContent=state.batchStopped?`已停止，完成 ${done} / ${toRun.length}`:`完成 ${done} / ${toRun.length}`;
  state.batchRunning=false;
  $('btnStopBatch').hidden=true;
  openBatch(); // re-initialize button states
  applyFilter(); renderStats();
}

/* ── Toolbar & settings setup ── */
function setupToolbar(){
  $('btnZoomIn').addEventListener('click',()=>adjustZoom(1.25));
  $('btnZoomOut').addEventListener('click',()=>adjustZoom(0.8));
  $('btnFit').addEventListener('click',()=>{if(state.currentFile) fitToContainer();});
  $('toggleSigs').addEventListener('change',e=>{state.showSigs=e.target.checked;drawBBoxes();});
  $('toggleLogos').addEventListener('change',e=>{state.showLogos=e.target.checked;drawBBoxes();});
  $('toggleAI').addEventListener('change',e=>{state.showAI=e.target.checked;drawBBoxes();});
  btnDetect.addEventListener('click',detectCurrentFile);
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active'); state.filter=tab.dataset.filter; applyFilter();
    });
  });
}
function setupSettings(){
  $('btnSettings').addEventListener('click',openSettings);
  $('btnCloseSettings').addEventListener('click',closeSettings);
  $('drawerOverlay').addEventListener('click',closeSettings);
  $('btnSaveSettings').addEventListener('click',saveConfig);
  $('btnFetchModels').addEventListener('click',fetchModels);
}
function setupBatch(){
  $('btnBatch').addEventListener('click',openBatch);
  $('btnCloseBatch').addEventListener('click',closeBatch);
  $('btnStartBatchSkip').addEventListener('click',()=>runBatch(false));
  $('btnStartBatchForce').addEventListener('click',()=>runBatch(true));
  $('btnStopBatch').addEventListener('click',()=>{state.batchStopped=true;$('btnStopBatch').disabled=true;});
}

init();
