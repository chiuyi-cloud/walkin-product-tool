#!/usr/bin/env python3
"""
島內散步｜產品與報價工具 — 後端（上線 + 回存版骨架）

職責：
- 代管靜態網頁（index.html / app.js / products.js / proposals.js）
- 接收前端「存報價 / 存提案」的提交，代為寫回 Google Drive / Zoho CRM
- 寫入功能採「設定才啟用」：未設定金鑰時，提交會先存到本機 submissions/，
  並回報哪些目的地尚未設定，方便先把前後端流程跑通，金鑰到位再接上。

設定（環境變數，見 config.example.env）：
  GOOGLE_SA_JSON     服務帳號金鑰檔路徑（Drive/Sheets/Docs）
  GDRIVE_QUOTE_FOLDER  報價試算表要放的資料夾 ID
  GDRIVE_PROPOSAL_FOLDER 提案要放的資料夾 ID（07-02）
  INDEX_SHEET_ID     2B提案簡報檢索表的試算表 ID
  ZOHO_REFRESH_TOKEN / ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_API_DOMAIN
  AUTH_USER / AUTH_PASS  整站基本驗證（選填）

啟動： python3 server.py        （預設 port 4181）
"""
import base64, hashlib, hmac, json, os, re, threading, time, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "4181"))
SUB_DIR = os.path.join(BASE_DIR, "submissions")

AUTH_USER = os.environ.get("AUTH_USER")
AUTH_PASS = os.environ.get("AUTH_PASS")
AUTH_ENABLED = bool(AUTH_USER and AUTH_PASS)

# ── 個人登入：簽章密鑰（固定才能跨重新部署保留登入）＋ 第一位管理員 ──
SESSION_SECRET = os.environ.get("SESSION_SECRET") or os.urandom(32).hex()  # 沒設＝臨時，重部署需重登
SESSION_TTL = int(os.environ.get("SESSION_TTL_DAYS", "30")) * 86400

# Google 登入（限定公司網域）
GOOGLE_OAUTH_CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
ALLOWED_DOMAIN = os.environ.get("ALLOWED_EMAIL_DOMAIN", "walkin.tw").strip().lower()
ADMIN_EMAILS = set(e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip())

# 密碼登入（預設關閉；只給本機開發或救生艇）
ALLOW_PASSWORD_LOGIN = os.environ.get("ALLOW_PASSWORD_LOGIN", "").strip().lower() in ("1", "true", "yes")
ADMIN_USER = os.environ.get("ADMIN_USER")        # 救生艇管理員帳號（需 ALLOW_PASSWORD_LOGIN）
ADMIN_PASS = os.environ.get("ADMIN_PASS")
ADMIN_NAME = os.environ.get("ADMIN_NAME", "管理員")

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/products.js": ("products.js", "application/javascript; charset=utf-8"),
    "/proposals.js": ("proposals.js", "application/javascript; charset=utf-8"),
    "/試用說明.md": ("試用說明.md", "text/markdown; charset=utf-8"),
}

_lock = threading.Lock()


def _now():
    # 注意：部署環境時區可能為 UTC；顯示用即可
    return datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")


