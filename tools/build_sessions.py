#!/usr/bin/env python3
"""生成「同一局、四个时间窗口」对局包。

设计要点（对应 2026-11-13 的需求变更）：
  1. 时间窗口为「分时 / 日K / 周K / 月K」，是**同一只股票、同一段时间**
     的四种 K 线粒度，不是四局独立行情。切换窗口不换股、不重开局。
     周 K / 月 K 由完整日线在运行时聚合，数据包不额外增大。
  2. 一局的时间游标统一落在 5 分钟 K 上；日线视图里「当日」那根 K
     由当天截至游标的分钟 K 实时合成，绝不把整日 OHLC 提前透露出去。
  3. 本地日线是 BaoStock 前复权，分钟线是新浪前复权，两者复权基准日
     可能不同。按「同一交易日的收盘价」逐日做比例校准，保证各窗口
     报价一致；这是口径对齐，不是合成行情。
  4. **训练局由选股信号驱动**：`select_stocks.py` 按用户的三层规则
     （基础池 / 量能 / 周线 MA5>MA10>MA20）挑出标的与信号日，每局的
     起点压在信号日之前 2~5 个交易日，终点尽量延伸到分时数据末尾，
     保证这一局的 K 线里确实包含满足筛选条件的那段形态。
  5. 日线带完整历史（2015 年起），供缩小左拉判断当前价的历史位置。

输入：
  src/data/bars.ts              选股命中标的的 2015 起完整前复权日线
  src/data/raw/minutes.json     新浪 5 分钟线缓存（fetch_pool.py 生成）
  src/data/raw/selection.json   选股结果与信号日
  src/data/raw/fundamentals.json 流通/总股本静态快照
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
RAW = ROOT / "src" / "data" / "raw"
DAILY_FILE = ROOT / "src" / "data" / "bars.ts"
MINUTE_FILE = RAW / "minutes.json"
SELECTION_FILE = RAW / "selection.json"
FUND_FILE = RAW / "fundamentals.json"

# advance 是一局的交易日数：训练按「日」决策，每次推进给完整一天，
# 分时整屏换一天，日K 多一根；周/月视图沿用各自的周期推进。
WINDOWS = [
    {"key": "m5", "label": "分时", "visible": 60, "advance": 15,
     "note": "当日完整分时：价格线 + 均价线，一次推进一整天"},
    {"key": "day", "label": "日K", "visible": 60, "advance": 15,
     "note": "带 2015 年起完整历史；当日 K 由完整日内分钟线合成"},
    {"key": "week", "label": "周K", "visible": 40, "advance": 15,
     "note": "由日线按自然周聚合，当前周由已揭示数据合成"},
    {"key": "month", "label": "月K", "visible": 24, "advance": 15,
     "note": "由日线按自然月聚合，当前月由已揭示数据合成"},
]
ADVANCE_DAYS = WINDOWS[0]["advance"]
MIN_GAME_DAYS = 12         # 少于 12 个完整交易日的局不生成（按天推进太短）
MIN_MINUTE_BARS = 300      # 低于该根数的标的不足以成局
LEAD_DAYS = (1, 5)         # 开局压在信号日前 1~5 个交易日，且落在日首


def load_daily() -> dict[str, list[list]]:
    text = DAILY_FILE.read_text(encoding="utf-8")
    marker = "export const BARS: Record<string, Bar[]> = "
    if marker not in text:
        raise SystemExit(f"{DAILY_FILE} 格式不符，无法提取 BARS")
    return json.loads(text.split(marker, 1)[1].strip())


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def align_symbol(code: str, daily: list[list], minutes: list[list]) -> dict | None:
    """把分钟线逐日校准到日线复权口径，并带上该标的的完整日线历史。"""
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
    day_index = {b[0]: i for i, b in enumerate(daily)}
    anchor = day_index.get(first_day)
    if anchor is None:
        return None
    last_day = max(groups)
    end = day_index.get(last_day, anchor)
    day_bars = daily[:end + 1]      # 完整历史，从数据起点 2015 年
    if len(day_bars) < 30:
        return None
    if max_drift > 0.05:
        print(f"  ! {code} 复权校准系数偏离 {max_drift:.2%}，请核对数据源")
    return {"day": day_bars, "m5": aligned, "drift": max_drift}


def make_games(symbols: dict, signals: dict[str, list[str]],
               per_symbol: int, rng: random.Random) -> list[dict]:
    """每局锚定一个真实信号日；s 是起始日日首，e 必须是完整交易日的日末。

    训练以「交易日」为单位：引擎开局把起始日走完并停在该日收盘，之后
    每次推进恰好落到下一个日末，分时一次给一整天。因此终点不能落在
    某天中间的 5 分钟 K 上，否则最后一天会退化成只有几个点的残图。
    """
    games: list[dict] = []
    for code, data in symbols.items():
        m5 = data["m5"]
        n = len(m5)
        dates = [str(b[0])[:10] for b in m5]
        days = sorted(set(dates))
        day_first: dict[str, int] = {}
        day_last: dict[str, int] = {}
        for i, d in enumerate(dates):
            day_first.setdefault(d, i)
            day_last[d] = i
        # 信号日若落在分时窗口第一天（只有半天数据、无法做开局锚点），
        # 不能拿来生成局，否则信号会落在起点之前而没被 K 线覆盖。
        valid = [d for d in signals.get(code, [])
                 if d in day_first and days.index(d) >= 1]
        # 新浪 1023 根窗口的第一天只有下午半天（13:50 起），不能拿来开局。
        if not valid:
            # 没有可用信号日的标的仍可成局，但不宣称含信号
            hi = max(1, len(days) - 1 - ADVANCE_DAYS)
            for _ in range(per_symbol):
                di = rng.randint(1, hi)
                s = day_first[days[di]]
                e = day_last[days[min(di + ADVANCE_DAYS, len(days) - 1)]]
                if e > s:
                    games.append({"c": code, "s": s, "e": e})
            continue
        # 起点若太靠近分时窗口末尾，终点会被截在最后一个交易日，
        # 按天推进两三下就结束。重抽到跨度足够的一局为止。
        made = 0
        tries = 0
        while made < per_symbol and tries < per_symbol * 20:
            tries += 1
            signal = rng.choice(valid)
            sig_day_idx = days.index(signal)
            lead_days = rng.randint(*LEAD_DAYS)
            start_idx = max(1, sig_day_idx - lead_days)
            end_idx = min(start_idx + ADVANCE_DAYS, len(days) - 1)
            if end_idx - start_idx + 1 < MIN_GAME_DAYS:
                continue
            s = day_first[days[start_idx]]   # 可以是 0：那才是当天第一根
            e = day_last[days[end_idx]]
            if e > s and s < n - 2:
                games.append({"c": code, "s": s, "e": e, "signal": signal})
                made += 1
    rng.shuffle(games)
    return games


def main() -> int:
    ap = argparse.ArgumentParser(description="生成四窗口对局包（信号日驱动）")
    ap.add_argument("--per-symbol", type=int, default=16, help="每只标的生成多少局")
    ap.add_argument("--seed", type=int, default=20261113, help="随机种子，保证可复现")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = load_daily()
    minutes = load_json(MINUTE_FILE, {}).get("m5") or {}
    selection = load_json(SELECTION_FILE, {})
    fund = load_json(FUND_FILE, {})
    signals: dict[str, list[str]] = {
        p["code"]: [s["date"] for s in p["signals"]]
        for p in selection.get("symbols", [])
    }
    print(f"[source] 日线 {len(daily)} 只 / {sum(len(v) for v in daily.values())} 根")
    print(f"[source] 5 分钟线 {len(minutes)} 只 / {sum(len(v) for v in minutes.values())} 根")
    print(f"[source] 选股命中 {len(signals)} 只 / {sum(len(v) for v in signals.values())} 个信号日")

    symbols: dict[str, dict] = {}
    for code, daily_bars in daily.items():
        if code not in minutes:
            continue
        item = align_symbol(code, daily_bars, minutes[code])
        if not item:
            print(f"  - {code} 分钟数据不足或与日线不重叠，跳过")
            continue
        symbols[code] = {"day": item["day"], "m5": item["m5"]}
        if code in fund:
            symbols[code]["fundamentals"] = fund[code]
        first, last = item["m5"][0][0], item["m5"][-1][0]
        print(f"  + {code} 日线 {len(item['day'])} 根 · 分时 {len(item['m5'])} 根 "
              f"{first} ~ {last} · 校准漂移 {item['drift']:.3%}")
    if not symbols:
        raise SystemExit("没有任何标的能同时对齐全两个窗口，已中止；不生成半成品数据")

    games = make_games(symbols, signals, args.per_symbol, random.Random(args.seed))
    with_signal = sum(1 for g in games if g.get("signal"))
    if not with_signal:
        raise SystemExit("对局包里没有任何一局包含选股信号，已中止；不生成无意义数据")
    history_bars = sum(len(v["day"]) for v in symbols.values())
    body = {
        "version": 6,
        "windows": WINDOWS,
        "symbols": symbols,
        "games": games,
    }
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:10]
    filename = f"sessions-{digest}.json"
    (OUT_DIR / filename).write_bytes(raw)

    manifest = {
        "version": 6,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "baostock 前复权日线（2015 起完整历史） + 新浪 5 分钟线 + 腾讯股本快照",
        "adjust": "前复权，逐日按收盘价对齐",
        "dataFile": filename,
        "bytes": len(raw),
        "symbols": len(symbols),
        "games": len(games),
        "historyBars": history_bars,
        "selection": {
            "symbols": len(signals),
            "signals": sum(len(v) for v in signals.values()),
            "scanned": selection.get("scanned", 0),
            "gamesWithSignal": with_signal,
        },
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
          f"{len(symbols)} 只 · {len(games)} 局（含信号 {with_signal} 局）· "
          f"4 个时间窗口 · 完整日线 {history_bars} 根")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
