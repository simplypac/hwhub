"use strict";
/* ================= Homework Hub — app ================= */

/* ---------- data ---------- */
const SOURCES = {
  ManageBac:{c:"#1F6FEB",short:"MB"}, Kognity:{c:"#7B3FE4",short:"K"}, K12net:{c:"#E07A00",short:"K12"},
  Padlet:{c:"#E0457B",short:"P"}, Classroom:{c:"#1E8E3E",short:"GC"}, Teams:{c:"#5B5FC7",short:"T"},
  WhatsApp:{c:"#1FA855",short:"WA"}, Email:{c:"#0A84FF",short:"@"}, Other:{c:"#8E8E93",short:"•"}
};
const PICKABLE = ["WhatsApp","ManageBac","Kognity","K12net","Padlet","Classroom","Teams","Email","Other"];
const SUBJECT_COLORS=["#FF9500","#34C759","#007AFF","#AF52DE","#FF2D55","#5AC8FA","#FFCC00","#5856D6","#A2845E","#00C7BE"];
let state={me:null,features:{},tasks:[],loaded:false,view:"today",src:null,seg:"all",weekSel:0,conns:null};
let brief=null;

function subjectColor(name){
  if(!name) return "var(--text3)";
  let h=0; for(const ch of name.toLowerCase()) h=(h*31+ch.charCodeAt(0))>>>0;
  return SUBJECT_COLORS[h%SUBJECT_COLORS.length];
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function iso(d){const p=n=>String(n).padStart(2,"0");return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`}
function relTime(ms){if(!ms)return "never";const m=Math.round((Date.now()-ms)/60000);if(m<1)return "just now";if(m<60)return m+" min ago";const h=Math.round(m/60);if(h<24)return h+" h ago";const d=Math.round(h/24);if(d<7)return d+" d ago";return new Date(ms).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- server ---------- */
async function api(method,path,body){
  let res;
  try{
    res=await fetch(path,{method,credentials:"same-origin",headers:{"X-Requested-With":"hh",...(body!==undefined?{"Content-Type":"application/json"}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  }catch(e){throw Object.assign(new Error("You're offline. Check your connection."),{code:"offline"})}
  let data=null; try{data=await res.json()}catch(e){}
  if(res.status===401&&!path.startsWith("/api/auth/")&&!path.startsWith("/api/me/password")&&!(path==="/api/me"&&method==="DELETE")){showAuth();throw Object.assign(new Error("Please sign in again."),{code:"signed_out"})}
  if(!res.ok) throw Object.assign(new Error((data&&data.message)||"Something went wrong."),{status:res.status,code:data&&data.error});
  return data;
}
async function loadTasks(){
  try{ state.tasks=await api("GET","/api/assignments"); state.loaded=true; if(!sheet.classList.contains("open")||state.view!=="sources") render(); }
  catch(e){ if(e.code!=="signed_out") toast(e.message) }
}
async function loadConns(){
  try{ state.conns=await api("GET","/api/connections"); if(state.view==="sources") render(); }
  catch(e){ if(e.code!=="signed_out") toast(e.message) }
}
function replaceTask(t){const i=state.tasks.findIndex(x=>x.id===t.id); if(i>=0) state.tasks[i]=t; else state.tasks.push(t)}


/* ---------- dates ---------- */
const DAY=86400000;
function startOfDay(d){const x=new Date(d);x.setHours(0,0,0,0);return x}
function dayDiff(d){return Math.round((startOfDay(d)-startOfDay(new Date()))/DAY)}
function parseDue(s){ if(!s) return null; const d=new Date(s); return isNaN(d)?null:d }
function timeStr(d){return d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}
function dueLabel(t){
  const d=parseDue(t.due); if(!d) return {txt:"No due date",cls:""};
  const diff=dayDiff(d), ms=d-new Date();
  let txt;
  if(diff===0) txt="Today, "+timeStr(d);
  else if(diff===1) txt="Tomorrow, "+timeStr(d);
  else if(diff===-1) txt="Yesterday, "+timeStr(d);
  else if(diff>1&&diff<7) txt=d.toLocaleDateString("en-GB",{weekday:"long"})+", "+timeStr(d);
  else txt=d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});
  let cls=""; if(!t.done){ if(ms<0) cls="late"; else if(ms<DAY) cls="soon"; }
  if(!t.done&&ms<0&&diff<0) txt="Overdue · "+txt.replace(/^Yesterday, /,"yesterday ");
  return {txt,cls};
}
function bucket(t){
  if(t.done) return "done";
  const d=parseDue(t.due); if(!d) return "nodate";
  if(d<new Date()) return "overdue";
  const diff=dayDiff(d);
  if(diff===0) return "today"; if(diff===1) return "tomorrow"; if(diff<7) return "week"; return "later";
}
function byDue(a,b){const x=parseDue(a.due),y=parseDue(b.due); if(!x&&!y) return 0; if(!x) return 1; if(!y) return -1; return x-y}



/* ---------- rendering ---------- */
const $=s=>document.querySelector(s);
const main=$("#main");
const I={
  chev:'<svg class="chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m1 1 6 6-6 6"/></svg>',
  tick:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  spark:'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5c.5 4.6 2.9 7 7.5 7.5-4.6.5-7 2.9-7.5 7.5-.5-4.6-2.9-7-7.5-7.5 4.6-.5 7-2.9 7.5-7.5Z"/><path d="M19 15c.2 2 1.1 2.9 3 3-1.9.2-2.8 1.1-3 3-.2-1.9-1.1-2.8-3-3 1.9-.1 2.8-1 3-3Z"/></svg>',
  x:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  mail:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fwd:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5l6 6-6 6"/><path d="M20 11H9a5 5 0 0 0-5 5v3"/></svg>',
  puzzle:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V6h4z"/></svg>',
  clock:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  cal:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke-linecap="round"/></svg>'
};

function srcPill(src){
  const s=SOURCES[src]||SOURCES.Other;
  return `<span class="src" style="color:${s.c};background:${s.c}1F">${esc(src||"Other")}</span>`;
}
function rowHTML(t){
  const d=dueLabel(t);
  return `<div class="row${t.done?" done":""}" data-id="${t.id}">
    <button class="check" data-act="toggle" aria-label="${t.done?"Mark as not done":"Mark as done"}: ${esc(t.title)}">${I.tick}</button>
    <div class="r-body" data-act="open" role="button" tabindex="0">
      <div class="r-meta">${srcPill(t.source)}<span class="due ${d.cls}">${esc(d.txt)}</span></div>
      <div class="r-title">${esc(t.title)}</div>
      ${t.subject||(t.reqs&&t.reqs.length)?`<div class="r-sub"><i class="sdot" style="background:${subjectColor(t.subject)}"></i><span>${esc(t.subject||"")}${t.subject&&t.reqs&&t.reqs.length?" · ":""}${t.reqs&&t.reqs.length?esc(t.reqs[0]):""}</span></div>`:""}
    </div>${I.chev}</div>`;
}
function section(title,tasks,opts={}){
  if(!tasks.length) return "";
  return `<div class="sec-head ${opts.cls||""}"><b>${title}</b><span class="count">${tasks.length}</span></div><div class="group">${tasks.map(rowHTML).join("")}</div>`;
}
function filtered(){ return state.tasks.filter(t=>!state.src||t.source===state.src) }

function chipsHTML(){
  const counts={}; state.tasks.filter(t=>!t.done).forEach(t=>counts[t.source]=(counts[t.source]||0)+1);
  const used=Object.keys(SOURCES).filter(k=>counts[k]);
  if(used.length<2&&!state.src) return "";
  return `<div class="chips" role="group" aria-label="Filter by platform">
    <button class="chip" data-src="" aria-pressed="${!state.src}">All</button>
    ${used.map(k=>`<button class="chip" data-src="${k}" aria-pressed="${state.src===k}"><i class="dot" style="background:${SOURCES[k].c}"></i>${k}<span class="n">${counts[k]}</span></button>`).join("")}
  </div>`;
}
function emptyHTML(title,body,{connect=false}={}){
  return `<div class="empty"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="1.6"><circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.3" stroke-linecap="round" stroke-linejoin="round"/></svg><h2>${title}</h2><p>${body}</p>
    ${connect?`<button class="pill-btn" data-go="sources">Connect your platforms</button> `:""}<button class="pill-btn" data-act="add">Add an assignment</button></div>`;
}
function hasAnyConnection(){const c=state.conns;return !!(c&&(c.managebac.connected||c.gmail.connected||c.forwarding.lastEmail||(c.extension.tokens||[]).length))}
function loadingHTML(){return `<div class="empty"><span class="spin" style="display:inline-block;border-color:var(--fill);border-top-color:var(--blue);width:24px;height:24px"></span></div>`}

function renderToday(){
  if(!state.loaded){main.innerHTML=loadingHTML();return}
  const ts=filtered();
  const overdue=ts.filter(t=>bucket(t)==="overdue").sort(byDue);
  const today=ts.filter(t=>bucket(t)==="today").sort(byDue);
  const tomorrow=ts.filter(t=>bucket(t)==="tomorrow").sort(byDue);
  const doneToday=ts.filter(t=>t.done&&parseDue(t.due)&&dayDiff(parseDue(t.due))===0);
  const totalToday=today.length+doneToday.length;
  const pct=totalToday?doneToday.length/totalToday:(today.length?0:1);
  const C=2*Math.PI*27;
  let title,sub;
  if(today.length){title=`${today.length} due today`;sub=overdue.length?`${overdue.length} overdue · ${tomorrow.length} tomorrow`:`${tomorrow.length} due tomorrow`}
  else if(overdue.length){title=`${overdue.length} overdue`;sub="Nothing else due today"}
  else {title="Nothing due today";sub=tomorrow.length?`${tomorrow.length} due tomorrow`:"You're all caught up"}
  const briefHTML = brief ? `<div class="brief"><div class="brief-head">${I.spark} Tonight's plan</div><p id="briefText">${esc(brief.text)}</p></div>` : "";
  const isNew=!state.tasks.length;
  main.innerHTML = `
    <div class="summary">
      <div class="ring" aria-hidden="true"><svg width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="none" stroke="var(--fill)" stroke-width="7"/><circle cx="32" cy="32" r="27" fill="none" stroke="var(--green)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C*(1-pct)}" style="transition:stroke-dashoffset .5s"/></svg><span class="num">${doneToday.length}/${totalToday}</span></div>
      <div class="sum-main"><div class="sum-title">${title}</div><div class="sum-sub">${sub}</div>
      ${state.features.ai&&(today.length||overdue.length||tomorrow.length)?`<button class="pill-btn" data-act="plan" ${brief&&brief.loading?"disabled":""}>${I.spark}${brief&&brief.loading?"Planning…":"Plan my evening"}</button>`:""}</div>
    </div>
    ${briefHTML}
    ${chipsHTML()}
    ${section("Overdue",overdue,{cls:"overdue"})}
    ${section("Due today",today)}
    ${section("Tomorrow",tomorrow)}
    ${isNew?emptyHTML("Let's get your homework in","Connect ManageBac and your school email once, and new assignments show up here by themselves.",{connect:true})
      :!overdue.length&&!today.length&&!tomorrow.length?emptyHTML("Clear for now","Nothing due today or tomorrow."):""}
    ${ts.some(t=>["week","later","nodate"].includes(bucket(t)))?`<button class="more" data-go="all">See everything coming up</button>`:""}
  `;
}
function renderAll(){
  if(!state.loaded){main.innerHTML=loadingHTML();return}
  const ts=filtered();
  const segs=[["all","Upcoming"],["done","Done"]];
  const b={}; ts.forEach(t=>{(b[bucket(t)]=b[bucket(t)]||[]).push(t)});
  Object.values(b).forEach(a=>a.sort(byDue));
  let body;
  if(state.seg==="done"){
    const d=(b.done||[]).sort((a,c)=>byDue(c,a));
    body = d.length?section("Completed",d)+`<button class="more" data-act="clear-done">Clear completed</button>`:`<div class="empty"><h2>Nothing done yet</h2><p>Tick an assignment and it moves here.</p></div>`;
  } else {
    body = section("Overdue",b.overdue||[],{cls:"overdue"})+section("Today",b.today||[])+section("Tomorrow",b.tomorrow||[])+section("This week",b.week||[])+section("Later",b.later||[])+section("No due date",b.nodate||[]);
    if(!body) body=emptyHTML("No assignments","Connect your platforms or add one by hand.",{connect:!state.tasks.length});
  }
  main.innerHTML = `${chipsHTML()}<div class="seg glass" role="group" data-key="list"><span class="seg-thumb"></span>${segs.map(([k,l])=>`<button data-seg="${k}" aria-pressed="${state.seg===k}">${l}</button>`).join("")}</div>${body}`;
}
function renderWeek(){
  if(!state.loaded){main.innerHTML=loadingHTML();return}
  const ts=filtered().filter(t=>!t.done);
  const days=[...Array(7)].map((_,i)=>{const d=new Date();d.setDate(d.getDate()+i);return d});
  const on=i=>ts.filter(t=>{const d=parseDue(t.due);return d&&dayDiff(d)===i}).sort(byDue);
  const sel=state.weekSel, selTasks=on(sel), selDate=days[sel];
  const busy=days.map((_,i)=>on(i).length).map((n,i)=>({n,i})).filter(x=>x.n>=3);
  const label=sel===0?"Today":sel===1?"Tomorrow":selDate.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"});
  main.innerHTML = `
    <div class="days" role="group" aria-label="Next 7 days">
      ${days.map((d,i)=>{const n=on(i).length;return `<button class="day${i===0?" today":""}${n>=3?" busy":""}" data-day="${i}" aria-pressed="${i===sel}" aria-label="${d.toDateString()}, ${n} due"><span class="wd">${d.toLocaleDateString("en-GB",{weekday:"short"}).slice(0,2)}</span><span class="dn">${d.getDate()}</span><span class="dots">${"<i></i>".repeat(Math.min(n,3))}</span></button>`}).join("")}
    </div>
    ${busy.length?`<div class="warn"><b>Heavy day${busy.length>1?"s":""}:</b> ${busy.map(x=>`${x.n} deadlines on ${x.i===0?"today":x.i===1?"tomorrow":days[x.i].toLocaleDateString("en-GB",{weekday:"long"})}`).join(", ")}. Start early on those.</div>`:""}
    ${selTasks.length?section(label,selTasks):`<div class="sec-head"><b>${esc(label)}</b></div><div class="group"><div class="row" style="color:var(--text2)">Nothing due.</div></div>`}
  `;
}

/* Settings: account, connections, appearance */
function connStatus(kind){
  const c=state.conns; if(!c) return {txt:"Loading…",cls:""};
  if(kind==="managebac"){
    const m=c.managebac; if(!m.connected) return {txt:"Connect your calendar",cls:""};
    if(m.status==="needs_attention") return {txt:"Needs a new link",cls:"err"};
    if(m.error) return {txt:"Last sync failed, retrying",cls:"warn"};
    return {txt:m.lastSync?`Synced ${relTime(m.lastSync)}`:"Connected, first sync running",cls:"ok"};
  }
  if(kind==="gmail"){
    const g=c.gmail; if(!g.connected) return {txt:"Read school emails automatically",cls:""};
    if(g.status==="needs_attention") return {txt:"Reconnect Gmail",cls:"err"};
    return {txt:`${g.email||"Connected"} · ${g.lastSync?"checked "+relTime(g.lastSync):"first check running"}`,cls:"ok"};
  }
  if(kind==="forwarding"){
    const f=c.forwarding;
    if(f.confirm) return {txt:"Gmail is waiting for you to confirm",cls:"warn"};
    if(f.lastEmail) return {txt:`Last email ${relTime(f.lastEmail)}`,cls:"ok"};
    return {txt:"Forward Kognity, K12net & Padlet emails",cls:""};
  }
  if(kind==="extension"){
    const n=(c.extension.tokens||[]).length;
    return n?{txt:`${n} key${n>1?"s":""} active`,cls:"ok"}:{txt:"Grab assignments from any open page",cls:""};
  }
  return {txt:"",cls:""};
}
function connRow(kind,name,color,icon){
  const s=connStatus(kind);
  return `<button class="conn-row" data-conn="${kind}"><span class="ico" style="background:${color}">${icon}</span><div class="t"><b>${name}</b><span class="${s.cls}">${esc(s.txt)}</span></div>${I.chev}</button>`;
}
function renderSettings(){
  const me=state.me||{}, c=state.conns, f=state.features;
  if(!c&&!renderSettings.loading){renderSettings.loading=true;loadConns().finally(()=>renderSettings.loading=false)}
  main.innerHTML = `
    <div class="group" style="margin-top:4px">
      <button class="conn-row" data-act="account"><span class="avatar">${esc((me.name||me.email||"?").trim()[0].toUpperCase())}</span><div class="t"><b>${esc(me.name||"Your account")}</b><span>${esc(me.email||"")}</span></div>${I.chev}</button>
    </div>
    <div class="sec-head"><b>Connections</b></div>
    <div class="group">
      ${connRow("managebac","ManageBac",SOURCES.ManageBac.c,"MB")}
      ${f.google?connRow("gmail","Gmail","#EA4335",I.mail):""}
      ${f.forwarding?connRow("forwarding","Email forwarding","#0A84FF",I.fwd):""}
      ${connRow("extension","Browser extension","#5856D6",I.puzzle)}
      <button class="conn-row" data-act="activity"><span class="ico" style="background:#8E8E93">${I.clock}</span><div class="t"><b>Recent activity</b><span>What came in and what was added</span></div>${I.chev}</button>
    </div>
    <p class="foot">${f.forwarding||f.google?"Kognity, K12net and Padlet come in through their notification emails.":"Ask whoever runs this server to turn on Gmail or email forwarding for Kognity, K12net and Padlet."}${f.ai?"":" AI reading is off on this server, so emails and pages are read with simpler rules."}</p>
    ${appearanceHTML()}
  `;
}
const TITLES={today:"Today",all:"All tasks",week:"This week",sources:"Settings"};
function render(){
  $("#title").textContent=TITLES[state.view];
  $("#date").textContent=new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"});
  document.querySelectorAll(".tab").forEach(b=>{if(b.dataset.view===state.view)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current")});
  ({today:renderToday,all:renderAll,week:renderWeek,sources:renderSettings})[state.view]();
  if(!swapping) placeLens(false);
  syncSegs(main);
}


/* ---------- theme ---------- */
const TKEY="hwhub.theme";
const mq=window.matchMedia("(prefers-color-scheme: dark)");
function getPref(){try{return localStorage.getItem(TKEY)||"auto"}catch(e){return "auto"}}
function effective(){const p=getPref();return p==="auto"?(mq.matches?"dark":"light"):p}
function applyTheme(animate){
  const root=document.documentElement,p=getPref();
  if(animate){root.classList.add("theming");setTimeout(()=>root.classList.remove("theming"),350)}
  if(p==="auto") delete root.dataset.theme; else root.dataset.theme=p;
  document.querySelector('meta[name="theme-color"]').content=effective()==="dark"?"#000000":"#F2F2F7";
}
function setPref(p){try{localStorage.setItem(TKEY,p)}catch(e){} applyTheme(true); if(state.view==="sources") render()}
mq.addEventListener&&mq.addEventListener("change",()=>{if(getPref()==="auto"){applyTheme(true);if(state.view==="sources")render()}});
function appearanceHTML(){
  const p=getPref(), eff=effective(), auto=p==="auto";
  const tick='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const tile=(k,label)=>`<button class="tile" role="radio" aria-checked="${eff===k}" data-theme-pick="${k}"><span class="phone ${k[0]}"><span class="scr"><b></b><i></i><i></i><i></i></span></span>${label}<span class="radio">${tick}</span></button>`;
  return `<div class="sec-head"><b>Appearance</b></div>
    <div class="appear">
      <div class="appear-tiles" role="radiogroup" aria-label="Appearance">${tile("light","Light")}${tile("dark","Dark")}</div>
      <div class="switch-row"><span id="autoLbl">Automatic</span><button class="switch" role="switch" aria-checked="${auto}" aria-labelledby="autoLbl" data-theme-auto></button></div>
    </div>
    <p class="foot">${auto?"Follows your device's light and dark setting.":"Picking Light or Dark turns off Automatic."}</p>`;
}


/* ---------- Liquid Glass motion ---------- */
const reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
// Moves a glass blob from one slot to another like a droplet: it stretches toward the target, then settles with a wobble.
function liquidMove(el,from,to,{dur=560}={}){
  el.getAnimations().forEach(a=>a.cancel());
  el.style.transform=`translateX(${to.x}px)`; el.style.width=to.w+"px";
  if(!from||reduceMotion||(Math.abs(from.x-to.x)<1&&Math.abs(from.w-to.w)<1)) return;
  const dir=Math.sign(to.x-from.x)||1, dist=Math.abs(to.x-from.x);
  const stretchW=Math.max(from.w,to.w)+dist*0.55;
  el.animate([
    {transform:`translateX(${from.x}px) scaleY(1)`,width:from.w+"px"},
    {offset:.38,transform:`translateX(${dir>0?from.x+dist*0.12:from.x+from.w-dist*0.12-stretchW}px) scaleY(.84)`,width:stretchW+"px"},
    {offset:.7,transform:`translateX(${to.x+dir*5}px) scaleY(1.06)`,width:(to.w*0.96)+"px"},
    {offset:.86,transform:`translateX(${to.x-dir*2}px) scaleY(.98)`,width:(to.w*1.02)+"px"},
    {transform:`translateX(${to.x}px) scaleY(1)`,width:to.w+"px"}
  ],{duration:dur,easing:"cubic-bezier(.25,.8,.3,1)"});
}
function slotOf(btn,container,inset=0){const c=container.getBoundingClientRect(),b=btn.getBoundingClientRect();return {x:b.left-c.left+inset,w:b.width-inset*2}}

// Tab lens
const tabsIn=document.querySelector(".tabs-in"), lens=document.querySelector(".lens");
let lensPos=null;
function placeLens(animate){
  const btn=document.querySelector(`.tab[data-view="${state.view}"]`); if(!btn) return;
  const to=slotOf(btn,tabsIn);
  liquidMove(lens,animate?lensPos:null,to); lensPos=to;
}
// Segmented controls
const segPrev={};
function syncSegs(root=document){
  root.querySelectorAll(".seg[data-key]").forEach(seg=>{
    const thumb=seg.querySelector(".seg-thumb"), btn=seg.querySelector('button[aria-pressed="true"]'); if(!thumb||!btn) return;
    const to=slotOf(btn,seg), key=seg.dataset.key;
    liquidMove(thumb,segPrev[key],to,{dur:480}); segPrev[key]=to;
  });
}
// Page change: old content melts out, new content condenses in.
let swapping=false;
function go(view,extra){
  if(view===state.view&&!extra) return;
  const apply=()=>{state.view=view; if(extra) extra(); render(); window.scrollTo(0,0)};
  if(reduceMotion||swapping){apply();return}
  swapping=true;
  const targets=[main,document.getElementById("title")];
  const out=targets.map(el=>el.animate([{opacity:1,filter:"blur(0px)",transform:"none"},{opacity:0,filter:"blur(8px)",transform:"scale(.97)"}],{duration:140,easing:"ease-in",fill:"forwards"}));
  // lens moves right away so it feels instant
  const prev=state.view; state.view=view; placeLens(true); state.view=prev;
  out[0].finished.then(()=>{
    apply(); out.forEach(a=>a.cancel());
    targets.forEach((el,i)=>el.animate([{opacity:0,filter:"blur(10px)",transform:"translateY(10px) scale(1.02)"},{opacity:1,filter:"blur(0px)",transform:"none"}],{duration:380+i*40,easing:"cubic-bezier(.2,.9,.25,1)"}));
    swapping=false;
  });
}
// Drag the lens across the bar, like iOS
(function(){
  let startX=0,dragging=false,suppress=false,pid=null;
  const tabs=[...document.querySelectorAll(".tab")];
  tabsIn.addEventListener("pointerdown",e=>{startX=e.clientX;dragging=false;pid=e.pointerId;lens.classList.add("lift")});
  tabsIn.addEventListener("pointermove",e=>{
    if(pid!==e.pointerId) return;
    if(!dragging&&Math.abs(e.clientX-startX)>6){dragging=true;tabsIn.setPointerCapture(pid);lens.getAnimations().forEach(a=>a.cancel())}
    if(!dragging) return;
    const c=tabsIn.getBoundingClientRect(), w=lensPos.w;
    const x=Math.max(4,Math.min(c.width-w-4,e.clientX-c.left-w/2));
    lens.style.transform=`translateX(${x}px)`; lensPos={x,w};
  });
  const end=e=>{
    if(pid!==e.pointerId) return; pid=null; lens.classList.remove("lift");
    if(!dragging) return;
    dragging=false; suppress=true; setTimeout(()=>suppress=false,50);
    const c=tabsIn.getBoundingClientRect(), mid=lensPos.x+lensPos.w/2+c.left;
    const near=tabs.reduce((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return Math.abs(ra.left+ra.width/2-mid)<Math.abs(rb.left+rb.width/2-mid)?a:b});
    if(near.dataset.view===state.view) placeLens(true); else go(near.dataset.view,()=>{if(near.dataset.view!=="all")state.seg="all"});
  };
  tabsIn.addEventListener("pointerup",end); tabsIn.addEventListener("pointercancel",end);
  tabs.forEach(b=>b.addEventListener("click",e=>{if(suppress){e.preventDefault();return} go(b.dataset.view,()=>{if(b.dataset.view!=="all")state.seg="all"})}));
})();
addEventListener("resize",()=>{placeLens(false);Object.keys(segPrev).forEach(k=>delete segPrev[k]);syncSegs()});


/* ---------- Real refraction (Chromium): an SVG displacement lens used as backdrop-filter ---------- */
const lensSupported=/Chrome|Chromium|Edg\//.test(navigator.userAgent)&&!/Firefox/.test(navigator.userAgent)&&CSS.supports("backdrop-filter","url(#x)");
const svgNS="http://www.w3.org/2000/svg";
const lensDefs=(()=>{const svg=document.createElementNS(svgNS,"svg");svg.setAttribute("width","0");svg.setAttribute("height","0");svg.style.position="absolute";svg.setAttribute("aria-hidden","true");const d=document.createElementNS(svgNS,"defs");svg.appendChild(d);document.body.appendChild(svg);return d})();
function displacementMap(w,h,r,bezel){
  const c=document.createElement("canvas");c.width=w;c.height=h;const ctx=c.getContext("2d");const img=ctx.createImageData(w,h);
  const hx=w/2,hy=h/2;
  const sdf=(x,y)=>{const qx=Math.abs(x-hx)-(hx-r),qy=Math.abs(y-hy)-(hy-r);return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const px=x+.5,py=y+.5,d=-sdf(px,py),i=(y*w+x)*4;
    let dx=0,dy=0;
    if(d>0&&d<bezel){
      const gx=sdf(px+1,py)-sdf(px-1,py),gy=sdf(px,py+1)-sdf(px,py-1),gl=Math.hypot(gx,gy)||1;
      const t=1-d/bezel, m=t*t*(3-2*t);           // smooth falloff from the rim inward
      dx=-(gx/gl)*m; dy=-(gy/gl)*m;               // sample inward: edges magnify and bend like a thick lens
    }
    img.data[i]=128+dx*127; img.data[i+1]=128+dy*127; img.data[i+2]=128; img.data[i+3]=255;
  }
  ctx.putImageData(img,0,0);return c.toDataURL();
}
let lensN=0;
function refract(el,{bezel=24,scale=72,blur=0.8,sat=1.8}={}){
  if(!lensSupported||!el) return;
  const w=Math.round(el.offsetWidth),h=Math.round(el.offsetHeight); if(!w||!h) return;
  const r=Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius)||0,h/2,w/2);
  const id=el.dataset.lensId||("lg"+(++lensN)); el.dataset.lensId=id;
  let f=document.getElementById(id); if(f) f.remove();
  f=document.createElementNS(svgNS,"filter");
  f.setAttribute("id",id);f.setAttribute("x","0");f.setAttribute("y","0");f.setAttribute("width",w);f.setAttribute("height",h);
  f.setAttribute("filterUnits","userSpaceOnUse");f.setAttribute("primitiveUnits","userSpaceOnUse");f.setAttribute("color-interpolation-filters","sRGB");
  f.innerHTML=`<feImage href="${displacementMap(w,h,r,Math.min(bezel,h/2))}" x="0" y="0" width="${w}" height="${h}" result="map"/>
    <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="soft"/>
    <feDisplacementMap in="soft" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="bent"/>
    <feColorMatrix in="bent" type="saturate" values="${sat}"/>`;
  lensDefs.appendChild(f);
  el.style.backdropFilter=`url(#${id})`; el.style.webkitBackdropFilter=`url(#${id})`;
  el.classList.add("refract");
}
function refractAll(){refract(document.querySelector(".tabs"));refract(document.querySelector(".fab"),{bezel:26,scale:60})}
addEventListener("resize",()=>{clearTimeout(refractAll.t);refractAll.t=setTimeout(refractAll,150)});


/* ---------- toast ---------- */
let toastT;
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove("show"),Math.min(5000,1600+String(msg).length*45))}



