#!/usr/bin/env python3
"""把 Zoho 撈下來的 6 個原始結果檔合併、去重、清理，產出 products.js 快照。"""
import json, re, os, glob

TOOL_RESULTS = "/Users/chiuyi/.claude/projects/-Users-chiuyi-COWORK-SPACE-projects---3/3cc076bc-3a1c-493c-98eb-95953897ebb4/tool-results"
FILES = [
    "mcp-d90b16bb-9766-4d7b-a9aa-9bd351547080-ZohoCRM_getRecords-1781920446128.txt",
    "mcp-d90b16bb-9766-4d7b-a9aa-9bd351547080-ZohoCRM_getRecords-1781920490013.txt",
    "mcp-d90b16bb-9766-4d7b-a9aa-9bd351547080-ZohoCRM_getRecords-1781920522938.txt",
    "mcp-d90b16bb-9766-4d7b-a9aa-9bd351547080-ZohoCRM_getRecords-1781920540694.txt",
    "mcp-d90b16bb-9766-4d7b-a9aa-9bd351547080-ZohoCRM_getRecords-1781920556894.txt",
    "mcp-d90b16bb-9766-4d7b-a9aa-9bd351547080-ZohoCRM_getRecords-1781920679033.txt",
]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "products.js")

def is_junk(name):
    if not name or not name.strip():
        return True
    n = name.strip()
    # 純符號／分隔列
    if not re.search(r"[一-鿿A-Za-z0-9]", n):
        return True
    junk_exact = {"備註", "記得看備註！！", "＊＊行程備註＊＊"}
    if n in junk_exact:
        return True
    if "----" in n or "────" in n or "一一" in n:
        return True
    return False

by_id = {}
for fn in FILES:
    path = os.path.join(TOOL_RESULTS, fn)
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    for r in raw["data"]["data"]:
        oid = r.get("id")
        if not oid:
            continue
        by_id[oid] = r  # 去重：同 id 後者覆蓋

cleaned = []
dropped = 0
for r in by_id.values():
    name = (r.get("Product_Name") or "").strip()
    if is_junk(name):
        dropped += 1
        continue
    cat = r.get("Product_Category") or "未分類"
    ptype = "產品" if cat.startswith("產品") else ("元件" if cat.startswith("元件") else "其他")
    subcat = cat.split("-", 1)[1] if "-" in cat else cat
    cleaned.append({
        "id": r.get("id"),
        "name": name,
        "category": cat,
        "type": ptype,
        "subcat": subcat,
        "area": r.get("Area") or [],
        "capacity": r.get("CapacityRange"),
        "priceRange": r.get("PriceRange"),
        "unitPrice": r.get("Unit_Price"),
        "unit": r.get("Usage_Unit"),
        "topics": r.get("TopicType") or [],
        "esg": r.get("ESG") or [],
        "noServe": r.get("NoServeDuring"),
        "url": r.get("field3"),
        "note": r.get("field14"),
        "active": bool(r.get("Product_Active")),
    })

def _key(p):
    return (0 if p["type"] == "產品" else 1, p["category"], p["name"])
cleaned.sort(key=_key)

with open(OUT, "w", encoding="utf-8") as f:
    f.write("// 島內散步產品快照（取自 Zoho CRM Products，point-in-time 匯出）\n")
    f.write("// 由 build_snapshot.py 產生，請勿手動編輯；之後接即時連線會自動更新。\n")
    f.write("window.PRODUCTS = ")
    json.dump(cleaned, f, ensure_ascii=False, indent=0)
    f.write(";\n")

# 統計
from collections import Counter
ctype = Counter(p["type"] for p in cleaned)
ccat = Counter(p["category"] for p in cleaned)
active = sum(1 for p in cleaned if p["active"])
print(f"原始去重後：{len(by_id)} 筆；清掉雜訊：{dropped} 筆；保留：{len(cleaned)} 筆（active {active}）")
print("型別：", dict(ctype))
print("分類前12：")
for c, n in ccat.most_common(12):
    print(f"  {n:4}  {c}")
print("輸出：", OUT)
