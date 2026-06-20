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
import base64, hmac, json, os, re, threading, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "4181"))
SUB_DIR = os.path.join(BASE_DIR, "submissions")

AUTH_USER = os.environ.get("AUTH_USER")
AUTH_PASS = os.environ.get("AUTH_PASS")
AUTH_ENABLED = bool(AUTH_USER and AUTH_PASS)

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


class Handler(BaseHTTPRequestHandler):
    server_version = "WalkinProductTool/0.2"

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors(); self.end_headers(); self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _auth_ok(self):
        if not AUTH_ENABLED:
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                u, _, p = base64.b64decode(h[6:]).decode("utf-8").partition(":")
                return hmac.compare_digest(u, AUTH_USER) and hmac.compare_digest(p, AUTH_PASS)
            except Exception:
                return False
        return False

    def _need_auth(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Walkin Product Tool"')
        self._cors(); self.send_header("Content-Length", "0"); self.end_headers()

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

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
        if not self._auth_ok():
            return self._need_auth()
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json({"ok": True, "configured": {
                "google": google_configured(),
                "zoho": bool(os.environ.get("ZOHO_REFRESH_TOKEN")),
                "indexSheet": bool(os.environ.get("INDEX_SHEET_ID")),
            }})
        return self._static(path)

    def do_POST(self):
        if not self._auth_ok():
            return self._need_auth()
        path = urlparse(self.path).path
        try:
            if path == "/api/save-quote":
                q = self._body()
                fn = save_submission("quote", q)
                results = [write_quote_to_gsheet(q), write_quote_to_zoho(q)]
                return self._json({"saved": fn, "results": results})
            if path == "/api/save-proposal":
                p = self._body()
                fn = save_submission("proposal", p)
                drive = write_proposal_to_drive(p)
                idx = append_index_row(p, drive.get("url"))
                return self._json({"saved": fn, "results": [drive, idx]})
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