/* ---------- sheet ---------- */
const sheet=$("#sheet"), scrim=$("#scrim"), inner=$("#sheetInner");
let lastFocus=null, sheetCtl=null;
function openSheet(html,onMount){
  lastFocus=document.activeElement;
  inner.innerHTML=html; sheet.classList.add("open"); scrim.classList.add("open");
  inner.onclick=e=>{if(e.target.closest("[data-s=close]")) closeSheet()};
  onMount&&onMount(inner);
  requestAnimationFrame(()=>syncSegs(inner));
  setTimeout(()=>{const f=inner.querySelector("[autofocus]")||inner.querySelector("button");f&&f.focus({preventScroll:true})},60);
}
function closeSheet(){sheet.classList.remove("open");scrim.classList.remove("open");if(sheetCtl){sheetCtl.abort();sheetCtl=null}lastFocus&&lastFocus.focus&&lastFocus.focus({preventScroll:true})}
scrim.onclick=closeSheet;
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sheet.classList.contains("open")) closeSheet()});
const head=(title,{left="Close",right=""}={})=>`<div class="sheet-head"><button data-s="close">${left}</button><h3 id="sheetTitle">${title}</h3>${right||'<span style="min-width:60px"></span>'}</div>`;
function busy(btn,on,label){if(!btn)return;btn.disabled=on;if(on){btn.dataset.label=btn.innerHTML;btn.innerHTML=`<span class="spin"></span>${label||""}`}else if(btn.dataset.label){btn.innerHTML=btn.dataset.label}}

