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
  let f = { kw:"", type:"產品", onlyActive:true };
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
        <input class="inp search-inp" id="f_kw" value="${esc(f.kw)}" placeholder="例：淨灘、大稻埕、印花樂、藍色公路"></div>
      <div class="fg"><label>類型</label><select id="f_type"><option value="">全部</option><option value="產品" ${f.type==="產品"?"selected":""}>主行程</option><option value="元件" ${f.type==="元件"?"selected":""}>成本元件</option></select></div>
      <button class="btn ghost sm" id="f_clear">清除</button>
    </div>`;
    const cards = list.slice(0,300).map(productCard).join("");
    return propPanel + filters +
      `<div style="font-weight:800;font-size:14px;margin:6px 0 8px">符合需求的產品</div>
      <div class="count">符合條件：<b>${list.length}</b> 項${list.length>300?"（僅顯示前 300）":""}</div>
      <div class="pgrid" id="prodgrid">${cards||'<div class="empty">沒有符合條件的產品（可放寬需求或關掉「依需求篩選」）</div>'}</div>`;
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
    // 方案分段：二日/三日 → 同一個方案（兩天放一起）；半日/一日 → 每個主行程各一個方案（各一張 sheet）
    let group;
    if(p.type==="產品"){
      group = multiDay ? (activeGroup || (quote.duration+"行程方案")) : shortName(p.name);
      activeGroup = group;
    } else {
      group = activeGroup || "其他元件";
    }
    quote.lines.push({
      id:p.id, name:p.name, type:p.type, unit:p.unit||"項",
      qty, unitPrice, priceRange:p.priceRange||"", group
    });
    // 加入主行程時：自動帶入一套成本範本（先試算，業務再核對調整）
    if(p.type==="產品") addCostTemplate(group, multiDay);
    save(); toast("已加入："+p.name+"（已帶入成本範本，請核對）");
  }
  function shortName(name){ return String(name).split(/[｜|]/)[0].slice(0,18) || name.slice(0,18); }

  // 找一個有單價的代表性元件
  function pickComp(){ const terms=[].slice.call(arguments);
    for(const t of terms){ const p=ALL.find(x=>x.type==="元件"&&x.active&&x.name.indexOf(t)>=0&&Number(x.unitPrice)>0); if(p) return p; }
    return null;
  }
  // 一日成本範本：帶路人(每25人1位)、餐食、交通(每43人1台)、保險、體驗(待填) — 依人數試算
  function addCostTemplate(group, multiDay){
    const H=quote.headcount||1;
    const push=(p,qty)=>{ if(p) quote.lines.push({id:p.id,name:p.name,type:"元件",unit:p.unit||"項",qty,unitPrice:p.unitPrice||0,priceRange:"",group}); };
    push(pickComp("帶路人 4000","帶路人","導覽員 1600","導覽員"), Math.max(1,Math.ceil(H/25)));
    push(pickComp("便當","司領餐","餐食"), H);
    push(pickComp("43座大巴","大巴","遊覽車"), Math.max(1,Math.ceil(H/43)));
    push(pickComp("國內一日","保險"), H);
    // 體驗/門票：資料庫無拆解，放一筆提醒（紅色）讓業務填
    quote.lines.push({id:"_exp_"+Math.random().toString(36).slice(2,7), name:"體驗／門票／其他（請填每人成本）", type:"元件", unit:"人", qty:H, unitPrice:0, priceRange:"", group});
    // 二日/三日：方案內若還沒有住宿，補一筆住宿
    if(multiDay && !quote.lines.some(l=>(l.group===group)&&/住宿/.test(l.name))){
      const acc=ALL.find(x=>x.type==="元件"&&x.name.indexOf("住宿")>=0&&x.active);
      if(acc) push(acc, H);
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
      const nameNote = isProd
        ? `<div style="font-size:11px;color:var(--muted)">參考售價：${l.priceRange?esc(l.priceRange):"未定"}（成本請用下方元件組成，不列入成本）</div>`
        : (noPrice ? `<div style="font-size:11px;color:var(--danger)">⚠️ 請填單價</div>` : "");
      return `<tr>
        <td><span class="pill ${isProd?"prod":"comp"}">${isProd?"行程":"元件"}</span></td>
        <td>${esc(l.name)}${nameNote}</td>
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
    const dayHint = (quote.duration==="二日"||quote.duration==="三日") ? `<div class="hint" style="margin:0;border-radius:0;border-left:none;border-right:none;background:#eff6ff;border-color:#bfdbfe;color:#1e40af">🗓️ ${esc(quote.duration)}行程＝同一個方案（同一張報價分頁）：兩天的行程都加進來，已自動帶入<b>住宿</b>一列，記得補各天的餐食／交通／導覽元件並填價。</div>` : "";
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
    L.push(`## 推薦行程`);
    if(prods.length){
      prods.forEach(l=>{
        const p=ALL.find(x=>x.id===l.id)||{};
        L.push(`### ${l.name}`);
        if(p.area&&p.area.length) L.push(`- 地區：${p.area.join("、")}`);
        if(p.capacity) L.push(`- 建議人數：${p.capacity}`);
        if(p.priceRange) L.push(`- 定價參考：${p.priceRange}`);
        if(p.topics&&p.topics.length) L.push(`- 亮點：${p.topics.join("、")}`);
        if(p.url) L.push(`- 詳細介紹：${p.url}`);
        L.push("");
      });
    } else { L.push("（尚未加入主行程，請於產品搜尋加入「行程」類項目）"); L.push(""); }
    L.push(`## 報價明細（依行程段）`);
    L.push("");
    groupsOf().forEach(g=>{
      const items=quote.lines.filter(l=>(l.group||"其他元件")===g);
      const gsub=items.reduce((s,l)=>s+(Number(l.qty)||0)*(Number(l.unitPrice)||0),0);
      L.push(`**${g}**`);
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
      const ft=document.getElementById("f_type"); if(ft) ft.onchange=()=>{ f.type=ft.value; rerenderSearch(); };
      const fclr=document.getElementById("f_clear"); if(fclr) fclr.onclick=()=>{ f={kw:"",type:"產品",onlyActive:true}; render(); };
    }
    c.querySelectorAll("[data-add]").forEach(el=>el.onclick=()=>{ addLine(el.dataset.add); render(); });

    // 報價
    const cust=document.getElementById("q_customer"); if(cust) cust.oninput=()=>{ quote.customer=cust.value; save(); };
    const head=document.getElementById("q_head"); if(head) head.onchange=()=>{ quote.headcount=parseInt(head.value)||0; save(); render(); };
    const mk=document.getElementById("q_markup"); if(mk) mk.oninput=()=>{ quote.markup=parseFloat(mk.value)||0; save(); refreshSummary(); };
    const hf=document.getElementById("q_headfill"); if(hf) hf.onclick=()=>{
      quote.lines.forEach(l=>{ if(l.unit==="人") l.qty=quote.headcount; }); save(); render(); toast("已套用人數");
    };
    c.querySelectorAll("[data-q]").forEach(el=>el.onchange=()=>{ quote.lines[+el.dataset.q].qty=parseFloat(el.value)||0; save(); render(); });
    c.querySelectorAll("[data-p]").forEach(el=>el.onchange=()=>{ quote.lines[+el.dataset.p].unitPrice=parseFloat(el.value)||0; save(); render(); });
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
    c.querySelectorAll("[data-quick]").forEach(el=>el.onclick=()=>{ briefOn=false; f={kw:el.dataset.quick,type:"元件",onlyActive:true}; view="search"; render(); toast("挑一個元件按「加入規劃」，會加到目前方案"); });
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
    const r = await fetch(API_BASE + path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    if(!r.ok) throw new Error("HTTP "+r.status);
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
      lines:quote.lines, cost:t.cost, price:t.price, pricePP:Math.round(t.pricePP) };
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
})();
