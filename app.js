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

  let view = "search";
  let quote = load();
  // 搜尋條件
  let f = { kw:"", type:"", cat:"", area:"", fit:"", onlyActive:true };
  // 過去提案搜尋條件
  let pf = { kw:"", city:"", duration:"", head:"", purpose:"" };

  function load(){
    try{ return JSON.parse(localStorage.getItem(LS)) || newQuote(); }
    catch(e){ return newQuote(); }
  }
  function newQuote(){ return { customer:"", headcount:30, markup:20, lines:[] }; }
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
      search:["產品搜尋","依客戶需求快速找到合適行程與元件"],
      quote:["報價試算","疊加元件、套利潤，自動算出總價與人均"],
      proposal:["提案產生","依選定行程與報價，產出提案草稿"],
      past:["過去提案搜尋","291 筆歷史提案，依需求找最接近的舊案參考"],
    };
    const t=titles[view];
    document.getElementById("pageTitle").textContent=t[0];
    document.getElementById("pageSub").textContent=t[1];
    const c=document.getElementById("content");
    if(view==="search") c.innerHTML=renderSearch();
    else if(view==="quote") c.innerHTML=renderQuote();
    else if(view==="proposal") c.innerHTML=renderProposal();
    else if(view==="past") c.innerHTML=renderPast();
    bind();
  }

  // ---------- 搜尋 ----------
  function applyFilters(){
    const kw=f.kw.trim().toLowerCase();
    return ALL.filter(p=>{
      if(f.onlyActive && !p.active) return false;
      if(f.type && p.type!==f.type) return false;
      if(f.cat && p.category!==f.cat) return false;
      if(f.area && !(p.area||[]).includes(f.area)) return false;
      if(f.fit){ const h=parseInt(f.fit); if(h && !fitsHeadcount(p,h)) return false; }
      if(kw){
        const hay=[p.name,p.category,(p.topics||[]).join(" "),(p.esg||[]).join(" "),(p.area||[]).join(" "),p.note,p.priceRange].join(" ").toLowerCase();
        if(!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  function priceLabel(p){
    if(p.unitPrice!=null) return `NT$ ${nf(p.unitPrice)} / ${esc(p.unit||"單位")}`;
    if(p.priceRange) return esc(p.priceRange);
    return "定價未定（需客製）";
  }

  function renderSearch(){
    const list=applyFilters();
    const opt=(arr,sel)=>arr.map(v=>`<option ${v===sel?"selected":""}>${esc(v)}</option>`).join("");
    const filters=`<div class="filters">
      <div class="fg" style="flex:1"><label>關鍵字（行程名、主題、ESG…）</label>
        <input class="inp search-inp" id="f_kw" value="${esc(f.kw)}" placeholder="例：淨灘、大稻埕、家庭日、永續"></div>
      <div class="fg"><label>類型</label><select id="f_type"><option value="">全部</option><option value="產品" ${f.type==="產品"?"selected":""}>主行程（產品）</option><option value="元件" ${f.type==="元件"?"selected":""}>成本元件</option></select></div>
      <div class="fg"><label>分類</label><select id="f_cat"><option value="">全部分類</option>${opt(CATS,f.cat)}</select></div>
      <div class="fg"><label>地區</label><select id="f_area"><option value="">全部地區</option>${opt(AREAS,f.area)}</select></div>
      <div class="fg"><label>適合人數</label><input class="inp" id="f_fit" style="width:90px" value="${esc(f.fit)}" placeholder="如 40" inputmode="numeric"></div>
      <button class="btn ghost sm" id="f_clear">清除</button>
    </div>`;
    const cards = list.slice(0,300).map(p=>{
      const topics=(p.topics||[]).slice(0,3).map(t=>`<span class="tag topic">${esc(t)}</span>`).join("");
      const esgs=(p.esg||[]).slice(0,2).map(t=>`<span class="tag esg">♻ ${esc(t)}</span>`).join("");
      const driveLink = extractDrive(p.note);
      return `<div class="card pcard">
        <div class="ptags">
          <span class="tag cat">${esc(p.category)}</span>
          ${(p.area||[]).map(a=>`<span class="tag area">${esc(a)}</span>`).join("")}
        </div>
        <h3>${esc(p.name)}</h3>
        <div class="price">${priceLabel(p)}</div>
        ${p.capacity?`<div class="meta">建議人數：${esc(p.capacity)}</div>`:""}
        ${p.noServe?`<div class="meta">⛔ ${esc(p.noServe)}</div>`:""}
        ${(topics||esgs)?`<div class="ptags">${topics}${esgs}</div>`:""}
        ${p.note?`<div class="note">${esc(p.note).slice(0,150)}${p.note.length>150?"…":""}</div>`:""}
        <div class="row">
          <button class="btn sm" data-add="${esc(p.id)}">＋ 加入報價</button>
          ${p.url?`<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">官網↗</a>`:""}
          ${driveLink?`<a class="link" href="${esc(driveLink)}" target="_blank" rel="noopener">素材↗</a>`:""}
        </div>
      </div>`;
    }).join("");
    return `<div class="hint info">🔍 共 <b>${ALL.length}</b> 項產品（主行程 + 成本元件）。用關鍵字或篩選找到合適項目，點「加入報價」帶進報價試算。資料為 Zoho 快照。</div>
      ${filters}
      <div class="count">符合條件：<b>${list.length}</b> 項${list.length>300?"（僅顯示前 300）":""}</div>
      <div class="pgrid">${cards||'<div class="empty">沒有符合條件的產品</div>'}</div>`;
  }

  function extractDrive(note){
    if(!note) return null;
    const m=String(note).match(/https:\/\/drive\.google\.com\/\S+/);
    return m?m[0].replace(/[)\s]+$/,""):null;
  }

  // ---------- 報價試算 ----------
  function addLine(id){
    const p=ALL.find(x=>x.id===id); if(!p) return;
    if(quote.lines.find(l=>l.id===id)){ toast("已在報價單中"); return; }
    const perPerson = p.unit==="人";
    quote.lines.push({
      id:p.id, name:p.name, type:p.type, unit:p.unit||"項",
      qty: perPerson? (quote.headcount||1) : 1,
      unitPrice: p.unitPrice!=null? p.unitPrice : 0,
      priceRange: p.priceRange||""
    });
    save(); toast("已加入報價："+p.name);
  }

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
    const rows=quote.lines.map((l,i)=>`<tr>
      <td><span class="pill ${l.type==="產品"?"prod":"comp"}">${l.type==="產品"?"行程":"元件"}</span></td>
      <td>${esc(l.name)}${l.priceRange&&l.unitPrice===0?`<div style="font-size:11px;color:var(--muted)">參考定價：${esc(l.priceRange)}</div>`:""}</td>
      <td class="num"><input class="qty-inp" type="number" min="0" data-q="${i}" value="${esc(l.qty)}"></td>
      <td style="color:var(--muted);font-size:12px">${esc(l.unit)}</td>
      <td class="num"><input class="price-inp" type="number" min="0" data-p="${i}" value="${esc(l.unitPrice)}"></td>
      <td class="num"><b>${nf((Number(l.qty)||0)*(Number(l.unitPrice)||0))}</b></td>
      <td><button class="lineDel" data-del="${i}" title="移除">×</button></td>
    </tr>`).join("");
    return `<div class="qwrap">
      <div class="card" style="overflow:hidden">
        <div style="display:flex;gap:14px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--line)">
          <div class="fg"><label>客戶名稱</label><input class="inp" id="q_customer" value="${esc(quote.customer)}" placeholder="企業名稱"></div>
          <div class="fg"><label>人數</label><input class="inp" id="q_head" type="number" min="1" style="width:90px" value="${esc(quote.headcount)}"></div>
          <div class="fg"><label>利潤加成 %</label><input class="inp" id="q_markup" type="number" min="0" style="width:90px" value="${esc(quote.markup)}"></div>
          <div class="fg" style="justify-content:flex-end"><button class="btn ghost sm" id="q_headfill">人數套用到「以人計價」項目</button></div>
        </div>
        <div style="overflow:auto"><table>
          <thead><tr><th></th><th>項目</th><th class="num">數量</th><th>單位</th><th class="num">單價</th><th class="num">小計</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
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
        <div class="hint" style="margin-top:14px">主行程（行程）的定價多為「每人區間」，加入後單價預設 0，請參考列上的「參考定價」依人數填入每人售價或整團成本。</div>
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
    L.push(`## 報價明細`);
    L.push("");
    L.push("| 項目 | 數量 | 單位 | 單價 | 小計 |");
    L.push("|---|---:|---|---:|---:|");
    quote.lines.forEach(l=>{
      L.push(`| ${l.name} | ${l.qty} | ${l.unit} | ${nf(l.unitPrice)} | ${nf((Number(l.qty)||0)*(Number(l.unitPrice)||0))} |`);
    });
    L.push(`| **成本合計** | | | | **${nf(t.cost)}** |`);
    L.push(`| **建議售價（含 ${t.m}% 加成）** | | | | **${nf(t.price)}** |`);
    L.push(`| **每人單價** | | | | **${nf(Math.round(t.pricePP))}** |`);
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

    // 搜尋篩選
    const kw=document.getElementById("f_kw");
    if(kw){
      let tmr;
      kw.oninput=()=>{ clearTimeout(tmr); tmr=setTimeout(()=>{ f.kw=kw.value; rerenderSearch(); },200); };
      const bindSel=(id,key)=>{ const el=document.getElementById(id); if(el) el.onchange=()=>{ f[key]=el.value; rerenderSearch(); }; };
      bindSel("f_type","type"); bindSel("f_cat","cat"); bindSel("f_area","area");
      const fit=document.getElementById("f_fit"); if(fit) fit.oninput=()=>{ let tm; clearTimeout(fit._t); fit._t=setTimeout(()=>{ f.fit=fit.value; rerenderSearch(); },250); };
      document.getElementById("f_clear").onclick=()=>{ f={kw:"",type:"",cat:"",area:"",fit:"",onlyActive:true}; render(); };
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
    // 只重繪清單與計數，保留輸入焦點
    const list=applyFilters();
    const cnt=c.querySelector(".count"); if(cnt) cnt.innerHTML=`符合條件：<b>${list.length}</b> 項${list.length>300?"（僅顯示前 300）":""}`;
    const grid=c.querySelector(".pgrid"); if(!grid) return;
    grid.innerHTML = list.slice(0,300).map(p=>{
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
        <div class="row"><button class="btn sm" data-add="${esc(p.id)}">＋ 加入報價</button>
          ${p.url?`<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">官網↗</a>`:""}
          ${driveLink?`<a class="link" href="${esc(driveLink)}" target="_blank" rel="noopener">素材↗</a>`:""}
        </div></div>`;
    }).join("")||'<div class="empty">沒有符合條件的產品</div>';
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
    let rows=[["項目","類型","數量","單位","單價","小計"]];
    quote.lines.forEach(l=>rows.push([l.name,l.type,l.qty,l.unit,l.unitPrice,(Number(l.qty)||0)*(Number(l.unitPrice)||0)]));
    rows.push([]); rows.push(["成本合計","","","","",t.cost]);
    rows.push([`建議售價(含${t.m}%)`,"","","","",t.price]);
    rows.push(["每人單價","","","","",Math.round(t.pricePP)]);
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