/* ---------- assignment detail ---------- */
function openDetail(id){
  const t=state.tasks.find(x=>x.id===id); if(!t) return;
  const d=dueLabel(t), due=parseDue(t.due);
  const moved=t.lastChange&&t.lastChange.changes&&t.lastChange.changes.find(c=>c.field==="due");
  openSheet(`${head("Assignment",{right:'<button data-s="edit">Edit</button>'})}
    <div class="sheet-body detail">
      ${srcPill(t.source)}
      <h2>${esc(t.title)}</h2>
      <div class="kv">
        <div><span>Subject</span><span>${esc(t.subject||"—")}</span></div>
        <div><span>Due</span><span class="due ${d.cls}" style="font-size:17px">${due?esc(due.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})+", "+timeStr(due)):"No due date"}</span></div>
        <div><span>Status</span><span>${t.done?"Done":"To do"}</span></div>
      </div>
      ${moved?`<div class="callout"><b>Deadline moved.</b> The teacher changed it from ${esc(new Date(moved.from).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}))} ${relTime(t.lastChange.at)}.</div>`:""}
      ${t.reqs&&t.reqs.length?`<div class="block"><h4>What to do</h4><ul style="margin-top:0">${t.reqs.map(r=>`<li>${esc(r)}</li>`).join("")}</ul></div>`:""}
      ${t.notes?`<div class="block"><h4>Details</h4><pre>${esc(t.notes)}</pre></div>`:""}
      ${t.confidence==="low"?`<p class="hint">This was picked up automatically and might not be homework. Delete it if it isn't.</p>`:""}
      ${t.link&&/^https:\/\//.test(t.link)?`<a class="secondary" href="${esc(t.link)}" target="_blank" rel="noopener">Open in ${esc(t.source==="Other"||t.source==="Email"?"browser":t.source)}</a>`:""}
      <button class="primary" data-s="toggle">${t.done?"Mark as not done":"Mark as done"}</button>
      <button class="ghost" data-s="delete">Delete assignment</button>
    </div>`, root=>{
      root.onclick=async e=>{
        const a=e.target.closest("[data-s]"); if(!a) return;
        const s=a.dataset.s;
        if(s==="close") closeSheet();
        if(s==="edit") openForm(t);
        if(s==="toggle"){closeSheet();toggleDone(t)}
        if(s==="delete"){
          if(!a.dataset.confirm){a.dataset.confirm="1";a.textContent="Tap again to delete";return}
          busy(a,true);
          try{await api("DELETE",`/api/assignments/${t.id}`);state.tasks=state.tasks.filter(x=>x.id!==t.id);render();closeSheet();toast("Deleted")}
          catch(err){busy(a,false);toast(err.message)}
        }
      };
    });
}
async function toggleDone(t){
  t.done=!t.done; render(); if(t.done) toast("Marked as done");
  try{replaceTask(await api("PATCH",`/api/assignments/${t.id}`,{done:t.done}))}
  catch(e){t.done=!t.done;render();toast(e.message)}
}

/* ---------- add / edit ---------- */
let addMode="paste", pasteSource="WhatsApp", extracted=[];
function subjectsList(){return [...new Set(state.tasks.map(t=>t.subject).filter(Boolean))].sort()}
function openAdd(){
  extracted=[];
  openSheet(`${head("Add assignment",{left:"Cancel"})}
    <div class="sheet-body">
      <div class="seg glass" role="group" data-key="add" style="margin:0 0 14px"><span class="seg-thumb"></span>
        <button data-mode="paste" aria-pressed="${addMode==="paste"}">Paste a message</button>
        <button data-mode="manual" aria-pressed="${addMode==="manual"}">Type it in</button>
      </div>
      <div id="addBody"></div>
    </div>`, root=>{
      root.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{addMode=b.dataset.mode;root.querySelectorAll("[data-mode]").forEach(x=>x.setAttribute("aria-pressed",x===b));syncSegs(root);drawAddBody()});
      delete segPrev.add;
      drawAddBody();
    });
}
function drawAddBody(){
  const body=$("#addBody");
  if(addMode==="manual"){ body.innerHTML=formFields({}); bindForm(body,null); return; }
  body.innerHTML=`
    <div class="src-pick" role="group" aria-label="Where is it from?">${PICKABLE.map(k=>`<button data-ps="${k}" aria-pressed="${pasteSource===k}">${k}</button>`).join("")}</div>
    <div class="field"><div><label for="pasteText">Teacher's message or post</label><textarea id="pasteText" autofocus maxlength="20000" placeholder="e.g. Grade 11 Econ: finish the IA commentary draft (max 800 words) and upload it to ManageBac by Thursday 11:59pm"></textarea></div></div>
    <button class="primary" id="extractBtn">Find assignments</button>
    <p class="hint" id="pasteHint">${state.features.ai?"Pulls out the task, subject, due date and requirements. English or Turkish.":"Finds the task and due date. Check the details before adding."}</p>
    <div id="previews"></div>`;
  body.querySelectorAll("[data-ps]").forEach(b=>b.onclick=()=>{pasteSource=b.dataset.ps;body.querySelectorAll("[data-ps]").forEach(x=>x.setAttribute("aria-pressed",x===b))});
  $("#extractBtn").onclick=extract;
}
function formFields(t){
  const dd=parseDue(t.due), due=dd?iso(dd):"";
  const src=t.source||(addMode==="paste"?pasteSource:"Other");
  return `
    <div class="field">
      <div><label for="fTitle">Assignment</label><input id="fTitle" autofocus maxlength="200" value="${esc(t.title||"")}" placeholder="What needs doing"></div>
      <div><label for="fSubject">Subject</label><input id="fSubject" maxlength="80" list="subjList" value="${esc(t.subject||"")}" placeholder="e.g. Chemistry SL"><datalist id="subjList">${subjectsList().map(s=>`<option value="${esc(s)}">`).join("")}</datalist></div>
      <div><label for="fDue">Due</label><input id="fDue" type="datetime-local" value="${esc(due)}"></div>
      <div><label for="fSource">Platform</label><select id="fSource">${PICKABLE.map(k=>`<option ${src===k?"selected":""}>${k}</option>`).join("")}</select></div>
    </div>
    <div class="field" style="margin-top:14px">
      <div><label for="fReqs">What to do (one per line)</label><textarea id="fReqs" style="min-height:80px" placeholder="800 words max&#10;Upload as PDF">${esc((t.reqs||[]).join("\n"))}</textarea></div>
      <div><label for="fNotes">Notes</label><textarea id="fNotes" style="min-height:60px" maxlength="4000">${esc(t.notes||"")}</textarea></div>
    </div>
    ${t.id&&t.source&&!["Other","WhatsApp"].includes(t.source)?`<p class="hint">Fields you change here won't be overwritten by future syncs.</p>`:""}
    <button class="primary" id="saveBtn">${t.id?"Save changes":"Add assignment"}</button>
    <p class="hint err" id="formErr" hidden></p>`;
}
function bindForm(root,existing){
  const btn=root.querySelector("#saveBtn");
  btn.onclick=async()=>{
    const err=root.querySelector("#formErr"); err.hidden=true;
    const title=root.querySelector("#fTitle").value.trim();
    if(!title){err.hidden=false;err.textContent="Give the assignment a name.";root.querySelector("#fTitle").focus();return}
    const dueVal=root.querySelector("#fDue").value;
    const data={title,subject:root.querySelector("#fSubject").value.trim(),due:dueVal?new Date(dueVal).toISOString():null,source:root.querySelector("#fSource").value,
      reqs:root.querySelector("#fReqs").value.split("\n").map(s=>s.trim()).filter(Boolean),notes:root.querySelector("#fNotes").value.trim()};
    busy(btn,true);
    try{
      if(existing){replaceTask(await api("PATCH",`/api/assignments/${existing.id}`,data));toast("Changes saved")}
      else{const r=await api("POST","/api/assignments",data);r.items.forEach(replaceTask);toast("Assignment added")}
      render();closeSheet();
    }catch(e){busy(btn,false);err.hidden=false;err.textContent=e.message}
  };
}
function openForm(t){
  openSheet(`${head("Edit assignment",{left:"Cancel"})}<div class="sheet-body" id="formBody">${formFields(t)}</div>`,root=>bindForm(root.querySelector("#formBody"),t));
}
async function extract(){
  const ta=$("#pasteText"), text=ta.value.trim(), hint=$("#pasteHint"), btn=$("#extractBtn");
  if(!text){hint.className="hint err";hint.textContent="Paste a message first.";ta.focus();return}
  busy(btn,true,"Reading the message…"); hint.className="hint"; hint.textContent=state.features.ai?"This usually takes a few seconds.":"";
  try{
    const r=await api("POST","/api/extract",{text,source:pasteSource});
    extracted=(r.items||[]).map(a=>({...a,reqs:a.reqs||[]}));
    drawPreviews();
    if(!extracted.length){hint.textContent="No assignment found in that message. Try adding more of the text, or use Type it in.";}
    else if(r.method==="rules"&&extracted.length===1){ // simple reader: let the student check everything in the form
      addMode="manual"; const b=$("#addBody"); b.innerHTML=formFields({...extracted[0]}); bindForm(b,null);
      document.querySelectorAll("[data-mode]").forEach(x=>x.setAttribute("aria-pressed",x.dataset.mode==="manual")); syncSegs(sheet);
      return;
    } else hint.textContent="Check these, remove any that are wrong, then add them.";
  }catch(e){hint.className="hint err";hint.textContent=e.message}
  finally{if(document.body.contains(btn)){busy(btn,false)}}
}
function drawPreviews(){
  const box=$("#previews"); if(!box) return;
  if(!extracted.length){box.innerHTML="";return}
  box.innerHTML=extracted.map((a,i)=>{const d=dueLabel(a);return `<div class="preview"><div class="pb">
      <div class="r-meta">${srcPill(a.source)}<span class="due ${d.cls}">${esc(d.txt)}</span></div>
      <div class="r-title" style="white-space:normal">${esc(a.title)}</div>
      ${a.subject?`<div class="r-sub"><i class="sdot" style="background:${subjectColor(a.subject)}"></i><span>${esc(a.subject)}</span></div>`:""}
      ${a.reqs.length?`<ul>${a.reqs.map(r=>`<li>${esc(r)}</li>`).join("")}</ul>`:""}
    </div><button class="x" data-rm="${i}" aria-label="Remove ${esc(a.title)}">${I.x}</button></div>`}).join("")
    +`<button class="primary" id="addAll">Add ${extracted.length} assignment${extracted.length>1?"s":""}</button>`;
  box.querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{extracted.splice(+b.dataset.rm,1);drawPreviews()});
  const addAll=$("#addAll");
  addAll.onclick=async()=>{
    busy(addAll,true);
    try{
      const r=await api("POST","/api/assignments",{items:extracted.map(a=>({title:a.title,subject:a.subject,due:a.due,reqs:a.reqs,source:a.source}))});
      r.items.forEach(replaceTask); extracted=[]; render(); closeSheet();
      const added=r.results.filter(x=>x.action==="added").length, matched=r.results.length-added;
      toast(matched?`${added} added, ${matched} matched one you had`:added>1?`${added} assignments added`:"Assignment added");
    }catch(e){busy(addAll,false);toast(e.message)}
  };
}

/* ---------- AI plan ---------- */
async function planEvening(){
  brief={text:"Thinking…",loading:true}; render();
  try{ const r=await api("POST","/api/plan"); brief={text:r.text,loading:false}; }
  catch(e){ brief={text:e.message,loading:false}; }
  render();
}



/* ---------- connections ---------- */
async function copyText(text,btn){
  try{await navigator.clipboard.writeText(text)}catch(e){const ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand("copy")}catch(_){}ta.remove()}
  if(btn){const o=btn.textContent;btn.textContent="Copied";setTimeout(()=>btn.textContent=o,1400)}
}
const copyBox=(value,id)=>`<div class="copy-box"><code id="${id}">${esc(value)}</code><button data-copy="${id}">Copy</button></div>`;
function bindCopies(root){root.querySelectorAll("[data-copy]").forEach(b=>b.onclick=()=>copyText(root.querySelector("#"+b.dataset.copy).textContent,b))}
function errText(e){return e&&e.message?e.message:"Something went wrong."}

function openConn(kind){({managebac:openManageBac,gmail:openGmail,forwarding:openForwarding,extension:openExtension})[kind]()}

function openManageBac(){
  const m=state.conns.managebac;
  const statusBlock=m.connected?`<div class="kv" style="margin-top:0">
      <div><span>Status</span><span class="${connStatus("managebac").cls==="ok"?"":""}">${esc(connStatus("managebac").txt)}</span></div>
      ${m.report?`<div><span>Last sync</span><span style="font-size:15px">${esc(m.report)}</span></div>`:""}
    </div>
    ${m.error?`<div class="callout"><b>Problem:</b> ${esc(m.error.message)}</div>`:""}
    <button class="primary" id="mbSync">Sync now</button>`:"";
  openSheet(`${head("ManageBac")}
    <div class="sheet-body">
      ${statusBlock}
      <div class="block"${m.connected?"":' style="margin-top:0"'}>
        <h4>${m.connected?"Use a different link":"Connect your ManageBac calendar"}</h4>
        <ol>
          <li>Open ManageBac in a browser and go to <b>Calendar</b>.</li>
          <li>Tap <b>Subscribe to Calendar</b> and copy the link.</li>
          <li>Paste it below. Deadlines your teachers set show up here automatically, checked every 30 minutes.</li>
        </ol>
      </div>
      <div class="field" style="margin-top:14px"><div><label for="mbUrl">Calendar link</label><input id="mbUrl" ${m.connected?"":"autofocus"} inputmode="url" autocomplete="off" spellcheck="false" placeholder="webcal://yourschool.managebac.com/…"></div></div>
      <button class="${m.connected?"secondary":"primary"}" id="mbSave">${m.connected?"Replace link":"Connect"}</button>
      <p class="hint" id="mbHint">The link is private to you, like a password. It's stored encrypted.</p>
      ${m.connected?`<button class="ghost" id="mbOff">Disconnect ManageBac</button>`:""}
    </div>`, root=>{
      const hint=root.querySelector("#mbHint");
      root.querySelector("#mbSave").onclick=async e=>{
        const url=root.querySelector("#mbUrl").value.trim();
        const btn=e.currentTarget;
        if(!url){hint.className="hint err";hint.textContent="Paste your calendar link first.";return}
        busy(btn,true,"Connecting…");
        try{
          const r=await api("POST","/api/connections/managebac",{url});
          const n=r.report?r.report.added.length:0;
          toast(n?`${n} assignment${n>1?"s":""} found in ManageBac`:"ManageBac connected");
          closeSheet(); await Promise.all([loadTasks(),loadConns()]);
        }catch(err){busy(btn,false);hint.className="hint err";hint.textContent=errText(err)}
      };
      const sync=root.querySelector("#mbSync");
      if(sync) sync.onclick=async()=>{busy(sync,true,"Syncing…");try{const r=await api("POST","/api/connections/managebac/sync");toast(r.notModified?"Already up to date":"ManageBac synced");closeSheet();await Promise.all([loadTasks(),loadConns()])}catch(err){busy(sync,false);toast(errText(err))}};
      const off=root.querySelector("#mbOff");
      if(off) off.onclick=async()=>{if(!off.dataset.c){off.dataset.c=1;off.textContent="Tap again to disconnect";return}try{await api("DELETE","/api/connections/managebac");toast("Disconnected. Your assignments stay.");closeSheet();loadConns()}catch(err){toast(errText(err))}};
    });
}

function openGmail(){
  const g=state.conns.gmail;
  openSheet(`${head("Gmail")}
    <div class="sheet-body">
      ${g.connected?`<div class="kv" style="margin-top:0">
          <div><span>Account</span><span>${esc(g.email||"Connected")}</span></div>
          <div><span>Checked</span><span>${esc(g.lastSync?relTime(g.lastSync):"Running first check")}</span></div>
          ${g.report?`<div><span>Last check</span><span style="font-size:15px">${esc(g.report)}</span></div>`:""}
        </div>
        ${g.status==="needs_attention"||g.error?`<div class="callout"><b>Problem:</b> ${esc(g.error?g.error.message:"Access expired.")}</div><a class="primary" href="/api/connect/google">Reconnect Gmail</a>`:`<button class="primary" id="gmSync">Check now</button>`}
        <button class="ghost" id="gmOff">Disconnect Gmail</button>`
      :`<div class="block" style="margin-top:0"><h4>What this does</h4>
          <p>Homework Hub reads only emails from ManageBac, Kognity, K12net, Padlet and Google Classroom, plus emails that mention homework or deadlines, and turns them into assignments. It can't send, delete or change anything.</p></div>
        <a class="primary" href="/api/connect/google">Connect Gmail</a>
        <p class="hint">Some schools block outside apps on school Google accounts. If Google says access is blocked, use Email forwarding instead.</p>`}
    </div>`, root=>{
      const s=root.querySelector("#gmSync");
      if(s) s.onclick=async()=>{busy(s,true,"Checking…");try{await api("POST","/api/connections/gmail/sync");toast("Gmail checked");closeSheet();await Promise.all([loadTasks(),loadConns()])}catch(err){busy(s,false);toast(errText(err))}};
      const off=root.querySelector("#gmOff");
      if(off) off.onclick=async()=>{if(!off.dataset.c){off.dataset.c=1;off.textContent="Tap again to disconnect";return}try{await api("DELETE","/api/connections/gmail");toast("Gmail disconnected");closeSheet();loadConns()}catch(err){toast(errText(err))}};
    });
}

const FILTER="from:(managebac.com OR kognity.com OR k12net.com OR padlet.com OR classroom.google.com)";
function openForwarding(){
  const f=state.conns.forwarding;
  openSheet(`${head("Email forwarding")}
    <div class="sheet-body">
      ${f.confirm?`<div class="callout"><b>Almost there.</b> Gmail sent a confirmation for ${esc(f.confirm.requester||"your address")}.
          ${f.confirm.code?`Your code is <b style="color:var(--text)">${esc(f.confirm.code)}</b>.`:""}</div>
        ${f.confirm.link?`<a class="primary" href="${esc(f.confirm.link)}" target="_blank" rel="noopener">Confirm in Gmail</a>`:""}
        <button class="secondary" id="fwDone">I've confirmed it</button>`
      :f.lastEmail?`<div class="callout good"><b>Working.</b> Last email arrived ${relTime(f.lastEmail)}.</div>`:""}
      <div class="block"><h4>Your personal address</h4><p>Anything sent here becomes assignments in your list. Keep it private.</p></div>
      ${copyBox(f.address||"","fwAddr")}
      <div class="block">
        <h4>Set it up in Gmail (once)</h4>
        <ol>
          <li>Gmail on a computer: <b>Settings</b> → <b>See all settings</b> → <b>Forwarding and POP/IMAP</b> → <b>Add a forwarding address</b>. Paste your address.</li>
          <li>Google sends a confirmation code to it. It appears on this screen within a minute. Confirm it.</li>
          <li>Search Gmail for the filter below, choose <b>Create filter</b>, tick <b>Forward it to</b> your address and <b>Also apply to matching conversations</b>.</li>
        </ol>
      </div>
      ${copyBox(FILTER,"fwFilter")}
      <div class="block"><h4>Using Outlook?</h4><p>Settings → Mail → <b>Rules</b> → new rule: if sender contains kognity.com, k12net.com, padlet.com or managebac.com → <b>Forward to</b> your address.</p></div>
      <div class="block"><h4>Got one email?</h4><p>Just forward it to your address. It works for a teacher's own email too.</p></div>
      <button class="ghost" id="fwNew" style="color:var(--blue)">Get a new address</button>
    </div>`, root=>{
      bindCopies(root);
      const done=root.querySelector("#fwDone");
      if(done) done.onclick=async()=>{try{await api("POST","/api/connections/forwarding/dismiss");closeSheet();loadConns()}catch(err){toast(errText(err))}};
      const nw=root.querySelector("#fwNew");
      nw.onclick=async()=>{if(!nw.dataset.c){nw.dataset.c=1;nw.textContent="Tap again: the old address stops working";return}
        try{await api("POST","/api/connections/forwarding/rotate");toast("New address ready. Update your Gmail forwarding.");await loadConns();openForwarding()}catch(err){toast(errText(err))}};
    });
}

function openExtension(){
  const toks=state.conns.extension.tokens||[];
  openSheet(`${head("Browser extension")}
    <div class="sheet-body">
      <div class="block" style="margin-top:0"><h4>For pages that don't send emails</h4>
        <p>Open your assignments page in Kognity, K12net or Padlet, click the Homework Hub extension, and it adds what's on the screen. It uses the page you're already signed in to, so it never needs your school password.</p></div>
      <div class="block"><h4>Install (Chrome or Edge, on a computer)</h4>
        <ol>
          <li>Download the extension below and unzip it.</li>
          <li>Go to <b>chrome://extensions</b>, turn on <b>Developer mode</b>, click <b>Load unpacked</b> and pick the unzipped folder.</li>
          <li>Create a key here and paste it into the extension with this address:</li>
        </ol>
      </div>
      ${copyBox(location.origin,"exOrigin")}
      <a class="secondary" href="/homework-hub-extension.zip" download>Download extension</a>
      <button class="primary" id="exNew">Create extension key</button>
      <div id="exToken"></div>
      ${toks.length?`<div class="sec-head"><b>Active keys</b></div><div class="group">${toks.map(t=>`<div class="conn-row" style="cursor:default"><div class="t"><b>${esc(t.name)}</b><span>${t.last_used?"Used "+relTime(t.last_used):"Never used"} · made ${relTime(t.created_at)}</span></div><button class="pill-btn" style="margin:0;color:var(--red);background:rgba(255,59,48,.12)" data-rmtok="${t.id}">Remove</button></div>`).join("")}</div>`:""}
    </div>`, root=>{
      bindCopies(root);
      const nb=root.querySelector("#exNew");
      nb.onclick=async()=>{busy(nb,true);try{const r=await api("POST","/api/tokens",{name:"Browser extension"});
        root.querySelector("#exToken").innerHTML=`<p class="hint">Copy this now. For safety it won't be shown again.</p>${copyBox(r.token,"exTok")}`;bindCopies(root);nb.hidden=true;loadConns()}
        catch(err){busy(nb,false);toast(errText(err))}};
      root.querySelectorAll("[data-rmtok]").forEach(b=>b.onclick=async()=>{try{await api("DELETE",`/api/tokens/${b.dataset.rmtok}`);await loadConns();openExtension()}catch(err){toast(errText(err))}});
    });
}

