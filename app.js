// 島內散步｜產品與報價工具 — 應用邏輯（快照版原型）
(function(){
  const ALL = (window.PRODUCTS || []);
  const PROPOSALS = (window.PROPOSALS || []);
  const LS = "walkin_quote_v1";
  // 試用回饋：若日後建立 Google 表單，把網址填這裡即可改用表單；留空則用 email。
  const FEEDBACK_URL = "";
  const FEEDBACK_EMAIL = "chiuyi@walkin.tw";
  // 回存後端：用檔案(file://)開啟時為純試用版（不能回存）；經伺服器開啟則打同源 API。
  const API_BASE = (location.protocol === "file:") ? null : "";

  let view = "brief";
  let quote = load();
  let briefOn = true; // 「找產品」時是否依客戶需求自動篩選
  // 手動細篩（在需求結果中再搜尋）。預設只看主行程，元件可用下拉切換。
  let f = { kw:"", type:"產品", cat:"", onlyActive:true };
  // 過去提案搜尋條件
  let pf = { kw:"", city:"", duration:"", head:"", purpose:"" };

  const PURPOSES = ["員工旅遊","家庭日","Team Building","ESG／志工","文化學習","休閒放鬆","DEI 工作坊","講座／工作坊","外賓接待"];
  const DURATIONS = ["半日","一日","二日","三日"];
  // 縣市 → 產品資料的地區群組（產品地區只分這 4 群）
  const CITY_GROUP = {
    "台北市":"北/基/宜","新北市":"北/基/宜","基隆市":"北/基/宜","宜蘭縣":"北/基/宜",
    "桃園市":"桃/竹/苗/中","新竹縣市":"桃/竹/苗/中","苗栗縣":"桃/竹/苗/中","台中市":"桃/竹/苗/中",
    "彰化縣":"彰/雲/嘉/南","雲林縣":"彰/雲/嘉/南","嘉義縣市":"彰/雲/嘉/南","台南市":"彰/雲/嘉/南",
    "南投縣":"南投",
  };
  const CITIES = Object.keys(CITY_GROUP);
  let activeGroup = ""; // 新加入的元件預設歸到哪個行程段

  // 行程↔常用元件對照表（每條主行程的成本範本）
  const TPL_LS = "walkin_tour_templates_v1";
  function loadTpls(){ try{ return JSON.parse(localStorage.getItem(TPL_LS))||{}; }catch(e){ return {}; } }
  let TEMPLATES = loadTpls();
  function saveTplsLocal(){ localStorage.setItem(TPL_LS, JSON.stringify(TEMPLATES)); }
  // 逐條同步：記住「改過的(dirty)」與「刪掉的(deleted)」行程 id，連同各自版本(rev)上傳，由後端判斷衝突
  const tplDirty=new Set(), tplDeleted=new Set();
  const tplNotes={};   // 這次變更的「改了什麼」備註（依 id），送出後清掉
  function saveTpls(id){ if(id){ tplDirty.add(id); tplDeleted.delete(id); } saveTplsLocal(); schedulePush(); }
  // 不在本機先刪：保留到送出時才讀得到 rev（baseRev），伺服器確認後再以回傳結果覆蓋（軟刪除→archived）
  function delTpl(id){ tplDeleted.add(id); tplDirty.delete(id); if(TEMPLATES[id]) TEMPLATES[id]._pendingDel=true; saveTplsLocal(); schedulePush(); }
  let tplTour="", tplKw="";
  let tplDraft=null;     // 編輯草稿（=正在「建立新版本」）：{id,name,items}；null=唯讀檢視
  let tplHistOpen=false; // 是否展開版本歷史
  function fmtTime(epochSec){ if(!epochSec) return "—"; try{ return new Date(epochSec*1000).toLocaleString("zh-TW",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}); }catch(e){ return "—"; } }
  function modeLabel(mode,n){ const m=QTY_MODES.find(x=>x.v===mode); if(!m) return mode||""; return m.needN?`${m.l}（${m.nLabel}=${n||1}）`:m.l; }

  // ---- 範本雲端同步（只有部署版＝同源後端才啟用）----
  let tplSync = { state:"idle", msg:"" };   // idle|saving|saved|error|conflict
  function cloudEnabled(){ return API_BASE===""; }
  function hm(){ const d=new Date(); return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2); }
  function setSync(state,msg){ tplSync={state,msg}; const el=document.getElementById("tplSyncBadge"); if(el) el.outerHTML=syncBadgeHTML(); }
  function syncBadgeHTML(){
    if(!cloudEnabled()) return `<span id="tplSyncBadge" class="tag" style="background:#e5e7eb;color:#374151">📄 本機暫存（試用版不同步）</span>`;
    const map={idle:["#e0f2fe","#075985","☁︎ 雲端同步已開"],saving:["#fef9c3","#854d0e","⟳ "],saved:["#dcfce7","#166534","✓ "],error:["#fee2e2","#991b1b","⚠️ "],conflict:["#fef3c7","#92400e","⚠️ "]};
    const [bg,fg,pre]=map[tplSync.state]||map.idle;
    return `<span id="tplSyncBadge" class="tag" style="background:${bg};color:${fg}">${pre}${esc(tplSync.msg||"")}</span>`;
  }
  let _pushTimer=null;
  function schedulePush(){ if(!cloudEnabled()) return; if(!tplDirty.size && !tplDeleted.size) return; clearTimeout(_pushTimer); setSync("saving","同步中…"); _pushTimer=setTimeout(cloudPush,800); }
  async function cloudPush(){
    if(!cloudEnabled() || (!tplDirty.size && !tplDeleted.size)) return;
    // 收集這批要送的操作（帶各自的 baseRev＝本機載入時的版本）
    const ops=[];
    tplDirty.forEach(id=>{ const t=TEMPLATES[id]; if(t) ops.push({op:"upsert", id, name:t.name||"", items:t.items||[], baseRev:t.rev||0, note:tplNotes[id]||""}); });
    tplDeleted.forEach(id=>ops.push({op:"delete", id, baseRev:(TEMPLATES[id]&&TEMPLATES[id].rev)||0, note:tplNotes[id]||""}));
    [...tplDirty,...tplDeleted].forEach(id=>delete tplNotes[id]);
    const sentDirty=[...tplDirty], sentDeleted=[...tplDeleted];
    const localBefore=TEMPLATES;
    // 送出前先清標記；若同步期間又被編輯，會重新標記、下輪再送
    tplDirty.clear(); tplDeleted.clear();
    try{
      const res=await postJSON("/api/templates",{ops});
      if(res.templates){
        TEMPLATES=res.templates;
        // 同步期間又被改到的行程：保留本機版本（採用伺服器新版本號，避免誤判成自己跟自己衝突）
        tplDirty.forEach(id=>{ if(localBefore[id]){ const keep=localBefore[id]; if(res.templates[id]) keep.rev=res.templates[id].rev; TEMPLATES[id]=keep; } });
        tplDeleted.forEach(id=>delete TEMPLATES[id]);
        saveTplsLocal();
      }
      const conflicts=res.conflicts||[];
      if(conflicts.length){
        setSync("conflict","偵測到同時編輯，已另存新範本 "+hm());
        toast("⚠️ "+conflicts.map(c=>c.kept
          ? `「${c.baseName||c.id}」已被別人修改，刪除/變更未套用，請到範本總覽核對`
          : `「${c.baseName||c.id}」有人同時修改，你的版本已另存為新範本『${c.variantName}』，請到範本總覽核對`).join("；"));
      } else {
        setSync("saved","已同步雲端 "+hm());
      }
      if(view==="template") render();
      if(tplDirty.size||tplDeleted.size) schedulePush();   // 同步期間又有新編輯 → 再送一輪
    }catch(e){
      // 失敗：把這批標記放回去，下次重送，避免漏存
      sentDirty.forEach(id=>tplDirty.add(id)); sentDeleted.forEach(id=>tplDeleted.add(id));
      if(e&&e.status===401){ setSync("error","登入已過期，請重新登入"); gotoLogin(); }
      else setSync("error","雲端同步失敗（後端未啟動？）");
    }
  }
  async function cloudPull(){
    if(!cloudEnabled()) return;
    try{
      const r=await fetch(API_BASE+"/api/templates"); if(!r.ok) throw 0;
      const data=await r.json(); const cloud=data.templates||{};
      const cKeys=Object.keys(cloud), lKeys=Object.keys(TEMPLATES);
      if(cKeys.length){ TEMPLATES=cloud; saveTplsLocal(); setSync("saved","已從雲端載入 "+cKeys.length+" 條範本"); if(view==="template") render(); }
      else if(lKeys.length){ lKeys.forEach(id=>tplDirty.add(id)); await cloudPush(); }   // 雲端空、本機有 → 全部推上去當初始
      else { setSync("idle","雲端尚無範本，開始設定即會同步"); }
    }catch(e){ setSync("error","雲端載入失敗，先用本機資料"); }
  }
  // 還原已刪除的範本（送 restore op）
  function restoreTpl(id){
    requireLogin(async()=>{
      try{
        setSync("saving","還原中…");
        const res=await postJSON("/api/templates",{ops:[{op:"restore", id, baseRev:(TEMPLATES[id]&&TEMPLATES[id].rev)||0}]});
        if(res.templates){ TEMPLATES=res.templates; saveTplsLocal(); }
        setSync("saved","已還原 "+hm()); render(); toast("已還原範本");
      }catch(e){ if(e&&e.status===401){ gotoLogin(); } else setSync("error","還原失敗"); }
    });
  }

  // ---- 個人登入（整站需登入；登入頁由後端提供，這裡只認身分）----
  // 通行證是 HttpOnly cookie，由瀏覽器自動帶；前端只記住「我是誰」
  let AUTH=null;   // {user:{u,name,role}} 或 null
  let SRV={googleClientId:"",passwordLogin:false,domain:"walkin.tw"};
  function isLoggedIn(){ return !!(AUTH&&AUTH.user); }
  function isAdmin(){ return isLoggedIn() && AUTH.user.role==="admin"; }
  function meName(){ return (AUTH&&AUTH.user&&AUTH.user.name)||""; }
  async function loadServerConfig(){
    if(!cloudEnabled()) return;
    try{ const c=(((await (await fetch(API_BASE+"/api/health")).json())||{}).configured)||{};
      SRV.googleClientId=c.googleClientId||""; SRV.passwordLogin=!!c.passwordLogin; SRV.domain=c.domain||"walkin.tw"; }
    catch(e){}
  }
  async function loadMe(){
    if(!cloudEnabled()) return;
    try{ const d=await (await fetch(API_BASE+"/api/me")).json(); AUTH=d&&d.ok?{user:d.user}:null; }
    catch(e){ AUTH=null; }
  }
  async function logout(){
    try{ await fetch(API_BASE+"/api/logout",{method:"POST"}); }catch(e){}
    location.reload();   // 回到後端登入頁
  }
  // session 過期 → 回登入頁
  function gotoLogin(){ location.reload(); }
  // 整站已在後端擋登入：app 能載入＝已登入。單機(file://)免登入。
  function requireLogin(cb){ cb&&cb(); }
  // 帳號管理（僅密碼登入模式 + 管理員）：列出/新增帳號
  async function openUsersModal(){
    if(!isAdmin()) return;
    if(document.getElementById("usersMask")) return;
    const mask=document.createElement("div"); mask.id="usersMask";
    mask.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999";
    mask.innerHTML=`<div style="background:#fff;border-radius:12px;padding:24px;width:460px;max-width:94vw;max-height:88vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.25)">
      <div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">帳號管理</h3><button class="btn ghost sm" id="us_close">關閉</button></div>
      <div id="us_list" style="margin:12px 0;font-size:13px;color:var(--muted)">載入中…</div>
      <div style="border-top:1px solid var(--line);padding-top:12px">
        <div style="font-weight:600;margin-bottom:8px">新增帳號</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <label class="bfld"><span>帳號</span><input class="inp" id="us_u"></label>
          <label class="bfld"><span>顯示名字</span><input class="inp" id="us_n" placeholder="例：小美"></label>
          <label class="bfld"><span>密碼</span><input class="inp" id="us_p" type="text"></label>
          <label class="bfld"><span>角色</span><select class="inp" id="us_r"><option value="user">業務</option><option value="admin">管理員</option></select></label>
        </div>
        <div id="us_err" style="color:var(--danger);font-size:12.5px;min-height:18px;margin-top:6px"></div>
        <div style="text-align:right"><button class="btn" id="us_add">新增</button></div>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const close=()=>mask.remove();
    document.getElementById("us_close").onclick=close;
    mask.onclick=(e)=>{ if(e.target===mask) close(); };
    async function refresh(){
      const box=document.getElementById("us_list");
      try{
        const d=await (await fetch(API_BASE+"/api/users")).json();
        if(!d.ok){ box.textContent="讀取失敗："+(d.reason||""); return; }
        box.innerHTML=`<table style="width:100%"><thead><tr><th style="text-align:left">帳號</th><th style="text-align:left">名字</th><th style="text-align:left">角色</th></tr></thead><tbody>${
          d.users.map(u=>`<tr><td>${esc(u.u)}</td><td>${esc(u.name)}</td><td>${u.role==="admin"?"管理員":"業務"}</td></tr>`).join("")||'<tr><td colspan="3">尚無自建帳號</td></tr>'}</tbody></table>`;
      }catch(e){ box.textContent="讀取失敗（後端未啟動？）"; }
    }
    refresh();
    document.getElementById("us_add").onclick=async()=>{
      const err=document.getElementById("us_err"); err.textContent="";
      const u=document.getElementById("us_u").value.trim(), n=document.getElementById("us_n").value.trim();
      const p=document.getElementById("us_p").value, role=document.getElementById("us_r").value;
      if(!u||!p){ err.textContent="帳號與密碼必填"; return; }
      try{
        const res=await postJSON("/api/users",{username:u,name:n,password:p,role});
        if(res.ok){ toast("已新增帳號："+(n||u)); document.getElementById("us_u").value="";document.getElementById("us_n").value="";document.getElementById("us_p").value=""; refresh(); }
        else err.textContent=res.reason||"新增失敗";
      }catch(e){ err.textContent=(e&&e.data&&e.data.reason)||"新增失敗"; }
    };
  }

  // 數量規則：needN=該規則需要填一個數字 n（每N人1個的 N、或固定數量），nLabel 提示 n 是什麼
  const QTY_MODES=[
    {v:"perPerson",    l:"每人（×人數）",          needN:false},
    {v:"perPersonDay", l:"每人每天（×人數×天數）", needN:false},
    {v:"perGroup",     l:"每 N 人 1 個",           needN:true, nLabel:"N 人"},
    {v:"perGroupDay",  l:"每 N 人 1 個·每天",       needN:true, nLabel:"N 人"},
    {v:"perDay",       l:"每天（×天數）",           needN:false},
    {v:"fixed",        l:"固定數量",               needN:true, nLabel:"數量"},
  ];
  function modeNeedsN(mode){ const m=QTY_MODES.find(x=>x.v===mode); return m?m.needN:false; }
  function daysOf(dur){ return dur==="三日"?3 : dur==="二日"?2 : 1; }   // 半日/一日=1
  function calcQty(mode,n,H,D){
    H=Number(H)||0; D=Number(D)||1; n=Number(n)||1;
    switch(mode){
      case "perPerson":    return H;
      case "perPersonDay": return H*D;
      case "perGroup":     return Math.max(1,Math.ceil(H/(n||1)));
      case "perGroupDay":  return Math.max(1,Math.ceil(H/(n||1)))*D;
      case "perDay":       return D;
      case "perGuide":     return Math.max(1,Math.ceil(H/25));  // 舊範本相容
      case "perBus":       return Math.max(1,Math.ceil(H/43));  // 舊範本相容
      case "fixed":
      default:             return n||1;
    }
  }

  function load(){
    try{ const q=JSON.parse(localStorage.getItem(LS)); return q? Object.assign(newQuote(), q) : newQuote(); }
    catch(e){ return newQuote(); }
  }
  function newQuote(){ return { customer:"", headcount:30, budgetPP:"", areas:[], duration:"", purposes:[], needNote:"", markup:20, lines:[] }; }
  function toggleArr(key,val){ quote[key]=quote[key]||[]; const i=quote[key].indexOf(val); if(i>=0)quote[key].splice(i,1); else quote[key].push(val); save(); }
  function save(){ localStorage.setItem(LS, JSON.stringify(quote)); }

  function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
  function nf(n){ return (n==null||isNaN(n))?"—":Number(n).toLocaleString("zh-TW"); }
  function toast(m){ const t=document.getElementById("toast"); t.textContent=m; t.classList.add("show"); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove("show"),1900); }

  // 解析人數區間，如 "6-25"、"15 - 80人"、"20～200 人"、"25"
  function capRange(s){
    if(!s) return null;
    const nums = String(s).replace(/～|~/g,"-").match(/\d+/g);
    if(!nums) return null;
    if(nums.length===1) return [parseInt(nums[0]), parseInt(nums[0])];
    return [parseInt(nums[0]), parseInt(nums[1])];
  }
  function fitsHeadcount(p, h){
    const r = capRange(p.capacity);
    if(!r) return true; // 沒填區間者不排除
    return h>=r[0]*0.6 && h<=r[1]*1.2; // 給點彈性
  }

  // ---------- distinct 選項 ----------
  const CATS = [...new Set(ALL.map(p=>p.category))].sort();
  const AREAS = [...new Set(ALL.flatMap(p=>p.area))].filter(Boolean).sort();
  // 元件分類（含數量），讓業務從分類找成本元件
  const ELEM_CATS = (function(){
    const m={}; ALL.forEach(p=>{ if(p.type==="元件") m[p.category]=(m[p.category]||0)+1; });
    return Object.keys(m).map(c=>({cat:c, n:m[c]})).sort((a,b)=>b.n-a.n);
  })();

  // ---------- 路由 ----------
  document.getElementById("nav").addEventListener("click", e=>{
    const a=e.target.closest("a[data-view]"); if(!a) return;
    e.preventDefault(); view=a.dataset.view; render();
  });

  function render(){
    document.querySelectorAll("#nav a").forEach(a=>a.classList.toggle("active", a.dataset.view===view));
    const nc=document.getElementById("navCount");
    nc.style.display = quote.lines.length? "inline-block":"none";
    nc.textContent = quote.lines.length;
    document.getElementById("snapInfo").textContent = ALL.length + " 項產品";
    const titles={
      brief:["① 客戶需求","先記下這次客戶的需求，後面依需求推薦產品"],
      search:["② 找產品・規劃行程","依客戶需求篩選合適行程，並參考相似的過去提案"],
      quote:["③ 報價試算","把選好的行程與元件算出成本、售價與每人單價"],
      proposal:["④ 提案產生","依選定行程與報價，產出提案草稿"],
      past:["過去提案參考","291 筆歷史提案，依需求找最接近的舊案參考"],
      template:["行程成本範本","設定每條主行程實際包含的成本元件，讓報價試算更精準"],
    };
    const t=titles[view]||titles.brief;
    document.getElementById("pageTitle").textContent=t[0];
    document.getElementById("pageSub").textContent=t[1];
    const c=document.getElementById("content");
    if(view==="brief") c.innerHTML=renderBrief();
    else if(view==="search") c.innerHTML=renderSearch();
    else if(view==="quote") c.innerHTML=renderQuote();
    else if(view==="proposal") c.innerHTML=renderProposal();
    else if(view==="past") c.innerHTML=renderPast();
    else if(view==="template") c.innerHTML=renderTemplate();
    bind();
  }

  // ---------- 找產品（依需求篩選）----------
  function applyFilters(){
    const kw=f.kw.trim().toLowerCase();
    const bGroups=[...new Set((quote.areas||[]).map(c=>CITY_GROUP[c]).filter(Boolean))];
    const h=parseInt(quote.headcount)||0;
    return ALL.filter(p=>{
      if(f.onlyActive && !p.active) return false;
      if(f.type && p.type!==f.type) return false;
      if(f.cat && p.category!==f.cat) return false;   // 元件分類
      // 依客戶需求篩選（只套用在主行程；元件是成本積木不分地區）
      if(briefOn && p.type==="產品"){
        if(bGroups.length && !(p.area||[]).some(a=>bGroups.includes(a))) return false;
        if(h && !fitsHeadcount(p,h)) return false;
      }
      if(kw){
        const hay=[p.name,p.category,(p.topics||[]).join(" "),(p.esg||[]).join(" "),(p.area||[]).join(" "),p.note,p.priceRange].join(" ").toLowerCase();
        if(!hay.includes(kw)) return false;
      }
      return true;
    }).sort((a,b)=>{
      if(!kw) return 0;
      return (b.name.toLowerCase().includes(kw)?1:0)-(a.name.toLowerCase().includes(kw)?1:0); // 名稱命中者排前面
    });
  }

  function priceLabel(p){
    if(p.unitPrice!=null) return `NT$ ${nf(p.unitPrice)} / ${esc(p.unit||"單位")}`;
    if(p.priceRange) return esc(p.priceRange);
    return "定價未定（需客製）";
  }

  function productCard(p){
    const topics=(p.topics||[]).slice(0,3).map(t=>`<span class="tag topic">${esc(t)}</span>`).join("");
    const esgs=(p.esg||[]).slice(0,2).map(t=>`<span class="tag esg">♻ ${esc(t)}</span>`).join("");
    const driveLink=extractDrive(p.note);
    return `<div class="card pcard">
      <div class="ptags"><span class="tag cat">${esc(p.category)}</span>${(p.area||[]).map(a=>`<span class="tag area">${esc(a)}</span>`).join("")}</div>
      <h3>${esc(p.name)}</h3>
      <div class="price">${priceLabel(p)}</div>
      ${p.capacity?`<div class="meta">建議人數：${esc(p.capacity)}</div>`:""}
      ${p.noServe?`<div class="meta">⛔ ${esc(p.noServe)}</div>`:""}
      ${(topics||esgs)?`<div class="ptags">${topics}${esgs}</div>`:""}
      ${p.note?`<div class="note">${esc(p.note).slice(0,150)}${p.note.length>150?"…":""}</div>`:""}
      <div class="row"><button class="btn sm" data-add="${esc(p.id)}">＋ 加入規劃</button>
        ${p.url?`<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">官網↗</a>`:""}
        ${driveLink?`<a class="link" href="${esc(driveLink)}" target="_blank" rel="noopener">素材↗</a>`:""}
      </div></div>`;
  }

  // 依需求（活動目的、人數）找相似的過去提案
  function matchPurpose(briefP, propP){
    if(!propP) return false;
    const map={"Team Building":["TB","Team"],"ESG／志工":["ESG","志工"],"員工旅遊":["員工旅遊","休閒放鬆"],
      "家庭日":["家庭日"],"文化學習":["文化學習"],"休閒放鬆":["休閒放鬆"],"DEI 工作坊":["DEI"],
      "講座／工作坊":["講座","工作坊"],"外賓接待":["外賓","接待"]};
    return (map[briefP]||[briefP]).some(k=>propP.indexOf(k)>=0);
  }
  function briefProposals(){
    const ps=quote.purposes||[]; const h=parseInt(quote.headcount)||0;
    const band=h?(h<=25?"0-25":h<=80?"26-80":h<=200?"81-200":"201-"):"";
    if(!ps.length && !band) return [];
    return PROPOSALS.filter(p=>{
      const pm=ps.length && ps.some(x=>matchPurpose(x,p.purpose));
      const hm=band && p.headcount===band;
      return pm || (ps.length?false:hm); // 有選目的就以目的為主，否則用人數
    }).slice(0,6);
  }

  function needsSummary(){
    const a=(quote.areas||[]).join("、")||"不限";
    const pp=(quote.purposes||[]).join("、")||"不限";
    return `<div class="card needbar">
      <span class="lbl">本次需求</span>
      <span class="desc">${quote.customer?esc(quote.customer)+"｜":""}人數 ${quote.headcount||"—"}｜地區 ${esc(a)}｜目的 ${esc(pp)}${quote.duration?"｜"+esc(quote.duration):""}${quote.budgetPP?"｜每人預算 "+nf(quote.budgetPP):""}</span>
      <label style="font-size:12.5px;display:flex;gap:5px;align-items:center;margin-left:auto"><input type="checkbox" id="briefToggle" ${briefOn?"checked":""}>依需求篩選</label>
      <button class="btn ghost sm" data-go="brief">調整需求</button>
    </div>`;
  }

  function renderSearch(){
    const hasBrief=(quote.areas||[]).length||(quote.purposes||[]).length||quote.budgetPP;
    if(!hasBrief && !f.kw){
      return needsSummary()+`<div class="hint info">先到「① 客戶需求」填寫，這裡會依需求自動篩出合適行程；也可直接用下方關鍵字搜尋。</div>`+searchBody();
    }
    return needsSummary()+searchBody();
  }

  function searchBody(){
    const list=applyFilters();
    const props = briefOn ? briefProposals() : [];
    const propPanel = props.length ? `<div style="margin-bottom:18px">
        <div style="font-weight:800;font-size:14px;margin-bottom:8px">💡 相似的過去提案（參考客單與行程組合）</div>
        <div class="pgrid">${props.map(proposalCard).join("")}</div>
      </div>` : "";
    const filters=`<div class="filters">
      <div class="fg" style="flex:1"><label>在結果中再搜尋（關鍵字）</label>
        <input class="inp search-inp" id="f_kw" value="${esc(f.kw)}" placeholder="例：導覽員、便當、大巴、保險、住宿"></div>
      <div class="fg"><label>類型</label><select id="f_type"><option value="">全部</option><option value="產品" ${f.type==="產品"?"selected":""}>主行程</option><option value="元件" ${f.type==="元件"?"selected":""}>成本元件</option></select></div>
      <button class="btn ghost sm" id="f_clear">清除</button>
    </div>`;
    // 成本元件：依分類找成本
    const elemCatBar = f.type==="元件" ? `<div style="margin:2px 0 14px">
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:6px">依分類找成本元件：</div>
        <div class="chips">
          <button class="chip ${!f.cat?"on":""}" data-elemcat="">全部</button>
          ${ELEM_CATS.map(c=>`<button class="chip ${f.cat===c.cat?"on":""}" data-elemcat="${esc(c.cat)}">${esc(c.cat.replace("元件-","").replace("元件","其他"))}（${c.n}）</button>`).join("")}
        </div></div>` : "";
    const cards = list.slice(0,300).map(productCard).join("");
    const heading = f.type==="元件" ? "成本元件（單價＝成本）" : "符合需求的產品";
    return propPanel + filters + elemCatBar +
      `<div style="font-weight:800;font-size:14px;margin:6px 0 8px">${heading}</div>
      <div class="count">符合條件：<b>${list.length}</b> 項${list.length>300?"（僅顯示前 300）":""}</div>
      <div class="pgrid" id="prodgrid">${cards||'<div class="empty">沒有符合條件的項目（可放寬需求或關掉「依需求篩選」）</div>'}</div>`;
  }

  // ---------- 客戶需求 ----------
  function renderBrief(){
    const areaChips=CITIES.map(a=>`<button class="chip ${(quote.areas||[]).includes(a)?"on":""}" data-area="${esc(a)}">${esc(a)}</button>`).join("");
    const purpChips=PURPOSES.map(p=>`<button class="chip ${(quote.purposes||[]).includes(p)?"on":""}" data-purpose="${esc(p)}">${esc(p)}</button>`).join("");
    const durChips=DURATIONS.map(d=>`<button class="chip ${quote.duration===d?"on":""}" data-dur="${esc(d)}">${esc(d)}</button>`).join("");
    return `<div class="hint info">📝 第一步：先記下這次客戶的需求。填完按「依需求找產品」，系統會幫你篩出合適行程，並列出相似的過去提案參考。</div>
    <div class="card" style="padding:22px;max-width:780px">
      <div class="row2">
        <label class="bfld"><span>客戶名稱</span><input class="inp" id="b_customer" value="${esc(quote.customer)}" placeholder="企業名稱"></label>
        <label class="bfld"><span>人數</span><input class="inp" type="number" id="b_head" value="${esc(quote.headcount)}"></label>
      </div>
      <label class="bfld"><span>每人預算（選填）</span><input class="inp" type="number" id="b_budget" value="${esc(quote.budgetPP||"")}" placeholder="如 2000，之後可用來提醒是否超預算"></label>
      <div class="bfld"><span>目的地／地區（可多選）</span><div class="chips" id="areaChips">${areaChips}</div></div>
      <div class="bfld"><span>天數／時長</span><div class="chips">${durChips}</div></div>
      <div class="bfld"><span>活動目的（可多選）</span><div class="chips" id="purpChips">${purpChips}</div></div>
      <label class="bfld"><span>想達成的目的／其他需求</span><textarea class="inp" id="b_note" rows="3" placeholder="例：促進跨部門交流、結合 ESG 淨灘、預算有限希望半日…">${esc(quote.needNote||"")}</textarea></label>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button class="btn" id="b_go">依需求找產品 →</button>
        <button class="btn ghost" id="b_reset">清空需求</button>
      </div>
    </div>`;
  }

  function extractDrive(note){
    if(!note) return null;
    const m=String(note).match(/https:\/\/drive\.google\.com\/\S+/);
    return m?m[0].replace(/[)\s]+$/,""):null;
  }

  // ---------- 報價試算 ----------
  // 從定價文字抓第一個價格數字（3 位數以上），如「每人760-1500」→760、「3,200~3,500」→3200
  function firstPrice(s){ if(!s) return 0; const m=String(s).replace(/[,，]/g,"").match(/\d{3,}/); return m?parseInt(m[0]):0; }

  function addLine(id){
    const p=ALL.find(x=>x.id===id); if(!p) return;
    if(quote.lines.find(l=>l.id===id)){ toast("已在報價單中"); return; }
    const perPerson = p.unit==="人";
    const multiDay = (quote.duration==="二日"||quote.duration==="三日");
    // 元件用 Zoho 單價；主行程不帶全日價（當作參考售價，成本改由元件組成）
    let unitPrice = p.type==="產品" ? 0 : (p.unitPrice!=null ? p.unitPrice : 0);
    let qty = perPerson ? (quote.headcount||1) : 1;
    // 每個行程各自成一段（元件掛在它底下）；二日/三日時這些段會輸出到同一張報價分頁
    let group;
    if(p.type==="產品"){ group = shortName(p.name); activeGroup = group; }
    else { group = activeGroup || "其他元件"; }
    quote.lines.push({
      id:p.id, name:p.name, type:p.type, unit:p.unit||"項",
      qty, unitPrice, priceRange:p.priceRange||"", group
    });
    // 加入主行程時：自動帶入成本範本（有設定專屬範本就用它，否則用通用範本）
    if(p.type==="產品") addCostTemplate(p, group, multiDay);
    save(); toast("已加入："+p.name+"（已帶入成本範本，請核對）");
  }
  function shortName(name){ return String(name).split(/[｜|]/)[0].slice(0,18) || name.slice(0,18); }

  // 找一個有單價的代表性元件
  function pickComp(){ const terms=[].slice.call(arguments);
    for(const t of terms){ const p=ALL.find(x=>x.type==="元件"&&x.active&&x.name.indexOf(t)>=0&&Number(x.unitPrice)>0); if(p) return p; }
    return null;
  }
  // 成本範本：有設定該行程的專屬範本就用它，否則用通用範本 — 皆依人數試算
  function addCostTemplate(tour, group, multiDay){
    const H=quote.headcount||1;
    const D=daysOf(quote.duration);
    const add=(o)=>quote.lines.push(Object.assign({type:"元件",priceRange:"",tpl:true}, o));
    const saved=TEMPLATES[tour.id];
    if(saved && saved.items && saved.items.length && !saved.archived){
      saved.items.forEach(it=>add({id:it.id,name:it.name,unit:it.unit||"項",unitPrice:it.unitPrice||0,qty:calcQty(it.mode,it.n,H,D),group}));
    } else {
      const g=pickComp("帶路人 4000","帶路人","導覽員 1600","導覽員"); if(g) add({id:g.id,name:g.name,unit:g.unit||"項",unitPrice:g.unitPrice||0,qty:Math.max(1,Math.ceil(H/25)),group});
      const me=pickComp("便當","司領餐","餐食"); if(me) add({id:me.id,name:me.name,unit:me.unit||"人",unitPrice:me.unitPrice||0,qty:H,group});
      const bs=pickComp("43座大巴","大巴","遊覽車"); if(bs) add({id:bs.id,name:bs.name,unit:bs.unit||"項",unitPrice:bs.unitPrice||0,qty:Math.max(1,Math.ceil(H/43)),group});
      const ins=pickComp("國內一日","保險"); if(ins) add({id:ins.id,name:ins.name,unit:ins.unit||"人",unitPrice:ins.unitPrice||0,qty:H,group});
      add({id:"_exp_"+Math.random().toString(36).slice(2,7),name:"體驗／門票／其他（請填每人成本）",unit:"人",unitPrice:0,qty:H,group});
    }
    // 二日/三日：整筆若還沒有住宿，補一筆住宿到「共用」段（整趟共用，加一次）
    if(multiDay && !quote.lines.some(l=>/住宿/.test(l.name))){
      const acc=ALL.find(x=>x.type==="元件"&&x.name.indexOf("住宿")>=0&&x.active);
      if(acc) add({id:acc.id,name:acc.name,unit:acc.unit||"人",unitPrice:acc.unitPrice||0,qty:H,group:"共用"});
    }
  }
  // 快速加入常用成本元件（跳到找產品並篩好）
  const QUICK_COMP=[{l:"住宿",kw:"住宿"},{l:"餐食",kw:"餐"},{l:"交通",kw:"交通"},{l:"保險",kw:"保險"},{l:"導覽",kw:"導覽員"},{l:"帶路人",kw:"帶路人"}];
  // 依插入順序取得行程段清單
  function groupsOf(){ const seen=[]; quote.lines.forEach(l=>{ const g=l.group||"其他元件"; if(!seen.includes(g)) seen.push(g); }); return seen; }

  function totals(){
    const cost = quote.lines.reduce((s,l)=>s + (Number(l.qty)||0)*(Number(l.unitPrice)||0), 0);
    const m = Number(quote.markup)||0;
    const price = Math.round(cost*(1+m/100));
    const H = Number(quote.headcount)||0;
    return { cost, price, m, H, costPP: H?cost/H:0, pricePP: H?price/H:0 };
  }

  function renderQuote(){
    if(!quote.lines.length){
      return `<div class="hint">🧮 報價試算：從「產品搜尋」把行程與元件加進來，這裡會自動加總成本、套用利潤率，算出總價與每人單價。</div>
        <div class="card empty"><div class="big">🧮</div><div>報價單還是空的</div>
        <div style="margin-top:12px"><button class="btn ghost" data-go="search">前往產品搜尋</button></div></div>`;
    }
    const t=totals();
    // 只有「元件」沒填單價才算缺價（主行程是參考售價，不列入成本）
    const noPriceCount = quote.lines.filter(l=>l.type!=="產品" && !(Number(l.unitPrice)>0)).length;
    const groups = groupsOf();
    const moveOpts = [...new Set([...groups,"其他元件"])];
    function lineRow(l,i){
      const isProd = l.type==="產品";
      const noPrice = !isProd && !(Number(l.unitPrice)>0);   // 元件缺價才標紅
      const sub = (Number(l.qty)||0)*(Number(l.unitPrice)||0);
      const tplTag = l.tpl ? ` <span class="tag" style="background:#fef3c7;color:#92400e">範本估算·請核對</span>` : "";
      const nameNote = isProd
        ? `<div style="font-size:11px;color:var(--muted)">參考售價：${l.priceRange?esc(l.priceRange):"未定"}（成本請用下方元件組成，不列入成本）</div>`
        : (noPrice ? `<div style="font-size:11px;color:var(--danger)">⚠️ 請填單價</div>` : (l.tpl?`<div style="font-size:11px;color:#92400e">範本預設值，請確認是否符合本案（地區/等級可能不同）</div>`:""));
      return `<tr>
        <td><span class="pill ${isProd?"prod":"comp"}">${isProd?"行程":"元件"}</span></td>
        <td>${esc(l.name)}${tplTag}${nameNote}</td>
        <td class="num"><input class="qty-inp" type="number" min="0" data-q="${i}" value="${esc(l.qty)}"></td>
        <td style="color:var(--muted);font-size:12px">${esc(l.unit)}</td>
        <td class="num"><input class="price-inp" type="number" min="0" data-p="${i}" value="${esc(l.unitPrice)}" style="${noPrice?'border-color:#dc2626;background:#fff7f7':''}"></td>
        <td class="num"><b>${nf(sub)}</b></td>
        <td style="white-space:nowrap"><select class="grp-move" data-move="${i}" title="移到方案" style="font-size:11px;padding:3px;max-width:90px">${moveOpts.map(o=>`<option ${o===(l.group||"其他元件")?"selected":""}>${esc(o)}</option>`).join("")}</select> <button class="lineDel" data-del="${i}" title="移除">×</button></td>
      </tr>`;
    }
    const body = groups.map(g=>{
      const items = quote.lines.map((l,i)=>({l,i})).filter(x=>(x.l.group||"其他元件")===g);
      const gsub = items.reduce((s,x)=>s+(Number(x.l.qty)||0)*(Number(x.l.unitPrice)||0),0);
      const header = `<tr style="background:#fff7ed">
        <td style="text-align:center">🧭</td>
        <td colspan="3"><input class="inp" data-grename="${esc(g)}" value="${esc(g)}" style="font-weight:700;width:100%;padding:5px 8px"></td>
        <td class="num" style="color:var(--muted);font-size:12px">行程小計</td>
        <td class="num"><b>${nf(gsub)}</b></td><td></td></tr>`;
      return header + items.map(x=>lineRow(x.l,x.i)).join("");
    }).join("");
    const warnBanner = noPriceCount ? `<div class="hint" style="margin:0;border-radius:0;border-left:none;border-right:none">⚠️ 有 <b>${noPriceCount}</b> 個元件尚未填單價——請在「單價」欄填入金額。</div>` : "";
    const dayHint = (quote.duration==="二日"||quote.duration==="三日") ? `<div class="hint" style="margin:0;border-radius:0;border-left:none;border-right:none;background:#eff6ff;border-color:#bfdbfe;color:#1e40af">🗓️ ${esc(quote.duration)}行程：<b>每個行程各自一段</b>，元件就掛在它底下（看得出哪個元件屬於哪天）；住宿放「共用」段。這些段會一起輸出到<b>同一張報價分頁</b>。</div>` : "";
    const quickRow = `<div style="padding:9px 16px;border-bottom:1px solid var(--line);display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12.5px">
      <span style="color:var(--muted)">快速加成本元件（看得到單價）：</span>
      ${QUICK_COMP.map(q=>`<button class="btn ghost sm" data-quick="${esc(q.kw)}">＋${esc(q.l)}</button>`).join("")}
    </div>`;
    return `<div class="qwrap">
      <div class="card" style="overflow:hidden">
        <div style="display:flex;gap:14px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--line)">
          <div class="fg"><label>客戶名稱</label><input class="inp" id="q_customer" value="${esc(quote.customer)}" placeholder="企業名稱"></div>
          <div class="fg"><label>人數</label><input class="inp" id="q_head" type="number" min="1" style="width:90px" value="${esc(quote.headcount)}"></div>
          <div class="fg"><label>利潤加成 %</label><input class="inp" id="q_markup" type="number" min="0" style="width:90px" value="${esc(quote.markup)}"></div>
          <div class="fg" style="justify-content:flex-end"><button class="btn ghost sm" id="q_headfill">人數套用到「以人計價」項目</button></div>
        </div>
        ${quickRow}${dayHint}${warnBanner}
        <div style="overflow:auto"><table>
          <thead><tr><th></th><th>項目</th><th class="num">數量</th><th>單位</th><th class="num">單價</th><th class="num">小計</th><th>方案</th></tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>
      <div>
        <div class="card summary" style="padding:16px">
          <div class="row"><span>成本合計</span><span class="v">NT$ ${nf(t.cost)}</span></div>
          <div class="row"><span>成本／人（${t.H} 人）</span><span class="v">NT$ ${nf(Math.round(t.costPP))}</span></div>
          <div class="row"><span>利潤加成</span><span class="v">${t.m}%</span></div>
          <div class="row big"><span>建議售價</span><span class="v">NT$ ${nf(t.price)}</span></div>
          <div class="row big"><span>每人單價</span><span class="v">NT$ ${nf(Math.round(t.pricePP))}</span></div>
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
            <button class="btn ok sm" data-go="proposal">產生提案草稿</button>
            <button class="btn sm" id="q_save">💾 存報價（Drive＋Zoho）</button>
            <button class="btn ghost sm" id="q_csv">匯出 CSV</button>
            <button class="btn ghost sm" id="q_clear">清空</button>
          </div>
        </div>
        <div class="hint" style="margin-top:14px">💡 加入行程時已<b>自動帶入一套成本範本</b>（帶路人、餐食、交通、保險＋體驗待填）並依人數試算，這是<b>估算起點、不是真實成本</b>——請逐項核對單價/數量、補上「體驗／門票」每人成本。主行程的「參考售價」只是過去成交價，不列入成本。核對合理後再「存報價」輸出。</div>
      </div>
    </div>`;
  }

  // ---------- 提案產生 ----------
  function buildDraft(){
    const t=totals();
    const prods=quote.lines.filter(l=>l.type==="產品");
    const comps=quote.lines.filter(l=>l.type!=="產品");
    const esgSet=new Set(), topicSet=new Set();
    quote.lines.forEach(l=>{
      const p=ALL.find(x=>x.id===l.id); if(!p) return;
      (p.esg||[]).forEach(e=>esgSet.add(e)); (p.topics||[]).forEach(tp=>topicSet.add(tp));
    });
    const L=[];
    L.push(`# ${quote.customer||"〔客戶〕"} 永續旅行提案`);
    L.push("");
    L.push(`- 參與人數：${quote.headcount} 人`);
    L.push(`- 每人建議單價：NT$ ${nf(Math.round(t.pricePP))}（總計 NT$ ${nf(t.price)}）`);
    if(topicSet.size) L.push(`- 活動主題：${[...topicSet].join("、")}`);
    L.push("");
    L.push(`## 行程安排與費用（依行程段）`);
    L.push("");
    const segs=groupsOf();
    if(!segs.length){ L.push("（尚未加入行程，請於「找產品」加入行程與元件）"); L.push(""); }
    segs.forEach(g=>{
      const items=quote.lines.filter(l=>(l.group||"其他元件")===g);
      const gsub=items.reduce((s,l)=>s+(Number(l.qty)||0)*(Number(l.unitPrice)||0),0);
      L.push(`### ${g}`);
      // 該行程段的主行程介紹
      items.filter(l=>l.type==="產品").forEach(l=>{
        const p=ALL.find(x=>x.id===l.id)||{};
        L.push(`**${l.name}**`);
        if(p.area&&p.area.length) L.push(`- 地區：${p.area.join("、")}`);
        if(p.topics&&p.topics.length) L.push(`- 亮點：${p.topics.join("、")}`);
        if(p.url) L.push(`- 詳細介紹：${p.url}`);
      });
      // 該行程段的費用明細
      L.push("");
      L.push("| 項目 | 數量 | 單位 | 單價 | 小計 |");
      L.push("|---|---:|---|---:|---:|");
      items.forEach(l=>{
        L.push(`| ${l.name} | ${l.qty} | ${l.unit} | ${nf(l.unitPrice)} | ${nf((Number(l.qty)||0)*(Number(l.unitPrice)||0))} |`);
      });
      L.push(`| 行程段小計 | | | | ${nf(gsub)} |`);
      L.push("");
    });
    L.push(`- **成本合計**：NT$ ${nf(t.cost)}`);
    L.push(`- **建議售價（含 ${t.m}% 加成）**：NT$ ${nf(t.price)}`);
    L.push(`- **每人單價**：NT$ ${nf(Math.round(t.pricePP))}`);
    L.push("");
    if(esgSet.size){
      L.push(`## ESG 效益`);
      [...esgSet].forEach(e=>L.push(`- ${e}`));
      L.push("");
    }
    L.push(`---`);
    L.push(`本提案由島內散步永續旅行團隊整理，實際內容與定價將依貴公司需求與活動日期客製調整。`);
    return L.join("\n");
  }

  function renderProposal(){
    if(!quote.lines.length){
      return `<div class="card empty"><div class="big">📄</div><div>請先在報價試算加入項目</div>
        <div style="margin-top:12px"><button class="btn ghost" data-go="search">前往產品搜尋</button></div></div>`;
    }
    const draft=buildDraft();
    return `<div class="hint info">📄 以下提案草稿依你目前的報價單自動生成。可「複製」後貼到 Google Slides／Docs 微調，或下載成 .md。完整自動生成簡報檔為後續階段。</div>
      <div style="display:flex;gap:9px;margin-bottom:12px">
        <button class="btn" id="p_copy">📋 複製草稿</button>
        <button class="btn ok" id="p_save">💾 存提案到 Drive 並登錄</button>
        <button class="btn ghost" id="p_dl">⬇ 下載 .md</button>
        <button class="btn ghost" data-go="quote">回報價調整</button>
      </div>
      <div class="card" style="padding:16px"><pre class="draft" id="draftBox">${esc(draft)}</pre></div>`;
  }

  // ---------- 過去提案搜尋（來源：2B提案簡報檢索表）----------
  const P_CITIES = [...new Set(PROPOSALS.map(p=>p.city))].filter(Boolean).sort();
  const P_PURPOSE = [...new Set(PROPOSALS.map(p=>p.purpose))].filter(Boolean).sort();
  const P_HEAD = ["0-25","26-80","81-200","201-"];

  function applyProposalFilters(){
    const kw=pf.kw.trim().toLowerCase();
    return PROPOSALS.filter(p=>{
      if(pf.city && p.city!==pf.city) return false;
      if(pf.duration && p.duration!==pf.duration) return false;
      if(pf.head && p.headcount!==pf.head) return false;
      if(pf.purpose && p.purpose!==pf.purpose) return false;
      if(kw){
        const hay=[p.name,p.company,p.city,(p.spots||[]).join(" "),p.purpose,(p.components||[]).join(" "),(p.compDetail||[]).join(" "),p.note,p.issue].join(" ").toLowerCase();
        if(!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  function proposalCard(p){
    const comps=(p.components||[]).map(c=>`<span class="tag">${esc(c)}</span>`).join("");
    const price=p.pricePP? `每人 NT$ ${esc(String(p.pricePP).replace(/\.0$/,""))}` : "客單未填";
    return `<div class="card pcard">
      <div class="ptags">
        ${p.purpose?`<span class="tag cat">${esc(p.purpose)}</span>`:""}
        ${p.city?`<span class="tag area">${esc(p.city)}${p.spots&&p.spots.length?(" · "+esc(p.spots.join("/"))):""}</span>`:""}
        ${p.issue?`<span class="tag esg">${esc(p.issue)}</span>`:""}
      </div>
      <h3>${esc(p.company||p.name)}</h3>
      <div class="meta">${[p.duration,p.headcount&&(p.headcount+" 人"),p.date&&("登錄 "+p.date),p.owner&&("負責 "+p.owner)].filter(Boolean).map(esc).join("　·　")}</div>
      <div class="price">${price}${p.mealTransport?` <span style="font-size:11px;color:var(--muted)">(${esc(p.mealTransport)})</span>`:""}</div>
      ${comps?`<div class="ptags">${comps}</div>`:""}
      ${p.note?`<div class="note">${esc(p.note).slice(0,140)}${p.note.length>140?"…":""}</div>`:""}
      <div class="row">
        ${p.link?`<a class="btn sm" href="${esc(p.link)}" target="_blank" rel="noopener" style="text-decoration:none">開啟提案 ↗</a>`:`<span style="font-size:12px;color:var(--muted)">無連結</span>`}
      </div>
    </div>`;
  }

  // ---------- 行程成本範本（行程↔元件對照表）----------
  function tplPickList(){
    const kw=tplKw.trim().toLowerCase();
    const matches = kw ? ALL.filter(p=>p.type==="元件"&&p.active&&[p.name,p.category].join(" ").toLowerCase().includes(kw)).slice(0,24) : [];
    return matches.map(m=>`<button class="btn ghost sm" data-tpladd="${esc(m.id)}">＋ ${esc(m.name)}（${m.unitPrice!=null?nf(m.unitPrice):"無價"}）</button>`).join(" ") || (kw?"<span style='color:var(--muted);font-size:12.5px'>找不到符合的元件</span>":"<span style='color:var(--muted);font-size:12.5px'>輸入關鍵字找元件加入</span>");
  }
  function renderTemplate(){
    const prods=ALL.filter(p=>p.type==="產品"&&p.active).sort((a,b)=>a.name.localeCompare(b.name,"zh-Hant"));
    const opts=prods.map(p=>`<option value="${esc(p.id)}" ${p.id===tplTour?"selected":""}>${esc(p.name)}${TEMPLATES[p.id]&&TEMPLATES[p.id].items&&TEMPLATES[p.id].items.length?"　✓已設定":""}</option>`).join("");
    let body="";
    if(tplTour){
      const tour=ALL.find(p=>p.id===tplTour)||{};
      const official=TEMPLATES[tplTour]||{items:[]};
      const editing = !!(tplDraft && tplDraft.id===tplTour);
      const src = editing ? tplDraft : official;
      const items = src.items||[];
      const H=quote.headcount||30, D=daysOf(quote.duration);
      const tplCost=items.reduce((s,it)=>s+calcQty(it.mode,it.n,H,D)*(Number(it.unitPrice)||0),0);
      // 列：編輯模式可改、檢視模式唯讀
      const rows=items.map((it,i)=>{
        const md=QTY_MODES.find(m=>m.v===it.mode), showN=modeNeedsN(it.mode);
        const qtyNote=`<div style="font-size:11px;color:var(--muted);margin-top:2px">試算量：${calcQty(it.mode,it.n,H,D)}（${esc(H)}人${D>1?"×"+D+"天":""}）</div>`;
        if(editing){
          return `<tr>
            <td>${esc(it.name)}</td>
            <td><select data-tplmode="${i}" style="font-size:12px;padding:4px">${QTY_MODES.map(m=>`<option value="${m.v}" ${it.mode===m.v?"selected":""}>${m.l}</option>`).join("")}</select>
              <input class="qty-inp" data-tpln="${i}" value="${esc(it.n||1)}" title="${md&&md.nLabel?esc(md.nLabel):""}" style="width:56px;${showN?"":"display:none"}">
              ${showN&&md&&md.nLabel?`<span style="font-size:11px;color:var(--muted)">${esc(md.nLabel)}</span>`:""}${qtyNote}</td>
            <td class="num"><input class="price-inp" data-tplprice="${i}" value="${esc(it.unitPrice)}"></td>
            <td><button class="lineDel" data-tpldel="${i}" title="移除">×</button></td>
          </tr>`;
        }
        return `<tr>
          <td>${esc(it.name)}</td>
          <td>${esc(modeLabel(it.mode,it.n))}${qtyNote}</td>
          <td class="num">${nf(it.unitPrice)}</td>
          <td></td>
        </tr>`;
      }).join("");
      const otherTours=prods.filter(p=>p.id!==tplTour);
      const dupOpts=otherTours.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${TEMPLATES[p.id]&&TEMPLATES[p.id].items&&TEMPLATES[p.id].items.length?"（已有範本，會覆蓋）":""}</option>`).join("");
      // 版本資訊列
      const metaLine = official.rev ? `<div style="font-size:11.5px;color:var(--muted);margin-top:3px">目前第 <b>${official.rev}</b> 版　·　最後修改：${esc(official.updatedBy||"—")}　${fmtTime(official.updatedAt)}${official.changeSummary?`　·　${esc(official.changeSummary)}`:""}</div>` : "";
      // 版本歷史
      const hist = official.history||[];
      const histRows = hist.map(h=>`<tr>
        <td style="white-space:nowrap">第 ${h.rev||"?"} 版</td>
        <td style="white-space:nowrap">${esc(h.by||"—")}</td>
        <td style="white-space:nowrap">${fmtTime(h.at)}</td>
        <td>${esc(h.summary||"")}${h.note?`<div style="color:var(--muted)">備註：${esc(h.note)}</div>`:""}</td>
        <td style="white-space:nowrap"><button class="btn ghost sm" data-tplrestore="${h.rev}" ${editing?"disabled":""}>還原此版</button></td>
      </tr>`).join("");
      const histBlock = hist.length ? `<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
        <button class="btn ghost sm" id="tpl_histtoggle">${tplHistOpen?"▾":"▸"} 版本歷史（${hist.length}）</button>
        ${tplHistOpen?`<div style="overflow:auto;margin-top:10px"><table style="font-size:12.5px">
          <thead><tr><th>版本</th><th>修改者</th><th>時間</th><th>改了什麼</th><th></th></tr></thead>
          <tbody>${histRows}</tbody></table></div>`:""}
      </div>` : "";

      const headerNote = official.conflictOf
        ? `⚠️ 這是<b>衝突副本</b>（有人同時改了同一條範本，系統把你的版本另存於此）。核對後可用「複製這份範本到」貼回正本行程，再刪掉此副本。`
        : (editing ? `✏️ <b>編輯中（建立新版本）</b>：改完按「儲存為新版本」會產生一個新版本、舊版自動進歷史；按取消則不留版本。`
                   : `這是目前正式版本，<b>唯讀</b>。要修改請按「修改（建立新版本）」；所有變更都會記錄日期與修改者。`);

      // 動作按鈕
      const actions = editing
        ? `<button class="btn" id="tpl_savever">✓ 儲存為新版本</button> <button class="btn ghost" id="tpl_canceledit">取消</button>`
        : `<button class="btn" id="tpl_beginedit">✏️ 修改（建立新版本）</button> <button class="btn ghost sm" data-tplback>← 回總覽</button>`;

      body=`<div class="card" style="padding:18px;margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:240px"><h3 style="margin:0 0 4px">${esc(tour.name||official.name||tplTour)}</h3>
          <div style="font-size:12.5px;color:var(--muted)">${headerNote}</div>${metaLine}</div>
          <div style="white-space:nowrap">${actions}</div>
        </div>
        ${items.length?`<div style="overflow:auto;margin-top:12px"><table>
          <thead><tr><th>元件</th><th>數量規則</th><th class="num">單價(成本)</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
          <div style="text-align:right;font-size:12.5px;color:var(--muted);margin-top:6px">試算成本（${esc(H)}人${D>1?"×"+D+"天":""}）：<b style="color:var(--ink,#111)">${nf(tplCost)}</b></div>`:`<div style="color:var(--muted);font-size:13px;padding:8px 0">${editing?"尚未加入元件。用下方關鍵字搜尋元件加入。":"這份範本沒有元件。"}</div>`}
        ${editing?`<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
          <label class="bfld" style="max-width:420px"><span>加入元件（關鍵字）</span><input class="inp" id="tpl_kw" value="${esc(tplKw)}" placeholder="例：導覽員、便當、43座大巴、保險、住宿"></label>
          <div class="chips" id="tplPickList">${tplPickList()}</div>
          <label class="bfld" style="max-width:560px;margin-top:12px"><span>這次改了什麼（可留空，系統會自動記錄差異）</span><input class="inp" id="tpl_note" placeholder="例：暑假漲價、改用大巴"></label>
        </div>`:""}
        ${(!editing && items.length)?`<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px">
          <span style="color:var(--muted)">複製這份範本到：</span>
          <select id="tpl_dupto" class="inp" style="max-width:300px;font-size:12px">${dupOpts}</select>
          <button class="btn ghost sm" id="tpl_dupbtn">複製過去</button>
          <span style="flex:1"></span>
          <button class="btn ghost sm" id="tpl_wipe" style="color:var(--danger)">刪除整份範本</button>
        </div>`:""}
        ${editing?"":histBlock}
      </div>`;
    }
    const overview = tplTour ? "" : tplOverview(prods);
    const userChip = (cloudEnabled() && isLoggedIn())
      ? `<span class="tag" style="background:#ecfdf5;color:#065f46">👤 ${esc(meName())}${isAdmin()?"（管理員）":""}</span><button class="btn ghost sm" id="tpl_logout">登出</button>`
      : "";
    const syncBar = `<div style="display:flex;align-items:center;gap:10px;margin:0 0 12px;flex-wrap:wrap">
      ${syncBadgeHTML()}
      ${cloudEnabled()?`<button class="btn ghost sm" id="tpl_pull">↻ 重新從雲端載入</button>`:""}
      ${userChip}
      <span style="flex:1"></span>
      ${(isAdmin()&&SRV.passwordLogin)?`<button class="btn ghost sm" id="tpl_users">👥 帳號管理</button>`:""}
    </div>
    <div style="font-size:11.5px;color:var(--muted);margin:-6px 0 12px">${cloudEnabled()?"範本全業務共用、存在 Google 雲端；修改／刪除都會記錄日期與修改者。":"目前是試用版（單機）；部署版會用公司 Google 帳號登入、全業務共用。"}</div>`;
    return `<div class="hint info">📐 為每條主行程設定它「實際包含哪些成本元件、各多少」。設定後，報價加入這條行程時就帶入<b>它專屬的成本</b>（不再用通用範本），試算更準。建議先設你們最常賣的幾條。</div>
      ${syncBar}
      <label class="bfld" style="max-width:560px"><span>選擇要設定的主行程</span><select class="inp" id="tpl_tour"><option value="">— 請選擇主行程 —</option>${opts}</select></label>
      ${body}${overview}`;
  }
  // 範本總覽：列出所有已設定專屬範本的行程，可一眼看數量/試算成本，並編輯或刪除
  function tplOverview(prods){
    const ids=Object.keys(TEMPLATES).filter(id=>{ const t=TEMPLATES[id]; return t&&t.items&&t.items.length&&!t.archived&&!t._pendingDel; });
    const delIds=Object.keys(TEMPLATES).filter(id=>TEMPLATES[id]&&(TEMPLATES[id].archived||TEMPLATES[id]._pendingDel));
    const deletedBlock = delIds.length ? `<div class="card" style="padding:18px;margin-top:14px">
      <h3 style="margin:0 0 10px;color:var(--muted)">🗑️ 已刪除範本（${delIds.length}）</h3>
      <div style="overflow:auto"><table style="font-size:12.5px"><thead><tr><th>主行程</th><th>刪除者</th><th>時間</th><th></th></tr></thead><tbody>${
        delIds.map(id=>{ const t=TEMPLATES[id]; const name=t.name||(prods.find(p=>p.id===id)||{}).name||id;
          return `<tr><td>${esc(name)}</td><td>${esc(t.updatedBy||"—")}</td><td>${fmtTime(t.updatedAt)}</td><td style="white-space:nowrap"><button class="btn ghost sm" data-tplrestoredel="${esc(id)}">還原</button></td></tr>`;
        }).join("")
      }</tbody></table></div></div>` : "";
    if(!ids.length) return `<div class="card empty" style="margin-top:14px"><div class="big">📐</div><div>還沒有任何專屬範本</div><div style="margin-top:8px;color:var(--muted);font-size:12.5px">從上方選一條主行程，把它常用的成本元件加進去。其餘行程在報價時會先用「通用範本」粗估。</div></div>${deletedBlock}`;
    const H=quote.headcount||30, D=daysOf(quote.duration);
    // 衝突副本排在最前面，提醒先處理
    ids.sort((a,b)=>(TEMPLATES[b].conflictOf?1:0)-(TEMPLATES[a].conflictOf?1:0));
    const conflictCount=ids.filter(id=>TEMPLATES[id].conflictOf).length;
    const rows=ids.map(id=>{
      const t=TEMPLATES[id];
      const isConflict=!!t.conflictOf;
      const name=t.name||(prods.find(p=>p.id===id)||{}).name||id;
      const gone=!isConflict && !prods.some(p=>p.id===id);   // 行程已不在目前產品快照（衝突副本不算）
      const cost=t.items.reduce((s,it)=>s+calcQty(it.mode,it.n,H,D)*(Number(it.unitPrice)||0),0);
      const noPrice=t.items.some(it=>!(Number(it.unitPrice)>0));
      return `<tr${isConflict?' style="background:#fffbeb"':''}>
        <td>${esc(name)}${isConflict?` <span class="tag" style="background:#fef3c7;color:#92400e">⚠️ 衝突副本·待合併</span>`:""}${gone?` <span class="tag" style="background:#fee2e2;color:#991b1b">行程已不在快照</span>`:""}${noPrice?` <span class="tag" style="background:#fef3c7;color:#92400e">有元件缺價</span>`:""}</td>
        <td class="num">${t.items.length}</td>
        <td class="num"><b>${nf(cost)}</b></td>
        <td style="white-space:nowrap"><button class="btn ghost sm" data-tpledit="${esc(id)}">${isConflict?"核對":"編輯"}</button> <button class="lineDel" data-tplwipe="${esc(id)}" title="刪除整份範本">×</button></td>
      </tr>`;
    }).join("");
    const conflictBanner=conflictCount?`<div class="hint" style="margin:0 0 12px;background:#fffbeb;border-color:#fde68a;color:#92400e">⚠️ 有 <b>${conflictCount}</b> 份「衝突副本」：表示有人和你同時改了同一條範本，系統把後存的那份另存於此，沒有覆蓋掉別人的。請點「核對」確認內容，需要的話用副本裡的「複製這份範本到」貼回正本，再刪掉副本。</div>`:"";
    return `<div class="card" style="padding:18px;margin-top:14px">
      <h3 style="margin:0 0 10px">已設定的專屬範本（${ids.length}）</h3>
      ${conflictBanner}
      <div style="overflow:auto"><table>
        <thead><tr><th>主行程</th><th class="num">元件數</th><th class="num">試算成本（${esc(H)}人${D>1?"×"+D+"天":""}）</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>${deletedBlock}`;
  }

  function renderPast(){
    const list=applyProposalFilters();
    const opt=(arr,sel)=>arr.map(v=>`<option ${v===sel?"selected":""}>${esc(v)}</option>`).join("");
    return `<div class="hint info">🗂️ 來源：你們的<b>「2B提案簡報檢索表」</b>，共 <b>${PROPOSALS.length}</b> 筆歷史提案、全部可一鍵開啟簡報。依客戶需求篩選，找到最接近的舊案來參考或改寫。資料為快照。</div>
      <div class="filters">
        <div class="fg" style="flex:1"><label>關鍵字（客戶、地點、元件…）</label>
          <input class="inp search-inp" id="pf_kw" value="${esc(pf.kw)}" placeholder="例：Google、淨灘、淡水、藍色公路、印花樂"></div>
        <div class="fg"><label>地區</label><select id="pf_city"><option value="">全部</option>${opt(P_CITIES,pf.city)}</select></div>
        <div class="fg"><label>時長</label><select id="pf_duration"><option value="">全部</option>${opt(["半日","一日"],pf.duration)}</select></div>
        <div class="fg"><label>人數</label><select id="pf_head"><option value="">全部</option>${opt(P_HEAD,pf.head)}</select></div>
        <div class="fg"><label>活動目的</label><select id="pf_purpose"><option value="">全部</option>${opt(P_PURPOSE,pf.purpose)}</select></div>
        <button class="btn ghost sm" id="pf_clear">清除</button>
      </div>
      <div class="count">符合條件：<b>${list.length}</b> 筆</div>
      <div class="pgrid" id="pgrid">${list.slice(0,300).map(proposalCard).join("")||'<div class="empty">沒有符合條件的提案</div>'}</div>`;
  }

  // ---------- 事件 ----------
  function bind(){
    const c=document.getElementById("content");
    c.querySelectorAll("[data-go]").forEach(el=>el.onclick=()=>{ view=el.dataset.go; render(); });

    // 客戶需求表單
    const bc=document.getElementById("b_customer"); if(bc) bc.oninput=()=>{ quote.customer=bc.value; save(); };
    const bh=document.getElementById("b_head"); if(bh) bh.oninput=()=>{ quote.headcount=parseInt(bh.value)||0; save(); };
    const bbg=document.getElementById("b_budget"); if(bbg) bbg.oninput=()=>{ quote.budgetPP=parseInt(bbg.value)||""; save(); };
    const bn=document.getElementById("b_note"); if(bn) bn.oninput=()=>{ quote.needNote=bn.value; save(); };
    c.querySelectorAll("[data-area]").forEach(el=>el.onclick=()=>{ toggleArr("areas",el.dataset.area); render(); });
    c.querySelectorAll("[data-purpose]").forEach(el=>el.onclick=()=>{ toggleArr("purposes",el.dataset.purpose); render(); });
    c.querySelectorAll("[data-dur]").forEach(el=>el.onclick=()=>{ quote.duration = quote.duration===el.dataset.dur?"":el.dataset.dur; save(); render(); });
    const bgo=document.getElementById("b_go"); if(bgo) bgo.onclick=()=>{ briefOn=true; view="search"; render(); };
    const brs=document.getElementById("b_reset"); if(brs) brs.onclick=()=>{ if(confirm("清空目前的客戶需求？（已加入的報價項目不受影響）")){ quote.customer="";quote.headcount=30;quote.budgetPP="";quote.areas=[];quote.duration="";quote.purposes=[];quote.needNote=""; save(); render(); } };

    // 找產品：依需求篩選開關 + 在結果中再搜尋
    const bt=document.getElementById("briefToggle"); if(bt) bt.onchange=()=>{ briefOn=bt.checked; render(); };
    const kw=document.getElementById("f_kw");
    if(kw){
      let tmr; kw.oninput=()=>{ clearTimeout(tmr); tmr=setTimeout(()=>{ f.kw=kw.value; rerenderSearch(); },200); };
      const ft=document.getElementById("f_type"); if(ft) ft.onchange=()=>{ f.type=ft.value; f.cat=""; render(); };
      const fclr=document.getElementById("f_clear"); if(fclr) fclr.onclick=()=>{ f={kw:"",type:"產品",cat:"",onlyActive:true}; render(); };
    }
    c.querySelectorAll("[data-elemcat]").forEach(el=>el.onclick=()=>{ f.cat=el.dataset.elemcat; render(); });
    c.querySelectorAll("[data-add]").forEach(el=>el.onclick=()=>{ addLine(el.dataset.add); render(); });

    // 報價
    const cust=document.getElementById("q_customer"); if(cust) cust.oninput=()=>{ quote.customer=cust.value; save(); };
    const head=document.getElementById("q_head"); if(head) head.onchange=()=>{ quote.headcount=parseInt(head.value)||0; save(); render(); };
    const mk=document.getElementById("q_markup"); if(mk) mk.oninput=()=>{ quote.markup=parseFloat(mk.value)||0; save(); refreshSummary(); };
    const hf=document.getElementById("q_headfill"); if(hf) hf.onclick=()=>{
      quote.lines.forEach(l=>{ if(l.unit==="人") l.qty=quote.headcount; }); save(); render(); toast("已套用人數");
    };
    c.querySelectorAll("[data-q]").forEach(el=>el.onchange=()=>{ const l=quote.lines[+el.dataset.q]; l.qty=parseFloat(el.value)||0; l.tpl=false; save(); render(); });
    c.querySelectorAll("[data-p]").forEach(el=>el.onchange=()=>{ const l=quote.lines[+el.dataset.p]; l.unitPrice=parseFloat(el.value)||0; l.tpl=false; save(); render(); });
    c.querySelectorAll("[data-del]").forEach(el=>el.onclick=()=>{ quote.lines.splice(+el.dataset.del,1); save(); render(); });
    // 行程段：改名 / 把某列移到別段
    c.querySelectorAll("[data-grename]").forEach(el=>el.onchange=()=>{
      const oldG=el.dataset.grename, newG=el.value.trim()||oldG;
      if(newG===oldG) return;
      quote.lines.forEach(l=>{ if((l.group||"其他元件")===oldG) l.group=newG; });
      if(activeGroup===oldG) activeGroup=newG;
      save(); render();
    });
    c.querySelectorAll("[data-move]").forEach(el=>el.onchange=()=>{ quote.lines[+el.dataset.move].group=el.value; save(); render(); });
    // 快速加成本元件 → 跳到找產品並篩好該類元件
    c.querySelectorAll("[data-quick]").forEach(el=>el.onclick=()=>{ briefOn=false; f={kw:el.dataset.quick,type:"元件",cat:"",onlyActive:true}; view="search"; render(); toast("挑一個元件按「加入規劃」，會加到目前方案"); });
    const csv=document.getElementById("q_csv"); if(csv) csv.onclick=exportCSV;
    const clr=document.getElementById("q_clear"); if(clr) clr.onclick=()=>{ if(confirm("確定清空報價單？")){ quote=newQuote(); save(); render(); } };
    const qs=document.getElementById("q_save"); if(qs) qs.onclick=saveQuote;

    // 提案
    const pc=document.getElementById("p_copy"); if(pc) pc.onclick=()=>copyText(document.getElementById("draftBox").textContent,"已複製提案草稿");
    const psv=document.getElementById("p_save"); if(psv) psv.onclick=saveProposal;
    const pd=document.getElementById("p_dl"); if(pd) pd.onclick=()=>downloadMd();

    // 過去提案搜尋
    const pkw=document.getElementById("pf_kw");
    if(pkw){
      let tmr; pkw.oninput=()=>{ clearTimeout(tmr); tmr=setTimeout(()=>{ pf.kw=pkw.value; rerenderProposals(); },200); };
      const bp=(id,key)=>{ const el=document.getElementById(id); if(el) el.onchange=()=>{ pf[key]=el.value; rerenderProposals(); }; };
      bp("pf_city","city"); bp("pf_duration","duration"); bp("pf_head","head"); bp("pf_purpose","purpose");
      document.getElementById("pf_clear").onclick=()=>{ pf={kw:"",city:"",duration:"",head:"",purpose:""}; render(); };
    }

    // 行程成本範本
    const tpull=document.getElementById("tpl_pull"); if(tpull) tpull.onclick=async()=>{ setSync("saving","載入中…"); await cloudPull(); render(); };
    const tlogout=document.getElementById("tpl_logout"); if(tlogout) tlogout.onclick=()=>logout();
    const tusers=document.getElementById("tpl_users"); if(tusers) tusers.onclick=()=>openUsersModal();
    const tt=document.getElementById("tpl_tour"); if(tt) tt.onchange=()=>{ const v=tt.value; if(!v){ tplTour=""; tplDraft=null; render(); return; } tplDraft=null; tplHistOpen=false; tplTour=v; tplKw=""; render(); };
    const tkw=document.getElementById("tpl_kw");
    if(tkw){
      let tm; tkw.oninput=()=>{ clearTimeout(tm); tm=setTimeout(()=>{ tplKw=tkw.value; const pl=document.getElementById("tplPickList"); if(pl){ pl.innerHTML=tplPickList(); bindTplAdd(); } },200); };
    }
    bindTplAdd();
    // 進/出「建立新版本」編輯模式（草稿在記憶體，改完一次存成一個版本）
    const tbegin=document.getElementById("tpl_beginedit"); if(tbegin) tbegin.onclick=()=>requireLogin(()=>{
      const o=TEMPLATES[tplTour]||{items:[]};
      tplDraft={id:tplTour, name:o.name||(ALL.find(p=>p.id===tplTour)||{}).name||"", items:(o.items||[]).map(it=>Object.assign({},it))};
      render();
    });
    const tcancel=document.getElementById("tpl_canceledit"); if(tcancel) tcancel.onclick=()=>{ tplDraft=null; render(); };
    const tsave=document.getElementById("tpl_savever"); if(tsave) tsave.onclick=()=>{
      if(!tplDraft) return;
      const o=TEMPLATES[tplTour]||{};
      const note=(document.getElementById("tpl_note")||{}).value||"";
      tplNotes[tplTour]=note.trim();
      const keep={name:tplDraft.name, items:tplDraft.items.map(it=>Object.assign({},it)), rev:o.rev||0};
      if(o.conflictOf) keep.conflictOf=o.conflictOf;
      TEMPLATES[tplTour]=keep;
      tplDraft=null;
      saveTpls(tplTour);   // 一次送出＝一個新版本
      render(); toast("已儲存為新版本");
    };
    const thist=document.getElementById("tpl_histtoggle"); if(thist) thist.onclick=()=>{ tplHistOpen=!tplHistOpen; render(); };
    c.querySelectorAll("[data-tplrestore]").forEach(el=>el.onclick=()=>{
      const rv=+el.dataset.tplrestore; const o=TEMPLATES[tplTour]||{}; const h=(o.history||[]).find(x=>x.rev===rv);
      if(!h) return;
      requireLogin(()=>{ if(!confirm(`還原成第 ${rv} 版？會以此版內容建立一個新版本（目前版本仍會留在歷史）。`)) return;
        tplNotes[tplTour]=`還原自第 ${rv} 版`;
        const keep={name:h.name||o.name, items:(h.items||[]).map(it=>Object.assign({},it)), rev:o.rev||0};
        if(o.conflictOf) keep.conflictOf=o.conflictOf;
        TEMPLATES[tplTour]=keep; saveTpls(tplTour); render(); toast("已還原第 "+rv+" 版");
      });
    });
    // 編輯草稿內的列操作（只動草稿、不即時同步；儲存才成版本）
    c.querySelectorAll("[data-tplmode]").forEach(el=>el.onchange=()=>{ if(!tplDraft) return; tplDraft.items[+el.dataset.tplmode].mode=el.value; render(); });
    c.querySelectorAll("[data-tpln]").forEach(el=>el.onchange=()=>{ if(!tplDraft) return; tplDraft.items[+el.dataset.tpln].n=parseFloat(el.value)||1; });
    c.querySelectorAll("[data-tplprice]").forEach(el=>el.onchange=()=>{ if(!tplDraft) return; tplDraft.items[+el.dataset.tplprice].unitPrice=parseFloat(el.value)||0; });
    c.querySelectorAll("[data-tpldel]").forEach(el=>el.onclick=()=>{ if(!tplDraft) return; tplDraft.items.splice(+el.dataset.tpldel,1); render(); });
    // 總覽：編輯（檢視）/ 刪除整份 / 還原已刪除
    c.querySelectorAll("[data-tpledit]").forEach(el=>el.onclick=()=>{ tplTour=el.dataset.tpledit; tplDraft=null; tplHistOpen=false; tplKw=""; render(); });
    c.querySelectorAll("[data-tplwipe]").forEach(el=>el.onclick=()=>{ const id=el.dataset.tplwipe; const nm=(TEMPLATES[id]&&TEMPLATES[id].name)||id; requireLogin(()=>{ if(confirm(`刪除「${nm}」的整份成本範本？會移到「已刪除」可還原，並記錄是誰刪的。`)){ delTpl(id); render(); toast("已刪除範本"); } }); });
    c.querySelectorAll("[data-tplrestoredel]").forEach(el=>el.onclick=()=>restoreTpl(el.dataset.tplrestoredel));
    // 編輯卡：回總覽 / 刪除 / 複製到另一條行程
    const tback=c.querySelector("[data-tplback]"); if(tback) tback.onclick=()=>{ tplTour=""; tplDraft=null; render(); };
    const twipe=document.getElementById("tpl_wipe"); if(twipe) twipe.onclick=()=>requireLogin(()=>{ if(confirm("刪除此範本？會移到「已刪除」可還原，並記錄是誰刪的。")){ delTpl(tplTour); tplTour=""; render(); toast("已刪除範本"); } });
    const tdup=document.getElementById("tpl_dupbtn"); if(tdup) tdup.onclick=()=>requireLogin(()=>{
      const sel=document.getElementById("tpl_dupto"); const dst=sel&&sel.value; if(!dst) return;
      const src=TEMPLATES[tplTour]; if(!src||!src.items||!src.items.length){ toast("這份範本是空的"); return; }
      const dstName=(ALL.find(p=>p.id===dst)||{}).name||dst;
      if(TEMPLATES[dst]&&TEMPLATES[dst].items&&TEMPLATES[dst].items.length && !confirm(`「${dstName}」已有範本，確定覆蓋？`)) return;
      tplNotes[dst]=`從「${(ALL.find(p=>p.id===tplTour)||{}).name||tplTour}」複製`;
      TEMPLATES[dst]={name:dstName, items:src.items.map(it=>Object.assign({},it)), rev:(TEMPLATES[dst]&&TEMPLATES[dst].rev)||0};
      saveTpls(dst); tplTour=dst; tplDraft=null; tplKw=""; render(); toast("已複製到："+dstName);
    });
    function bindTplAdd(){
      document.querySelectorAll("[data-tpladd]").forEach(el=>el.onclick=()=>{
        if(!tplDraft) return;
        const m=ALL.find(x=>x.id===el.dataset.tpladd); if(!m) return;
        if(tplDraft.items.some(it=>it.id===m.id)){ toast("已在範本中"); return; }
        // 依元件名稱猜一個合理的數量規則與 N（業務可再改）
        let mode="fixed", n=1;
        if(/帶路人|導覽員|人力/.test(m.name)){ mode="perGroup"; n=25; }
        else if(/大巴|遊覽車/.test(m.name)){ mode="perGroup"; n=43; }
        else if(/中巴|小巴/.test(m.name)){ mode="perGroup"; n=20; }
        else if(/巴士/.test(m.name)){ mode="perGroup"; n=43; }
        else if(/保險|便當|餐|門票|體驗/.test(m.name)||m.unit==="人"){ mode="perPerson"; }
        tplDraft.items.push({id:m.id,name:m.name,unit:m.unit||"項",unitPrice:m.unitPrice||0,mode,n});
        render(); toast("已加入："+m.name);
      });
    }
  }

  function rerenderProposals(){
    const list=applyProposalFilters();
    const cnt=document.querySelector(".count"); if(cnt) cnt.innerHTML=`符合條件：<b>${list.length}</b> 筆`;
    const grid=document.getElementById("pgrid"); if(grid) grid.innerHTML=list.slice(0,300).map(proposalCard).join("")||'<div class="empty">沒有符合條件的提案</div>';
  }

  function rerenderSearch(){
    const c=document.getElementById("content");
    const list=applyFilters();
    const cnt=c.querySelector(".count"); if(cnt) cnt.innerHTML=`符合條件：<b>${list.length}</b> 項${list.length>300?"（僅顯示前 300）":""}`;
    const grid=document.getElementById("prodgrid"); if(!grid) return;
    grid.innerHTML = list.slice(0,300).map(productCard).join("")||'<div class="empty">沒有符合條件的產品</div>';
    grid.querySelectorAll("[data-add]").forEach(el=>el.onclick=()=>{ addLine(el.dataset.add); render(); });
  }

  function refreshSummary(){ const c=document.getElementById("content"); const s=c.querySelector(".summary"); if(s){ const t=totals();
    s.innerHTML=`<div class="row"><span>成本合計</span><span class="v">NT$ ${nf(t.cost)}</span></div>
      <div class="row"><span>成本／人（${t.H} 人）</span><span class="v">NT$ ${nf(Math.round(t.costPP))}</span></div>
      <div class="row"><span>利潤加成</span><span class="v">${t.m}%</span></div>
      <div class="row big"><span>建議售價</span><span class="v">NT$ ${nf(t.price)}</span></div>
      <div class="row big"><span>每人單價</span><span class="v">NT$ ${nf(Math.round(t.pricePP))}</span></div>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        <button class="btn ok sm" data-go="proposal">產生提案草稿</button>
            <button class="btn sm" id="q_save">💾 存報價（Drive＋Zoho）</button>
        <button class="btn ghost sm" id="q_csv">匯出 CSV</button>
        <button class="btn ghost sm" id="q_clear">清空</button></div>`;
    bind();
  } }

  function exportCSV(){
    const t=totals();
    let rows=[["行程段","項目","類型","數量","單位","單價","小計"]];
    groupsOf().forEach(g=>{
      const items=quote.lines.filter(l=>(l.group||"其他元件")===g);
      items.forEach(l=>rows.push([g,l.name,l.type,l.qty,l.unit,l.unitPrice,(Number(l.qty)||0)*(Number(l.unitPrice)||0)]));
      rows.push([g+" 小計","","","","","",items.reduce((s,l)=>s+(Number(l.qty)||0)*(Number(l.unitPrice)||0),0)]);
    });
    rows.push([]); rows.push(["成本合計","","","","","",t.cost]);
    rows.push([`建議售價(含${t.m}%)`,"","","","","",t.price]);
    rows.push(["每人單價","","","","","",Math.round(t.pricePP)]);
    const csv="﻿"+rows.map(r=>r.map(x=>`"${String(x==null?"":x).replace(/"/g,'""')}"`).join(",")).join("\r\n");
    dl(csv, `報價_${quote.customer||"未命名"}.csv`, "text/csv");
    toast("已匯出 CSV");
  }
  function downloadMd(){ dl(buildDraft(), `提案_${quote.customer||"未命名"}.md`, "text/markdown"); toast("已下載 .md"); }

  // ---- 回存 Drive / Zoho（需經部署版後端）----
  async function postJSON(path, payload){
    // 通行證是 cookie，瀏覽器自動帶（同源）
    const r = await fetch(API_BASE + path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    if(!r.ok){ const err=new Error("HTTP "+r.status); err.status=r.status; try{ err.data=await r.json(); }catch(e){} throw err; }
    return r.json();
  }
  function resultsToast(res){
    const parts=(res.results||[]).map(x=>`${x.target}：${x.ok?"✓":"✗ "+(x.reason||"")}`);
    toast(parts.join("　") || "已送出");
  }
  async function saveQuote(){
    if(!API_BASE && API_BASE!==""){ toast("此為試用版，回存需用部署版（線上版）"); return; }
    const t=totals();
    const payload={ kind:"quote", customer:quote.customer, headcount:quote.headcount, markup:quote.markup,
      duration:quote.duration, lines:quote.lines, cost:t.cost, price:t.price, pricePP:Math.round(t.pricePP) };
    try{ resultsToast(await postJSON("/api/save-quote", payload)); }
    catch(e){ toast("回存失敗（後端未啟動？）"); }
  }
  async function saveProposal(){
    if(!API_BASE && API_BASE!==""){ toast("此為試用版，回存需用部署版（線上版）"); return; }
    const prods=quote.lines.filter(l=>l.type==="產品").map(l=>{ const p=ALL.find(x=>x.id===l.id)||{}; return {name:l.name,city:p.area&&p.area[0],spots:p.area}; });
    const payload={ kind:"proposal", customer:quote.customer, headcount:quote.headcount,
      pricePP:Math.round(totals().pricePP), draft:buildDraft(), products:prods };
    try{ resultsToast(await postJSON("/api/save-proposal", payload)); }
    catch(e){ toast("回存失敗（後端未啟動？）"); }
  }
  function dl(content, name, type){
    const blob=new Blob([content],{type:type+";charset=utf-8"}); const u=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=u; a.download=name; a.click(); URL.revokeObjectURL(u);
  }
  function copyText(text,msg){
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(()=>toast(msg)).catch(()=>fb());
    else fb();
    function fb(){ const ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); try{document.execCommand("copy");toast(msg);}catch(e){toast("複製失敗");} document.body.removeChild(ta); }
  }

  // 意見回饋（側欄按鈕，只綁一次）
  function openFeedback(){
    if(FEEDBACK_URL){ window.open(FEEDBACK_URL,"_blank","noopener"); return; }
    const subject=encodeURIComponent("【產品與報價工具】試用回饋");
    const body=encodeURIComponent(
      "（謝謝試用！請簡單描述，幫助我們改進）\n\n"+
      "1. 我在用哪個功能：（產品搜尋／報價試算／提案產生／過去提案）\n"+
      "2. 遇到的問題或不順：\n"+
      "3. 希望增加或改善：\n"+
      "4. 資料有錯或缺漏的地方：\n");
    window.location.href=`mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
  }
  const fbBtn=document.getElementById("feedbackBtn");
  if(fbBtn) fbBtn.onclick=openFeedback;

  render();
  // 取得登入身分與設定後重繪（cookie 由瀏覽器自動帶；app 能載入即代表已登入）
  Promise.all([loadMe(), loadServerConfig()]).then(()=>{ if(view==="template") render(); });
  cloudPull();      // 部署版：開啟時先把雲端共用範本拉下來（試用版會自動略過）
})();
