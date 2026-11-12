#!/usr/bin/env python3
"""生成「同一局、双时间窗口」对局包。

设计要点（对应 2026-11-12 的需求变更）：
  1. 时间窗口只剩「分时」和「日线」，二者是**同一只股票、同一段时间**
     的两种 K 线粒度，不是两局独立行情。切换窗口不换股、不重开局。
  2. 一局的时间游标统一落在 5 分钟 K 线上；日线视图里「当日」那根 K
     由当天截至游标的分钟 K 实时合成，绝不把整日 OHLC 提前透露出去。
  3. 本地日线是 BaoStock 前复权，分钟线是东财前复权，两者复权基准日
     可能不同。按「同一交易日的收盘价」逐日做比例校准，保证两个窗口
     报价一致；这是口径对齐，不是合成行情。

输入：
  src/data/bars.ts              本地前复权日线（15 只，含到 2026-11）
  src/data/raw/minutes.json     东财 5 分钟线缓存（由 fetch_minutes.py 生成）
输出：
  public/data/manifest.json
  public/data/sessions-<hash>.json   { windows, symbols, games }

用法：
    .venv/Scripts/python.exe tools/build_sessions.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "data"
DAILY_FILE = ROOT / "src" / "data" / "bars.ts"
MINUTE_FILE = ROOT / "src" / "data" / "raw" / "minutes.json"

# 手机上一屏能看清的 K 线根数；advance 是一局最多推进的 5 分钟 K 根数
# （480 根 ≈ 10 个交易日；日线窗口下一次推进＝一个交易日）。
WINDOWS = [
    {"key": "m5", "label": "分时", "visible": 60, "advance": 480,
     "note": "5 分钟 K 线，公开数据源最细只到 5 分钟"},
    {"key": "day", "label": "日线", "visible": 60, "advance": 480,
     "note": "当日 K 由已揭示的分钟线合成，不泄露未来"},
]
HISTORY_DAYS = 60          # 日线窗口的前置历史根数
MIN_MINUTE_BARS = 300      # 低于该根数的标的不足以成局


def load_daily() -> dict[str, list[list]]:
    text = DAILY_FILE.read_text(encoding="utf-8")
    marker = "export const BARS: Record<string, Bar[]> = "
    if marker not in text:
        raise SystemExit(f"{DAILY_FILE} 格式不符，无法提取 BARS")
    return json.loads(text.split(marker, 1)[1].strip())


def load_minutes() -> dict[str, list[list]]:
    if not MINUTE_FILE.exists():
        raise SystemExit(
            f"缺少 {MINUTE_FILE}。先运行：python tools/fetch_minutes.py\n"
            "（没有真实分钟线时不会伪造分时数据，日线窗口可照常生成）"
        )
    data = json.loads(MINUTE_FILE.read_text(encoding="utf-8"))
    return data.get("m5") or {}


def align_symbol(code: str, daily: list[list], minutes: list[list]) -> dict | None:
    """把分钟线逐日校准到日线复权口径，并切出日线窗口需要的历史段。"""
    by_date: dict[str, float] = {b[0]: b[4] for b in daily}

    groups: OrderedDict[str, list[list]] = OrderedDict()
    for bar in minutes:
        d = str(bar[0])[:10]
        if d not in by_date:       # 日线还没更新或当天停牌，不纳入训练
            continue
        groups.setdefault(d, []).append(list(bar))
    if not groups:
        return None

    aligned: list[list] = []
    max_drift = 0.0
    for d, group in groups.items():
        last_close = group[-1][4]
        if last_close <= 0:
            continue
        ratio = by_date[d] / last_close
        max_drift = max(max_drift, abs(ratio - 1))
        for bar in group:
            aligned.append([
                bar[0],
                round(bar[1] * ratio, 3),
                round(bar[2] * ratio, 3),
                round(bar[3] * ratio, 3),
                round(bar[4] * ratio, 3),
                bar[5],
            ])
    if len(aligned) < MIN_MINUTE_BARS:
        return None

    first_day = min(groups)
    # 日线窗口：该日之前的 60 根历史 + 分钟数据覆盖到的全部交易日
    day_index = {b[0]: i for i, b in enumerate(daily)}
    anchor = day_index.get(first_day)
    if anchor is None:
        return None
    start = max(0, anchor - HISTORY_DAYS)
    last_day = max(groups)
    end = day_index.get(last_day, anchor)
    day_bars = daily[start:end + 1]
    if len(day_bars) < 30:
        return None
    if max_drift > 0.05:
        print(f"  ! {code} 复权校准系数偏离 {max_drift:.2%}，请核对数据源")
    return {"day": day_bars, "m5": aligned, "drift": max_drift}


def make_games(symbols: dict, per_symbol: int, rng: random.Random) -> list[dict]:
    games: list[dict] = []
    for code, data in symbols.items():
        n = len(data["m5"])
        # 起点压在前 60~200 根：分时视图是累积显示，初始不至于密到看不清
        lo = WINDOWS[0]["visible"]
        hi = min(n - WINDOWS[0]["advance"] - 1, 200)
        if hi <= lo:
            hi = min(n - 2, lo + 120)
        for _ in range(per_symbol):
            s = rng.randint(lo, max(lo, hi))
            e = min(n - 1, s + WINDOWS[0]["advance"])
            games.append({"c": code, "s": s, "e": e})
    rng.shuffle(games)
    return games


def main() -> int:
    ap = argparse.ArgumentParser(description="生成对局包（分时 / 日线双窗口）")
    ap.add_argument("--per-symbol", type=int, default=16, help="每只标的生成多少局")
    ap.add_argument("--seed", type=int, default=20261112, help="随机种子，保证可复现")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = load_daily()
    minutes = load_minutes()
    print(f"[source] 日线 {len(daily)} 只 / {sum(len(v) for v in daily.values())} 根")
    print(f"[source] 5 分钟线 {len(minutes)} 只 / {sum(len(v) for v in minutes.values())} 根")

    symbols: dict[str, dict] = {}
    for code, daily_bars in daily.items():
        if code not in minutes:
            continue
        item = align_symbol(code, daily_bars, minutes[code])
        if not item:
            print(f"  - {code} 分钟数据不足或与日线不重叠，跳过")
            continue
        symbols[code] = {"day": item["day"], "m5": item["m5"]}
        first, last = item["m5"][0][0], item["m5"][-1][0]
        print(f"  + {code} 日线 {len(item['day'])} 根 · 分时 {len(item['m5'])} 根 "
              f"{first} ~ {last} · 校准漂移 {item['drift']:.3%}")
    if not symbols:
        raise SystemExit("没有任何标的能同时对齐全两个窗口，已中止；不生成半成品数据")

    games = make_games(symbols, args.per_symbol, random.Random(args.seed))
    body = {
        "version": 3,
        "windows": WINDOWS,
        "symbols": symbols,
        "games": games,
    }
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:10]
    filename = f"sessions-{digest}.json"
    (OUT_DIR / filename).write_bytes(raw)

    manifest = {
        "version": 3,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "baostock 日线 + 东方财富 5 分钟线",
        "adjust": "前复权，逐日按收盘价对齐",
        "dataFile": filename,
        "bytes": len(raw),
        "symbols": len(symbols),
        "games": len(games),
        "windows": WINDOWS,
        "periods": WINDOWS,  # 兼容旧前端读取，语义已改为「时间窗口」
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    keep = {"manifest.json", filename}
    for old in OUT_DIR.glob("*.json"):
        if old.name not in keep:
            old.unlink()

    print(f"\n[ok] {filename}  {len(raw)/1024/1024:.2f} MB · "
          f"{len(symbols)} 只 · {len(games)} 局 · 2 个时间窗口")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