async function openActivity(){
  openSheet(`${head("Recent activity")}<div class="sheet-body" id="actBody">${loadingHTML()}</div>`);
  try{
    const rows=await api("GET","/api/activity");
    const label={managebac:"ManageBac",gmail:"Gmail",email:"Email",page:"Extension"};
    $("#actBody").innerHTML=rows.length?`<div class="group">${rows.map(r=>`<div class="act-row"><span class="tag">${esc(label[r.channel]||r.channel)} · ${esc(r.status==="ok"?"added":r.status==="confirm"?"confirmation":r.status)}</span><div>${esc(r.summary)}</div><small>${relTime(r.received_at)}</small></div>`).join("")}</div>`
      :`<div class="empty"><h2>Nothing yet</h2><p>Once a connection brings something in, you'll see it here.</p></div>`;
  }catch(e){$("#actBody").innerHTML=`<p class="hint err">${esc(e.message)}</p>`}
}

/* ---------- account ---------- */
function openAccount(){
  const me=state.me;
  openSheet(`${head("Account")}
    <div class="sheet-body">
      <div class="field">
        <div><label for="acName">Name</label><input id="acName" maxlength="60" value="${esc(me.name||"")}"></div>
        <div><label>Email</label><input value="${esc(me.email)}" disabled></div>
        <div><label for="acTz">Time zone</label><input id="acTz" value="${esc(me.tz)}" spellcheck="false"></div>
      </div>
      <button class="secondary" id="acSave">Save</button>
      <div class="sec-head"><b>Change password</b></div>
      <div class="field">
        <div><label for="pwCur">Current password</label><input id="pwCur" type="password" autocomplete="current-password"></div>
        <div><label for="pwNew">New password</label><input id="pwNew" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      </div>
      <button class="secondary" id="pwSave">Change password</button>
      <p class="hint" id="acHint"></p>
      <button class="primary" id="acOut" style="margin-top:22px">Sign out</button>
      <button class="ghost" id="acDel">Delete account</button>
      <div id="delBox" hidden>
        <p class="hint">This deletes your account, every assignment and all connections. It can't be undone.</p>
        <div class="field"><div><label for="delPw">Password to confirm</label><input id="delPw" type="password" autocomplete="current-password"></div></div>
        <button class="ghost" id="delGo">Delete everything</button>
      </div>
    </div>`, root=>{
      const hint=root.querySelector("#acHint");
      const say=(t,bad)=>{hint.className=bad?"hint err":"hint";hint.textContent=t};
      root.querySelector("#acSave").onclick=async e=>{const btn=e.currentTarget;busy(btn,true);try{const r=await api("PATCH","/api/me",{name:root.querySelector("#acName").value,tz:root.querySelector("#acTz").value.trim()});state.me=r.user;toast("Saved");closeSheet();render()}catch(err){busy(btn,false);say(errText(err),1)}};
      root.querySelector("#pwSave").onclick=async e=>{const btn=e.currentTarget;busy(btn,true);try{await api("POST","/api/me/password",{current:root.querySelector("#pwCur").value,password:root.querySelector("#pwNew").value});busy(btn,false);root.querySelector("#pwCur").value=root.querySelector("#pwNew").value="";say("Password changed. Other devices were signed out.")}catch(err){busy(btn,false);say(errText(err),1)}};
      root.querySelector("#acOut").onclick=async()=>{try{await api("POST","/api/auth/logout")}catch(e){} closeSheet(); showAuth()};
      root.querySelector("#acDel").onclick=e=>{e.currentTarget.hidden=true;root.querySelector("#delBox").hidden=false;root.querySelector("#delPw").focus()};
      root.querySelector("#delGo").onclick=async e=>{const btn=e.currentTarget;busy(btn,true);try{await api("DELETE","/api/me",{password:root.querySelector("#delPw").value});closeSheet();state.tasks=[];showAuth();toast("Account deleted")}catch(err){busy(btn,false);say(errText(err),1)}};
    });
}

