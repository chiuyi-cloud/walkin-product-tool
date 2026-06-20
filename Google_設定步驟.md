# Google 服務帳號設定步驟（報價存試算表用）

做完這份，工具就能把業務的報價自動存成 Google 試算表，放到指定資料夾。
全部約 15 分鐘。完成後把 **① JSON 金鑰檔** 和 **② 資料夾 ID** 給我即可。

---

## 步驟 1：建立 Google Cloud 專案
1. 用公司 Google 帳號登入 https://console.cloud.google.com/
2. 左上角專案選單 →「新增專案」→ 命名如 `walkin-tools` → 建立。

## 步驟 2：啟用兩個 API
在該專案下，到「API 和服務 → 程式庫」，分別搜尋並**啟用**：
- **Google Drive API**
- **Google Sheets API**

## 步驟 3：建立服務帳號 + 下載金鑰
1. 「API 和服務 → 憑證 → 建立憑證 → 服務帳號」。
2. 名稱如 `walkin-writer` → 建立並繼續 → 角色可略過 → 完成。
3. 點進剛建立的服務帳號 →「金鑰」分頁 →「新增金鑰 → 建立新的金鑰 → JSON」→ 會下載一個 **`.json` 檔**。
   - ⚠️ 這個檔是機密，等同密碼，**不要外流、不要上傳到公開的 GitHub**。
4. 記下服務帳號的 email（長得像 `walkin-writer@walkin-tools.iam.gserviceaccount.com`）。

## 步驟 4：建立報價資料夾並共用給服務帳號
1. 在 Google Drive 建一個資料夾，例如 **「業務報價試算」**。
   - 💡 **強烈建議**把這個資料夾放在「**共用雲端硬碟 (Shared Drive)**」底下，或直接在共用雲端硬碟建立。這樣最穩，不會碰到服務帳號的容量限制。
2. 對該資料夾按「共用」→ 把**步驟 3 的服務帳號 email** 加入，權限給「**編輯者**」。

## 步驟 5：取得資料夾 ID
打開該資料夾，看瀏覽器網址：
```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                        └──────── 這串就是資料夾 ID ────────┘
```

---

## 完成後給我這兩樣
1. **JSON 金鑰檔**：請把它放進專案資料夾並命名為 `service-account.json`
   （路徑：`/Users/chiuyi/CODE/產品及報價工具/service-account.json`）。
   我已設定好不會把它上傳到 GitHub。
2. **資料夾 ID**（步驟 5 那串）。

我會用這兩樣做本機實測：在工具按「存報價」→ 確認 Drive 指定資料夾真的出現一份報價試算表，連結也會回到工具裡。確認 OK 再進到「部署上線」。

> 之後 Zoho 回寫、提案登錄檢索表，會用類似方式再設定一次。
