#!/usr/bin/env python3
"""
StockScout — Discord 通知
-------------------------------------------------------------------------------
日次バッチの最後に実行し、「強い推薦」だけを Discord へ送る。

通知の設計方針:
  ・全推薦を送らない。合流3カテゴリ以上を満たしたものだけ送る。
    通知が毎日大量に来れば、人はそれを見なくなる。通知の価値は希少性に宿る。
  ・0件の日は何も送らない。「本日は該当なし」という通知は、
    毎日「異常なし」を報告する警報器と同じで、無視される訓練にしかならない。
  ・前回と同じ銘柄は再送しない(state.json で抑制)。同じことを毎日言わない。

環境変数:
  DISCORD_WEBHOOK_URL  Discord のチャンネル Webhook URL(Actions の Secrets へ)
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import date
from pathlib import Path

WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
SNAP = Path("public/data/snapshot.json")
STATE = Path(".state/notified.json")

# Discord(Cloudflare)は、Python urllib のデフォルト User-Agent
# ("Python-urllib/3.x")を弾いて 403 Forbidden を返すことがある。
# ブラウザ的な User-Agent を明示することで回避する。
COMMON_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; StockScoutBot/1.0; +https://github.com/)",
}

CAT_COLOR = {
    "flagship": 0x111820, "momentum": 0xB4531F, "value": 0x1B3A5C,
    "quality": 0x2E6E62, "growth": 0x6B3FA0, "lowvol": 0x4A5A6A,
    "technical": 0x8A6D1F, "event": 0xA63A28, "composite": 0x0F5257,
}
SIGNAL_LABEL = {"add": "🟢 買い増し検討", "sell_stop": "🔴 損切り水準到達", "sell_thesis": "🔴 仮説崩壊"}


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"last": {}}


def save_state(st):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=1))


def build_embeds(strong, asof):
    embeds = []
    for item in strong[:10]:  # Discord の embed 上限に配慮
        s = item["stock"]
        names = "、".join(st["name"] for st in item["strategies"])
        cat = item["strategies"][0]["cat"]
        cur = "¥{:,.0f}".format(s["price"]) if s["market"] == "JP" else "${:,.2f}".format(s["price"])
        embeds.append({
            "title": f"{s['code']}　{s['name']}",
            "description": f"**{item['confluence']} カテゴリが同時に推薦**\n{names}",
            "color": CAT_COLOR.get(cat, 0x1B3A5C),
            "fields": [
                {"name": "株価", "value": cur, "inline": True},
                {"name": "市場", "value": "日本株" if s["market"] == "JP" else "米国株", "inline": True},
                {"name": "業種", "value": s.get("sector", "—"), "inline": True},
                {"name": "PER", "value": f"{s['per']:.1f}倍", "inline": True},
                {"name": "PBR", "value": f"{s['pbr']:.2f}倍", "inline": True},
                {"name": "ROE", "value": f"{s['roe']*100:.1f}%", "inline": True},
            ],
            "footer": {"text": f"前日終値 {asof} ・ 機械的な条件抽出であり投資助言ではありません"},
        })
    return embeds


def build_portfolio_embeds(alerts):
    """保有銘柄の買い増し/売りシグナル。前回と違う状態になったものだけを渡される前提。"""
    embeds = []
    for a in alerts[:10]:
        cur = "¥{:,.0f}".format(a["price"]) if a["market"] == "JP" else "${:,.2f}".format(a["price"])
        cost = "¥{:,.0f}".format(a["costBasis"]) if a["market"] == "JP" else "${:,.2f}".format(a["costBasis"])
        color = 0x2E6E62 if a["signal"] == "add" else 0xA63A28
        embeds.append({
            "title": f"{SIGNAL_LABEL.get(a['signal'], a['signal'])}　{a['code']} {a['name']}",
            "description": a.get("reason", ""),
            "color": color,
            "fields": [
                {"name": "取得単価", "value": cost, "inline": True},
                {"name": "現在値", "value": cur, "inline": True},
                {"name": "損益率", "value": f"{a['unrealizedPct']*100:+.1f}%", "inline": True},
            ],
        })
    return embeds


def notify_portfolio(snap, state):
    """保有銘柄のシグナルは「前回と状態が変わった銘柄」だけを通知する。
       毎日同じ『買い増し検討』を送り続けても、その通知は数日で読まれなくなる。"""
    alerts = snap.get("portfolio_signals", [])
    if not alerts:
        return
    prev = state.get("pf_status", {})
    changed = [a for a in alerts if prev.get(a["code"]) != a["signal"]]
    if not changed:
        print("保有銘柄: 状態変化なし。通知しません。")
        return

    payload = {
        "username": "StockScout",
        "content": f"**保有銘柄で状態変化 {len(changed)} 件**",
        "embeds": build_portfolio_embeds(changed),
    }
    req = urllib.request.Request(
        WEBHOOK, data=json.dumps(payload).encode("utf-8"),
        headers=COMMON_HEADERS,
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print(f"保有銘柄シグナルを通知しました: {len(changed)} 件 (HTTP {r.status})")
    except Exception as e:
        print(f"保有銘柄シグナルの通知に失敗しました: {e}", file=sys.stderr)

    state["pf_status"] = {**prev, **{a["code"]: a["signal"] for a in alerts}}


def main():
    if not WEBHOOK:
        print("DISCORD_WEBHOOK_URL 未設定のため通知をスキップします")
        return 0
    if not SNAP.exists():
        print(f"{SNAP} が見つかりません")
        return 1

    snap = json.loads(SNAP.read_text())
    strong = snap.get("strong", [])
    asof = snap.get("asof", str(date.today()))
    state = load_state()

    notify_portfolio(snap, state)

    # 0件なら黙る
    if not strong:
        print("強い推薦なし。通知しません。")
        save_state(state)
        return 0

    # 前回と同じ銘柄は再送しない
    prev = set(state["last"].get(asof[:7], []))
    fresh = [x for x in strong if x["stock"]["code"] not in prev]
    if not fresh:
        print("すべて通知済みの銘柄。再送しません。")
        return 0

    payload = {
        "username": "StockScout",
        "content": f"**強い推薦 {len(fresh)} 件**　—　{asof} 終値時点\n"
                   f"性格の異なる 4 カテゴリ以上の手法が同時に同じ銘柄を指しました。",
        "embeds": build_embeds(fresh, asof),
    }

    req = urllib.request.Request(
        WEBHOOK,
        data=json.dumps(payload).encode("utf-8"),
        headers=COMMON_HEADERS,
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print(f"通知しました: {len(fresh)} 件 (HTTP {r.status})")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")[:300]
        print(f"通知に失敗しました: HTTP {e.code} {e.reason} / {body}", file=sys.stderr)
        if e.code == 403:
            print("  → Webhook URL が無効化・削除されているか、コピー時に空白/改行が"
                  "混入している可能性があります。Discord側でWebhookを再発行し、"
                  "GitHub SecretsのDISCORD_WEBHOOK_URLを更新してください。", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"通知に失敗しました: {e}", file=sys.stderr)
        return 1

    state["last"].setdefault(asof[:7], [])
    state["last"][asof[:7]] = list(prev | {x["stock"]["code"] for x in fresh})
    save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