/* ---------- sign in / create account ---------- */
let authMode="login";
function setAuthMode(m){
  authMode=m;
  document.querySelectorAll("[data-auth]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.auth===m));
  $("#nameField").hidden=m!=="signup";
  $("#authTitle").textContent=m==="signup"?"Create your account":"Welcome back";
  $("#authSub").textContent=m==="signup"?"Takes 20 seconds. Then connect your platforms.":"All your homework, one list.";
  $("#authBtn").textContent=m==="signup"?"Create account":"Sign in";
  $("#aPass").autocomplete=m==="signup"?"new-password":"current-password";
  $("#authErr").hidden=true;
  syncSegs($("#auth"));
}
function showAuth(){
  state.me=null; state.tasks=[]; state.loaded=false; state.conns=null; brief=null;
  $("#splash").hidden=true; $("#app").hidden=true; $("#auth").hidden=false;
  delete segPrev.auth; setAuthMode("login");
}
document.querySelectorAll("[data-auth]").forEach(b=>b.onclick=()=>setAuthMode(b.dataset.auth));
$("#authForm").onsubmit=async e=>{
  e.preventDefault();
  const err=$("#authErr"), btn=$("#authBtn"); err.hidden=true;
  const email=$("#aEmail").value.trim(), password=$("#aPass").value, name=$("#aName").value.trim();
  const fail=m=>{err.hidden=false;err.textContent=m};
  if(!/^\S+@\S+\.\S+$/.test(email)) return fail("Enter your email address.");
  if(password.length<8) return fail(authMode==="signup"?"Use at least 8 characters for your password.":"Enter your password.");
  busy(btn,true);
  try{
    const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r=await api("POST",authMode==="signup"?"/api/auth/signup":"/api/auth/login",{email,password,name,tz});
    $("#aPass").value="";
    const me=await api("GET","/api/me"); state.features=me.features||{};
    await startApp(r.user, authMode==="signup");
  }catch(ex){fail(ex.message)}
  finally{busy(btn,false)}
};

/* ---------- events ---------- */
main.addEventListener("click",e=>{
  const th=e.target.closest("[data-theme-pick],[data-theme-auto]");
  if(th){ if(th.dataset.themePick) setPref(th.dataset.themePick); else setPref(getPref()==="auto"?effective():"auto"); return; }
  const conn=e.target.closest("[data-conn]"); if(conn){ if(state.conns) openConn(conn.dataset.conn); return; }
  const el=e.target.closest("[data-act],[data-src],[data-seg],[data-day],[data-go]"); if(!el) return;
  if(el.dataset.src!==undefined){state.src=el.dataset.src||null;render();return}
  if(el.dataset.seg){state.seg=el.dataset.seg;render();return}
  if(el.dataset.day!==undefined){state.weekSel=+el.dataset.day;render();return}
  if(el.dataset.go){go(el.dataset.go,()=>{state.seg="all"});return}
  const act=el.dataset.act, row=el.closest(".row"), id=row&&row.dataset.id;
  if(act==="toggle"){const t=state.tasks.find(x=>x.id===id); row.classList.toggle("done",!t.done); setTimeout(()=>toggleDone(t),t.done?0:350); return}
  if(act==="open"){openDetail(id);return}
  if(act==="add"){openAdd();return}
  if(act==="plan"){planEvening();return}
  if(act==="account"){openAccount();return}
  if(act==="activity"){openActivity();return}
  if(act==="clear-done"){
    const done=state.tasks.filter(t=>t.done);
    (async()=>{for(const t of done){try{await api("DELETE",`/api/assignments/${t.id}`)}catch(e){}} state.tasks=state.tasks.filter(t=>!t.done); render(); toast(`Cleared ${done.length} completed`)})();
  }
});
main.addEventListener("keydown",e=>{if((e.key==="Enter"||e.key===" ")&&e.target.matches(".r-body")){e.preventDefault();openDetail(e.target.closest(".row").dataset.id)}});
$("#addBtn").onclick=openAdd;

/* ---------- boot ---------- */
async function startApp(user,isNew){
  state.me=user; state.view=isNew?"sources":"today";
  $("#splash").hidden=true; $("#auth").hidden=true; $("#app").hidden=false;
  render(); requestAnimationFrame(()=>{placeLens(false);refractAll()});
  await Promise.all([loadTasks(),loadConns()]);
  if(isNew) toast("Account created. Connect your platforms next.");
}
async function boot(){
  applyTheme(false);
  try{
    const r=await api("GET","/api/me");
    state.features=r.features||{};
    const qs=new URLSearchParams(location.search);
    const connected=qs.get("connected"), error=qs.get("error");
    if(connected||error) history.replaceState(null,"",location.pathname);
    await startApp(r.user,false);
    if(connected==="gmail"){go("sources");toast("Gmail connected. Checking your inbox…");setTimeout(()=>{loadTasks();loadConns()},8000)}
    if(error) {go("sources");toast({google_cancelled:"Gmail connection was cancelled",google_state:"That sign-in expired. Try again.",scope_missing:"Tick the Gmail permission when connecting",no_refresh:"Google didn't give access. Try again.",google_not_configured:"Gmail isn't set up on this server"}[error]||"Couldn't connect Gmail")}
  }catch(e){
    if(e.code!=="signed_out"){ showAuth(); toast(e.message); }
  }
}
// Keep the list fresh: every minute while open, and whenever you come back to the app.
setInterval(()=>{if(state.me&&document.visibilityState==="visible"&&!sheet.classList.contains("open")) loadTasks()},60000);
document.addEventListener("visibilitychange",()=>{if(state.me&&document.visibilityState==="visible"){loadTasks();if(state.view==="sources")loadConns()}});
if("serviceWorker" in navigator&&(location.protocol==="https:"||location.hostname==="localhost")) navigator.serviceWorker.register("/sw.js").catch(()=>{});
boot();