def save_submission(kind, payload):
    """先把每筆提交存到本機 submissions/，確保資料不遺失、流程可驗證。"""
    os.makedirs(SUB_DIR, exist_ok=True)
    fn = f"{kind}_{_now()}_{os.urandom(3).hex()}.json"
    with _lock, open(os.path.join(SUB_DIR, fn), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return fn


# ---- Google 服務（用到時才載入函式庫，沒裝套件時伺服器照常運作）----
_google = {"svc": None}
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def google_configured():
    """金鑰可用檔案路徑(本機)或直接 JSON 內容(雲端環境變數)提供。"""
    return bool(os.environ.get("GOOGLE_SA_JSON") or os.environ.get("GOOGLE_SA_JSON_CONTENT"))


def _google_services():
    """建立並快取 Sheets / Drive service。"""
    if _google["svc"]:
        return _google["svc"]
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    content = os.environ.get("GOOGLE_SA_JSON_CONTENT")
    if content:  # 雲端：金鑰 JSON 直接放環境變數
        info = json.loads(content)
        creds = service_account.Credentials.from_service_account_info(info, scopes=GOOGLE_SCOPES)
    else:        # 本機：金鑰檔路徑
        creds = service_account.Credentials.from_service_account_file(
            os.environ["GOOGLE_SA_JSON"], scopes=GOOGLE_SCOPES)
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    _google["svc"] = (sheets, drive)
    return _google["svc"]


def _group_lines(q):
    """依行程段把項目分組，保留出現順序。回傳 [(段名, [項目...])]"""
    order, m = [], {}
    for l in q.get("lines", []):
        g = l.get("group") or "其他元件"
        if g not in m:
            m[g] = []; order.append(g)
        m[g].append(l)
    return [(g, m[g]) for g in order]


def _line_sub(l):
    return (l.get("qty", 0) or 0) * (l.get("unitPrice", 0) or 0)


def _sheet_rows(sheet_name, seglist):
    """一張報價分頁：可含多個行程段，每段列出元件＋數量＋小計，最後本頁合計。"""
    rows = [[f"報價分頁：{sheet_name}"], []]
    total = 0
    for seg, items in seglist:
        rows.append([f"▍行程：{seg}"])
        rows.append(["項目", "數量", "單位", "單價", "小計"])
        sub = 0
        for l in items:
            st = _line_sub(l); sub += st
            rows.append([l.get("name", ""), l.get("qty", 0) or 0, l.get("unit", ""), l.get("unitPrice", 0) or 0, st])
        rows += [["　行程小計", "", "", "", sub], []]
        total += sub
    rows.append(["本分頁成本合計", "", "", "", total])
    return rows


def _sheets_plan(q, groups):
    """決定分頁配置：二日/三日 → 所有行程段放同一張分頁；其餘 → 每段一張。"""
    if q.get("duration") in ("二日", "三日"):
        name = f"（{q.get('duration')}）行程方案"
        return [(name, groups)]
    return [(seg, [(seg, items)]) for seg, items in groups]


def _summary_rows(q, groups):
    """總表：客戶、人數、各行程段成本、合計、售價、人均。"""
    rows = [
        [f"報價單　客戶：{q.get('customer','')}"],
        [f"人數：{q.get('headcount','')}", f"利潤加成：{q.get('markup','')}%"],
        [], ["各行程段成本"],
    ]
    for gname, items in groups:
        rows.append([gname, "", "", "", sum(_line_sub(l) for l in items)])
    rows += [
        [],
        ["成本合計", "", "", "", q.get("cost", "")],
        [f"建議售價（含 {q.get('markup','')}% 加成）", "", "", "", q.get("price", "")],
        ["每人單價", "", "", "", q.get("pricePP", "")],
        [], [f"產生時間（UTC）：{_now()}"],
    ]
    return rows


def _safe_title(name, used):
    """工作表名稱：去除不合法字元、限長、避免重複。"""
    t = re.sub(r"[:\\/?*\[\]]", " ", str(name)).strip()[:28] or "行程"
    base, i = t, 2
    while t in used:
        t = f"{base[:24]} {i}"; i += 1
    used.add(t)
    return t


def write_quote_to_gsheet(quote):
    folder = os.environ.get("GDRIVE_QUOTE_FOLDER")
    if not google_configured():
        return {"target": "Google試算表", "ok": False, "reason": "尚未設定 Google 服務帳號"}
    if not folder:
        return {"target": "Google試算表", "ok": False, "reason": "尚未設定報價資料夾 ID（GDRIVE_QUOTE_FOLDER）"}
    try:
        sheets, drive = _google_services()
        title = f"報價_{quote.get('customer','未命名')}_{_now()}"
        f = drive.files().create(
            body={"name": title, "mimeType": "application/vnd.google-apps.spreadsheet", "parents": [folder]},
            fields="id, webViewLink", supportsAllDrives=True,
        ).execute()
        sid = f["id"]
        groups = _group_lines(quote)
        plan = _sheets_plan(quote, groups)   # [(分頁名, [(行程段, items)])]
        meta = sheets.spreadsheets().get(spreadsheetId=sid).execute()
        first_id = meta["sheets"][0]["properties"]["sheetId"]
        used = set()
        sum_title = _safe_title("總表", used)
        # 把預設工作表改名為「總表」，並為每張報價分頁各加一張工作表
        reqs = [{"updateSheetProperties": {"properties": {"sheetId": first_id, "title": sum_title}, "fields": "title"}}]
        tabs = []
        for sheet_name, seglist in plan:
            st = _safe_title(sheet_name, used); tabs.append((st, seglist))
            reqs.append({"addSheet": {"properties": {"title": st}}})
        sheets.spreadsheets().batchUpdate(spreadsheetId=sid, body={"requests": reqs}).execute()
        # 寫入各工作表內容
        data = [{"range": f"'{sum_title}'!A1", "values": _summary_rows(quote, groups)}]
        for st, seglist in tabs:
            data.append({"range": f"'{st}'!A1", "values": _sheet_rows(st, seglist)})
        sheets.spreadsheets().values().batchUpdate(
            spreadsheetId=sid, body={"valueInputOption": "USER_ENTERED", "data": data}).execute()
        return {"target": "Google試算表", "ok": True, "url": f.get("webViewLink")}
    except Exception as e:
        import traceback; traceback.print_exc()  # 進 Railway log
        return {"target": "Google試算表", "ok": False, "reason": str(e)[:500]}


def write_quote_to_zoho(quote):
    if not os.environ.get("ZOHO_REFRESH_TOKEN"):
        return {"target": "Zoho案子", "ok": False, "reason": "尚未設定 Zoho 授權"}
    # TODO: 換 access token → 更新對應 Deal
    return {"target": "Zoho案子", "ok": False, "reason": "API 尚未接上"}


def write_proposal_to_drive(proposal):
    if not google_configured():
        return {"target": "Drive提案文件", "ok": False, "reason": "尚未設定 Google 服務帳號"}
    return {"target": "Drive提案文件", "ok": False, "reason": "API 尚未接上"}


def append_index_row(proposal, doc_url=None):
    if not os.environ.get("INDEX_SHEET_ID"):
        return {"target": "檢索表登錄", "ok": False, "reason": "尚未設定檢索表 ID"}
    return {"target": "檢索表登錄", "ok": False, "reason": "API 尚未接上"}


# ---- 行程成本範本：存成 Google Drive 上的一份 JSON（全業務共用、重新部署不會不見）----
TEMPLATE_FILENAME = "walkin_tour_templates.json"
TEMPLATE_LOCAL = os.path.join(SUB_DIR, "_templates_cache.json")


def _template_folder():
    return os.environ.get("GDRIVE_TEMPLATE_FOLDER") or os.environ.get("GDRIVE_QUOTE_FOLDER")


def _find_template_file(drive, folder):
    """先用明確 file id，否則在資料夾裡用檔名找；找不到回 None。"""
    fid = os.environ.get("GDRIVE_TEMPLATE_FILE_ID")
    if fid:
        return fid
    q = f"name = '{TEMPLATE_FILENAME}' and trashed = false"
    if folder:
        q += f" and '{folder}' in parents"
    res = drive.files().list(
        q=q, spaces="drive", fields="files(id)", pageSize=1,
        supportsAllDrives=True, includeItemsFromAllDrives=True,
    ).execute()
    files = res.get("files", [])
    return files[0]["id"] if files else None


def read_templates():
    """回 {ok, templates, source}. 雲端讀不到時退回本機快取。"""
    if google_configured():
        try:
            _, drive = _google_services()
            fid = _find_template_file(drive, _template_folder())
            if fid:
                raw = drive.files().get_media(fileId=fid, supportsAllDrives=True).execute()
                tpls = json.loads(raw.decode("utf-8")) if raw else {}
                return {"ok": True, "templates": tpls, "source": "google"}
            return {"ok": True, "templates": {}, "source": "google-empty"}
        except Exception as e:
            import traceback; traceback.print_exc()
            # 雲端失敗 → 退回本機快取，至少不要整個壞掉
    if os.path.isfile(TEMPLATE_LOCAL):
        try:
            with open(TEMPLATE_LOCAL, encoding="utf-8") as f:
                return {"ok": True, "templates": json.load(f), "source": "local"}
        except Exception:
            pass
    return {"ok": True, "templates": {}, "source": "empty"}


def write_templates(tpls):
    """寫回 Drive 那份 JSON；同時寫一份本機快取當保險。"""
    # 本機快取（即使雲端沒設定，也能跨分頁/重整保住）
    try:
        os.makedirs(SUB_DIR, exist_ok=True)
        with _lock, open(TEMPLATE_LOCAL, "w", encoding="utf-8") as f:
            json.dump(tpls, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    if not google_configured():
        return {"target": "Google雲端範本", "ok": False, "reason": "尚未設定 Google 服務帳號（已存本機快取）"}
    folder = _template_folder()
    if not folder and not os.environ.get("GDRIVE_TEMPLATE_FILE_ID"):
        return {"target": "Google雲端範本", "ok": False, "reason": "尚未設定範本資料夾（GDRIVE_TEMPLATE_FOLDER 或沿用 GDRIVE_QUOTE_FOLDER）"}
    try:
        from googleapiclient.http import MediaInMemoryUpload
        _, drive = _google_services()
        body_bytes = json.dumps(tpls, ensure_ascii=False, indent=2).encode("utf-8")
        media = MediaInMemoryUpload(body_bytes, mimetype="application/json", resumable=False)
        fid = _find_template_file(drive, folder)
        if fid:
            drive.files().update(fileId=fid, media_body=media, supportsAllDrives=True).execute()
        else:
            meta = {"name": TEMPLATE_FILENAME, "mimeType": "application/json"}
            if folder:
                meta["parents"] = [folder]
            f = drive.files().create(body=meta, media_body=media, fields="id", supportsAllDrives=True).execute()
            fid = f["id"]
        return {"target": "Google雲端範本", "ok": True, "id": fid}
    except Exception as e:
        import traceback; traceback.print_exc()
        return {"target": "Google雲端範本", "ok": False, "reason": str(e)[:500]}


# ============ 個人帳號與登入 ============
USERS_FILENAME = "walkin_users.json"
USERS_LOCAL = os.path.join(SUB_DIR, "_users_cache.json")
_users_lock = threading.RLock()


def _users_find_file(drive, folder):
    fid = os.environ.get("GDRIVE_USERS_FILE_ID")
    if fid:
        return fid
    q = f"name = '{USERS_FILENAME}' and trashed = false"
    if folder:
        q += f" and '{folder}' in parents"
    res = drive.files().list(q=q, spaces="drive", fields="files(id)", pageSize=1,
                             supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
    files = res.get("files", [])
    return files[0]["id"] if files else None


def read_users():
    if google_configured():
        try:
            _, drive = _google_services()
            fid = _users_find_file(drive, _template_folder())
            if fid:
                raw = drive.files().get_media(fileId=fid, supportsAllDrives=True).execute()
                return json.loads(raw.decode("utf-8")) if raw else {"users": []}
            return {"users": []}
        except Exception:
            import traceback; traceback.print_exc()
    if os.path.isfile(USERS_LOCAL):
        try:
            with open(USERS_LOCAL, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"users": []}


def write_users(store):
    try:
        os.makedirs(SUB_DIR, exist_ok=True)
        with _lock, open(USERS_LOCAL, "w", encoding="utf-8") as f:
            json.dump(store, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    if not google_configured():
        return False
    folder = _template_folder()
    if not folder and not os.environ.get("GDRIVE_USERS_FILE_ID"):
        return False
    try:
        from googleapiclient.http import MediaInMemoryUpload
        _, drive = _google_services()
        body = json.dumps(store, ensure_ascii=False, indent=2).encode("utf-8")
        media = MediaInMemoryUpload(body, mimetype="application/json", resumable=False)
        fid = _users_find_file(drive, folder)
        if fid:
            drive.files().update(fileId=fid, media_body=media, supportsAllDrives=True).execute()
        else:
            meta = {"name": USERS_FILENAME, "mimeType": "application/json"}
            if folder:
                meta["parents"] = [folder]
            drive.files().create(body=meta, media_body=media, fields="id", supportsAllDrives=True).execute()
        return True
    except Exception:
        import traceback; traceback.print_exc()
        return False


def hash_pw(pw, salt=None, iters=120000):
    """PBKDF2-HMAC-SHA256（標準庫）；只存 salt+hash，不存明碼。"""
    salt = salt or os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac("sha256", (pw or "").encode("utf-8"), bytes.fromhex(salt), iters)
    return {"salt": salt, "iters": iters, "hash": dk.hex()}


def verify_pw(pw, rec):
    try:
        dk = hashlib.pbkdf2_hmac("sha256", (pw or "").encode("utf-8"),
                                 bytes.fromhex(rec["salt"]), int(rec.get("iters", 120000)))
        return hmac.compare_digest(dk.hex(), rec.get("hash", ""))
    except Exception:
        return False


def find_user(username):
    uname = (username or "").strip().lower()
    for u in read_users().get("users", []):
        if u.get("u", "").lower() == uname:
            return u
    return None


def _b64u(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64u_dec(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_token(u, name, role):
    payload = {"u": u, "name": name, "role": role, "exp": int(time.time()) + SESSION_TTL}
    pb = _b64u(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sig = _b64u(hmac.new(SESSION_SECRET.encode(), pb.encode(), hashlib.sha256).digest())
    return pb + "." + sig


def verify_token(token):
    try:
        pb, sig = (token or "").split(".", 1)
        exp_sig = _b64u(hmac.new(SESSION_SECRET.encode(), pb.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, exp_sig):
            return None
        payload = json.loads(_b64u_dec(pb).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


def email_domain_ok(email):
    email = (email or "").lower()
    return bool(email) and email.endswith("@" + ALLOWED_DOMAIN)


def verify_google_credential(credential):
    """驗證 Google「Sign in with Google」回傳的 ID token；只放行 ALLOWED_DOMAIN。
    成功回 {u(email), name, role}，失敗 raise。"""
    from google.oauth2 import id_token as gid
    from google.auth.transport import requests as greq
    info = gid.verify_oauth2_token(credential, greq.Request(), GOOGLE_OAUTH_CLIENT_ID)
    if not info.get("email_verified"):
        raise ValueError("Google 信箱未驗證")
    email = (info.get("email") or "").lower()
    hd = (info.get("hd") or "").lower()
    if not email_domain_ok(email) or (hd and hd != ALLOWED_DOMAIN):
        raise ValueError("僅限 @" + ALLOWED_DOMAIN + " 公司信箱登入")
    role = "admin" if email in ADMIN_EMAILS else "user"
    return {"u": email, "name": info.get("name") or email.split("@")[0], "role": role}


def authenticate(username, password):
    """密碼登入（需 ALLOW_PASSWORD_LOGIN）。回身分 dict 或 None。"""
    username = (username or "").strip()
    if ADMIN_USER and ADMIN_PASS and username.lower() == ADMIN_USER.lower() \
            and hmac.compare_digest(password or "", ADMIN_PASS):
        return {"u": ADMIN_USER, "name": ADMIN_NAME, "role": "admin"}
    rec = find_user(username)
    if rec and verify_pw(password or "", rec):
        return {"u": rec["u"], "name": rec.get("name", rec["u"]), "role": rec.get("role", "user")}
    return None


def create_user(username, name, password, role="user"):
    """管理員建立帳號。回 {ok, reason?}。"""
    username = (username or "").strip()
    if not username or not password:
        return {"ok": False, "reason": "帳號與密碼必填"}
    if username.lower() == (ADMIN_USER or "").lower():
        return {"ok": False, "reason": "此帳號名稱保留給內建管理員"}
    with _users_lock:
        store = read_users()
        users = store.setdefault("users", [])
        if any(x.get("u", "").lower() == username.lower() for x in users):
            return {"ok": False, "reason": "帳號已存在"}
        rec = {"u": username, "name": (name or username).strip(), "role": role}
        rec.update(hash_pw(password))
        users.append(rec)
        write_users(store)
    return {"ok": True}


def _public_user(u):
    return {"u": u.get("u"), "name": u.get("name", u.get("u")), "role": u.get("role", "user")}


_tpl_lock = threading.RLock()


def _tpl_same(a, b):
    """只比對 name + items（忽略 rev / conflictOf 等中繼資料）。"""
    return (a.get("name", "") == b.get("name", "")
            and json.dumps(a.get("items", []), ensure_ascii=False, sort_keys=True)
                == json.dumps(b.get("items", []), ensure_ascii=False, sort_keys=True))


HISTORY_MAX = 40


def _items_map(items):
    m = {}
    for it in items or []:
        m[it.get("id") or it.get("name")] = it
    return m


def _diff_summary(old, new):
    """自動算「改了什麼」：新增/移除/單價或數量規則變更。回簡短中文字串。"""
    parts = []
    if (old.get("name", "") != new.get("name", "")):
        parts.append(f"名稱：{old.get('name','')}→{new.get('name','')}")
    om, nm = _items_map(old.get("items", [])), _items_map(new.get("items", []))
    for k, it in nm.items():
        if k not in om:
            parts.append(f"新增「{it.get('name','')}」")
    for k, it in om.items():
        if k not in nm:
            parts.append(f"移除「{it.get('name','')}」")
    for k, nit in nm.items():
        oit = om.get(k)
        if not oit:
            continue
        nm_ = nit.get("name", "")
        if (oit.get("unitPrice") or 0) != (nit.get("unitPrice") or 0):
            parts.append(f"「{nm_}」單價 {oit.get('unitPrice',0)}→{nit.get('unitPrice',0)}")
        if oit.get("mode") != nit.get("mode") or (oit.get("n") or 1) != (nit.get("n") or 1):
            parts.append(f"「{nm_}」數量規則調整")
    return "；".join(parts[:8]) or "內容微調"


def apply_template_ops(ops, editor=None):
    """逐條套用 upsert/delete，以 rev 做樂觀鎖；偵測到同時編輯就把後到的另存成新範本（不覆蓋）。
    每次更新會把舊版收進 history，並記錄 日期/修改者/改了什麼。
    回傳 {ok, templates(權威全集), conflicts, results}。"""
    who = (editor or {}).get("name") or "未知"
    now = int(time.time())
    with _tpl_lock:
        cur = (read_templates() or {}).get("templates") or {}
        conflicts = []
        for op in ops or []:
            typ = op.get("op"); oid = op.get("id")
            if not oid:
                continue
            base = int(op.get("baseRev") or 0)
            note = (op.get("note") or "").strip()
            existing = cur.get(oid)
            if typ == "upsert":
                inc = {"name": op.get("name", ""), "items": op.get("items", [])}
                if not existing:
                    cur[oid] = dict(inc, rev=1, history=[], updatedAt=now, updatedBy=who,
                                    changeSummary="建立範本", changeNote=note,
                                    conflictOf=op.get("conflictOf") or None)
                    if not cur[oid].get("conflictOf"):
                        cur[oid].pop("conflictOf", None)
                elif _tpl_same(existing, inc):
                    pass  # 內容沒變，不動
                elif int(existing.get("rev", 0)) == base:
                    # 正常更新：把目前版本收進歷史，再寫入新版（新版自動成正式）
                    hist = list(existing.get("history", []))
                    hist.insert(0, {"rev": existing.get("rev", 0), "name": existing.get("name", ""),
                                    "items": existing.get("items", []), "at": existing.get("updatedAt"),
                                    "by": existing.get("updatedBy"), "summary": existing.get("changeSummary"),
                                    "note": existing.get("changeNote")})
                    summary = _diff_summary(existing, inc)
                    cur[oid] = dict(inc, rev=int(existing.get("rev", 0)) + 1, history=hist[:HISTORY_MAX],
                                    updatedAt=now, updatedBy=who, changeSummary=summary, changeNote=note)
                    if existing.get("conflictOf"):
                        cur[oid]["conflictOf"] = existing["conflictOf"]
                else:
                    # 衝突：保留雲端現有版，把這份另存成新範本
                    vid = oid + "__c" + os.urandom(3).hex()
                    base_name = existing.get("name") or inc.get("name") or oid
                    vname = (inc.get("name") or base_name) + "（衝突副本·待合併）"
                    cur[vid] = dict(inc, name=vname, rev=1, conflictOf=oid, history=[],
                                    updatedAt=now, updatedBy=who, changeSummary="同時編輯衝突，另存", changeNote=note)
                    conflicts.append({"id": oid, "baseName": base_name, "variantId": vid, "variantName": vname})
            elif typ == "delete":
                # 軟刪除：標記 archived 並留痕（誰、何時），可還原
                if not existing:
                    pass
                elif int(existing.get("rev", 0)) == base:
                    hist = list(existing.get("history", []))
                    hist.insert(0, {"rev": existing.get("rev", 0), "name": existing.get("name", ""),
                                    "items": existing.get("items", []), "at": existing.get("updatedAt"),
                                    "by": existing.get("updatedBy"), "summary": existing.get("changeSummary"),
                                    "note": existing.get("changeNote")})
                    existing["archived"] = True
                    existing["history"] = hist[:HISTORY_MAX]
                    existing["rev"] = int(existing.get("rev", 0)) + 1
                    existing["updatedAt"] = now; existing["updatedBy"] = who
                    existing["changeSummary"] = "刪除範本"; existing["changeNote"] = note
                else:
                    conflicts.append({"id": oid, "baseName": existing.get("name") or oid, "kept": True})
            elif typ == "restore":
                if existing and existing.get("archived"):
                    existing["archived"] = False
                    existing["rev"] = int(existing.get("rev", 0)) + 1
                    existing["updatedAt"] = now; existing["updatedBy"] = who
                    existing["changeSummary"] = "還原範本"; existing["changeNote"] = note
        res = write_templates(cur)
        return {"ok": bool(res.get("ok")), "templates": cur, "conflicts": conflicts, "results": [res]}


LOGIN_PAGE = """<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登入｜島內散步 產品與報價工具</title>
<style>
 body{margin:0;font-family:-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;background:#f6f7f9;color:#1f2937;display:flex;min-height:100vh;align-items:center;justify-content:center}
 .card{background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.12);padding:36px 32px;width:380px;max-width:92vw;text-align:center}
 h1{font-size:19px;margin:0 0 6px}
 .sub{font-size:13px;color:#6b7280;margin-bottom:24px;line-height:1.7}
 #gbtn{display:flex;justify-content:center;min-height:44px}
 #err{color:#dc2626;font-size:12.5px;min-height:18px;margin-top:14px}
 .brand{font-weight:700;color:#b45309}
</style></head>
<body><div class="card">
 <h1>島內散步｜產品與報價工具</h1>
 <div class="sub">請用你的 <span class="brand" id="dom">@walkin.tw</span> 公司 Google 帳號登入。<br>此工具僅限公司同仁使用。</div>
 <div id="gbtn"></div>
 <div id="pwbox" style="display:none;text-align:left;margin-top:6px">
   <input id="pw_u" placeholder="帳號" autocomplete="username" style="width:100%;box-sizing:border-box;padding:9px;margin:6px 0;border:1px solid #d1d5db;border-radius:8px">
   <input id="pw_p" type="password" placeholder="密碼" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:9px;margin:6px 0;border:1px solid #d1d5db;border-radius:8px">
   <button id="pw_btn" style="width:100%;padding:10px;border:0;border-radius:8px;background:#b45309;color:#fff;font-size:14px;cursor:pointer">登入</button>
 </div>
 <div id="err"></div>
</div>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script>
(async function(){
 var cfg={};
 try{ cfg=((await (await fetch("/api/health")).json())||{}).configured||{}; }catch(e){}
 if(cfg.domain) document.getElementById("dom").textContent="@"+cfg.domain;
 var err=document.getElementById("err");
 if(cfg.googleClientId){
  function ready(cb){ if(window.google&&google.accounts&&google.accounts.id) cb(); else setTimeout(function(){ready(cb);},150); }
  ready(function(){
   google.accounts.id.initialize({ client_id:cfg.googleClientId, hd:cfg.domain||undefined, callback:async function(resp){
    err.textContent="登入中…";
    try{
     var r=await fetch("/api/login-google",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({credential:resp.credential})});
     var d=await r.json();
     if(r.ok&&d.ok){ location.replace("/"); } else { err.textContent=(d&&d.reason)||("登入失敗 "+r.status); }
    }catch(e){ err.textContent="登入失敗，請重試"; }
   }});
   google.accounts.id.renderButton(document.getElementById("gbtn"),{theme:"outline",size:"large",width:300,text:"signin_with"});
  });
 } else if(cfg.passwordLogin){
  document.getElementById("pwbox").style.display="block";
  document.getElementById("pw_btn").onclick=async function(){
   err.textContent="登入中…";
   try{
    var r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:document.getElementById("pw_u").value.trim(),password:document.getElementById("pw_p").value})});
    var d=await r.json();
    if(r.ok&&d.ok){ location.replace("/"); } else { err.textContent=(d&&d.reason)||("登入失敗 "+r.status); }
   }catch(e){ err.textContent="登入失敗，請重試"; }
  };
 } else {
  err.textContent="後端尚未設定登入方式（GOOGLE_OAUTH_CLIENT_ID）";
 }
})();
</script></body></html>"""


def _health_obj():
    return {"ok": True, "configured": {
        "google": google_configured(),
        "zoho": bool(os.environ.get("ZOHO_REFRESH_TOKEN")),
        "indexSheet": bool(os.environ.get("INDEX_SHEET_ID")),
        "templates": bool(_template_folder() or os.environ.get("GDRIVE_TEMPLATE_FILE_ID")),
        "login": True,
        "googleClientId": GOOGLE_OAUTH_CLIENT_ID or "",
        "passwordLogin": ALLOW_PASSWORD_LOGIN,
        "domain": ALLOWED_DOMAIN,
    }}


class Handler(BaseHTTPRequestHandler):
    server_version = "WalkinProductTool/0.3"

    def _json(self, obj, status=200, set_cookie=None, clear_cookie=False):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if set_cookie is not None:
            self.send_header("Set-Cookie", self._session_cookie(set_cookie))
        if clear_cookie:
            self.send_header("Set-Cookie", "walkin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
        self._cors(); self.end_headers(); self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    # ---- 登入通行證（cookie）：整站都要驗 ----
    def _is_https(self):
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            return True
        host = self.headers.get("Host", "")
        return "railway.app" in host or host.endswith(":443")

    def _session_cookie(self, token):
        sec = "; Secure" if self._is_https() else ""
        return "walkin_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + str(SESSION_TTL) + sec

    def _cookies(self):
        out = {}
        for part in self.headers.get("Cookie", "").split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _session_user(self):
        tok = self._cookies().get("walkin_session")
        u = verify_token(tok) if tok else None
        if u:
            return u
        h = self.headers.get("Authorization", "")   # 後援：給 curl/非瀏覽器測試
        if h.startswith("Bearer "):
            return verify_token(h[7:].strip())
        return None

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def _serve_login_page(self):
        body = LOGIN_PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(body)

    def _static(self, path):
        entry = STATIC_FILES.get(path)
        if not entry:
            return self._json({"error": "not found"}, 404)
        fn, ct = entry
        full = os.path.join(BASE_DIR, fn)
        if not os.path.isfile(full):
            return self._json({"error": "file missing"}, 404)
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers(); self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(_health_obj())
        user = self._session_user()
        if not user:
            # 未登入：首頁給登入頁；其餘一律擋（保護 app.js / products.js / proposals.js 等）
            if path in ("/", "/index.html"):
                return self._serve_login_page()
            if path == "/api/me":
                return self._json({"ok": False, "user": None})
            return self._json({"ok": False, "needLogin": True, "error": "login required"}, 401)
        # 已登入
        if path == "/api/me":
            return self._json({"ok": True, "user": _public_user(user)})
        if path == "/api/templates":
            return self._json(read_templates())
        if path == "/api/users":
            if user.get("role") != "admin":
                return self._json({"ok": False, "reason": "需要管理員"}, 403)
            return self._json({"ok": True, "users": [_public_user(x) for x in read_users().get("users", [])]})
        return self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/login-google":
                if not GOOGLE_OAUTH_CLIENT_ID:
                    return self._json({"ok": False, "reason": "後端尚未設定 Google 登入"}, 400)
                b = self._body()
                try:
                    u = verify_google_credential(b.get("credential"))
                except Exception as e:
                    return self._json({"ok": False, "reason": str(e)[:140] or "Google 登入驗證失敗"}, 401)
                return self._json({"ok": True, "user": _public_user(u)},
                                  set_cookie=issue_token(u["u"], u["name"], u["role"]))
            if path == "/api/login":   # 密碼登入（預設停用；本機/救生艇）
                if not ALLOW_PASSWORD_LOGIN:
                    return self._json({"ok": False, "reason": "已停用密碼登入，請改用公司 Google 帳號登入"}, 403)
                b = self._body()
                u = authenticate(b.get("username"), b.get("password"))
                if not u:
                    return self._json({"ok": False, "reason": "帳號或密碼錯誤"}, 401)
                return self._json({"ok": True, "user": _public_user(u)},
                                  set_cookie=issue_token(u["u"], u["name"], u["role"]))
            if path == "/api/logout":
                return self._json({"ok": True}, clear_cookie=True)
            # 以下都需登入（通行證 cookie）
            user = self._session_user()
            if not user:
                return self._json({"ok": False, "needLogin": True, "reason": "請先登入"}, 401)
            if path == "/api/users":
                if user.get("role") != "admin":
                    return self._json({"ok": False, "reason": "需要管理員權限"}, 403)
                b = self._body()
                return self._json(create_user(b.get("username"), b.get("name"),
                                              b.get("password"), b.get("role", "user")))
            if path == "/api/save-quote":
                q = self._body()
                fn = save_submission("quote", q)
                return self._json({"saved": fn, "results": [write_quote_to_gsheet(q), write_quote_to_zoho(q)]})
            if path == "/api/save-proposal":
                p = self._body()
                fn = save_submission("proposal", p)
                drive = write_proposal_to_drive(p)
                return self._json({"saved": fn, "results": [drive, append_index_row(p, drive.get("url"))]})
            if path == "/api/templates":
                body = self._body()
                if isinstance(body, dict) and isinstance(body.get("ops"), list):
                    return self._json(apply_template_ops(body["ops"], user))
                tpls = body.get("templates", body) if isinstance(body, dict) else {}
                return self._json({"results": [write_templates(tpls)]})
        except Exception as e:
            return self._json({"error": str(e)}, 400)
        return self._json({"error": "unknown endpoint"}, 404)

    def log_message(self, fmt, *args):
        pass


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"產品與報價工具 後端已啟動： http://localhost:{PORT}")
    print(f"  提交暫存： {SUB_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
