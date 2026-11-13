#!/usr/bin/env python3
"""生成「同一局、四个时间窗口」对局包。

设计要点（对应 2026-11-13 的需求变更）：
  1. 时间窗口为「分时 / 日K / 周K / 月K」，是**同一只股票、同一段时间**
     的四种 K 线粒度，不是四局独立行情。切换窗口不换股、不重开局。
     周 K / 月 K 由完整日线在运行时聚合，数据包不额外增大。
  2. 一局的时间游标统一落在 5 分钟 K 上；日线视图里「当日」那根 K
     由当天截至游标的分钟 K 实时合成，绝不把整日 OHLC 提前透露出去。
  3. 日线与分钟线都是 BaoStock 前复权，按「同一交易日的收盘价」逐日做
     比例校准，保证各窗口报价一致；这是口径对齐，不是合成行情。
  4. **一局 150 个完整交易日**：训练按「日」决策，每次推进给完整一天，
     分时整屏换一天、日K 多一根。150 天每天都要有真实分时，因此分钟线
     用 BaoStock 的一年期窗口（新浪只给近 21 个交易日，不够用）。
  5. **训练局由选股信号驱动**：`select_stocks.py` 按用户的三层规则
     （基础池 / 量能 / 周线 MA5>MA10>MA20）挑出标的与信号日；长窗口下
     再用同一套核心技术条件在日线历史里补一批信号日，让 150 天里的
     形态不都挤在末尾。每局保证窗口内含一个信号日。
  6. 日线带完整历史（2015 年起），供缩小左拉判断当前价的历史位置；
     分钟线裁剪到对局实际用到的区间，控制数据包体积。

输入：
  src/data/bars.ts              选股命中标的的 2015 起完整前复权日线
  src/data/raw/minutes_long.json  BaoStock 一年期 5 分钟线（fetch_minutes_long.py 生成）
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
# 新浪只能给近 21 个交易日，一局 150 天必须用 BaoStock 的一年期 5 分钟线。
MINUTE_LONG_FILE = RAW / "minutes_long.json"
MINUTE_FILE = RAW / "minutes.json"
SELECTION_FILE = RAW / "selection.json"
FUND_FILE = RAW / "fundamentals.json"

# advance 是一局的交易日数：训练按「日」决策，每次推进给完整一天，
# 分时整屏换一天，日K 多一根；周/月视图沿用各自的周期推进。
WINDOWS = [
    {"key": "m5", "label": "分时", "visible": 60, "advance": 150,
     "note": "当日完整分时：价格线 + 均价线，一次推进一整天"},
    {"key": "day", "label": "日K", "visible": 60, "advance": 150,
     "note": "带 2015 年起完整历史；当日 K 由完整日内分钟线合成"},
    {"key": "week", "label": "周K", "visible": 40, "advance": 150,
     "note": "由日线按自然周聚合，当前周由已揭示数据合成"},
    {"key": "month", "label": "月K", "visible": 24, "advance": 150,
     "note": "由日线按自然月聚合，当前月由已揭示数据合成"},
]
GAME_DAYS = WINDOWS[0]["advance"]   # 一局 150 个完整交易日
MIN_GAME_DAYS = GAME_DAYS           # 跨度不足 150 天的局一律不生成
MIN_MINUTE_BARS = 300
# 期望信号日落在窗口的第 60~120 天，让信号前有历史、信号后有交易时间；
# 受分钟数据窗口边界约束时自动夹到合法范围内。
SIGNAL_POS = (60, 120)


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


def technical_signals(daily: list[list], since: str) -> set[str]:
    """补充历史技术信号日，让 150 天窗口里的形态不都挤在末尾。

    与 select_stocks.py 用的是同一套核心技术条件（放量 ≥2.5 倍 +
    周线 MA5>MA10>MA20），差别仅在：日线缓存没有成交额字段，用
    「收盘价 × 成交量」作代理；基础池过滤不回溯，因为标的本身已经是
    从那套过滤里选出来的 18 只。MA 与放量分母都只取已实现的数据。
    """
    weeks: OrderedDict[tuple[int, int], list[list]] = OrderedDict()
    for b in daily:
        y, w, _ = datetime.fromisoformat(b[0]).isocalendar()
        weeks.setdefault((y, w), []).append(b)
    wkeys = sorted(weeks)
    wclose = [weeks[k][-1][4] for k in wkeys]
    wma: dict[tuple[int, int], dict[int, float]] = {}
    for i, k in enumerate(wkeys):
        wma[k] = {n: sum(wclose[i - n + 1:i + 1]) / n
                  for n in (5, 10, 20) if i >= n - 1}
    amount = [b[4] * b[5] for b in daily]
    out: set[str] = set()
    for i, b in enumerate(daily):
        if b[0] < since or i < 20:
            continue
        y, w, _ = datetime.fromisoformat(b[0]).isocalendar()
        m = wma.get((y, w))
        if not m or len(m) < 3 or not (m[5] > m[10] > m[20]):
            continue
        base = sum(amount[i - 10:i]) / 10
        if base > 0 and amount[i] / base >= 2.5:
            out.add(b[0])
    return out


def make_games(symbols: dict, signals: dict[str, list[str]],
               extra: dict[str, set[str]], per_symbol: int,
               rng: random.Random) -> tuple[list[dict], dict[str, int]]:
    """每局 150 个完整交易日，且窗口内含一个满足核心条件的信号日。

    s 是起始日的第一根 5 分钟 K，e 是第 150 天 15:00 的最后一根；
    引擎开局把起始日走完停在收盘，之后每次推进恰好落到下一个日末。
    起点尽量让信号日落在窗口中段，受分钟数据边界约束时自动夹到合法范围。
    """
    games: list[dict] = []
    kinds = {"screen": 0, "history": 0}
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
        max_start = len(days) - GAME_DAYS
        if max_start < 0:
            print(f"  - {code} 只有 {len(days)} 个交易日，不足 {GAME_DAYS} 天，跳过")
            continue
        # 窗口前 20 天的信号不做锚点：那种局一开局信号就已经走完，
        # 看不到形态形成过程。其余信号尽量放在窗口中段。
        pool: list[tuple[str, str]] = []
        for kind, candidates in (('screen', signals.get(code, [])),
                                 ('history', sorted(extra.get(code, set())))):
            for d in candidates:
                if d in day_first and days.index(d) >= 20:
                    pool.append((kind, d))
        for _ in range(per_symbol):
            if pool:
                kind, signal = rng.choice(pool)
                sig_idx = days.index(signal)
                want = rng.randint(*SIGNAL_POS)
                start_idx = max(0, min(sig_idx - want, max_start))
            else:
                kind, signal = '', None
                start_idx = rng.randint(0, max_start)
            end_idx = start_idx + GAME_DAYS - 1
            s = day_first[days[start_idx]]
            e = day_last[days[end_idx]]
            # e 落在最后一根 5 分钟 K 是合法的：引擎按 dayEnds 判定结束，
            # 不需要 e 之后还有数据。只需排除 s/e 越界或退化的局。
            if e <= s or e >= n or s < 0:
                continue
            game: dict = {"c": code, "s": s, "e": e}
            if signal and start_idx <= sig_idx <= end_idx:
                game["signal"] = signal
                game["signalKind"] = kind
                kinds[kind] += 1
            games.append(game)
    rng.shuffle(games)
    return games, kinds


def trim_minutes(symbols: dict, games: list[dict]) -> int:
    """只保留对局真正用到的分钟区间并重映射游标，避免数据包白白大一截。

    昨收价由 dayBars 提供、当日累计由 game.s 界定，裁剪不影响任何口径。
    """
    used: dict[str, list[dict]] = {}
    for g in games:
        used.setdefault(g["c"], []).append(g)
    total = 0
    for code, gs in used.items():
        lo = min(g["s"] for g in gs)
        hi = max(g["e"] for g in gs)
        symbols[code]["m5"] = symbols[code]["m5"][lo:hi + 1]
        total += hi - lo + 1
        for g in gs:
            g["s"] -= lo
            g["e"] -= lo
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description="生成四窗口对局包（信号日驱动）")
    ap.add_argument("--per-symbol", type=int, default=16, help="每只标的生成多少局")
    ap.add_argument("--seed", type=int, default=20261113, help="随机种子，保证可复现")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = load_daily()
    minute_file = MINUTE_LONG_FILE if MINUTE_LONG_FILE.exists() else MINUTE_FILE
    minutes = load_json(minute_file, {}).get("m5") or {}
    selection = load_json(SELECTION_FILE, {})
    fund = load_json(FUND_FILE, {})
    signals: dict[str, list[str]] = {
        p["code"]: [s["date"] for s in p["signals"]]
        for p in selection.get("symbols", [])
    }
    # 长窗口下补一批历史技术信号日，避免 150 天里的形态全挤在最后 20 天
    first_minute_day = min((str(b[0])[:10] for v in minutes.values() for b in v),
                           default="2026-01-01")
    extra = {c: technical_signals(bars, first_minute_day)
             for c, bars in daily.items() if c in minutes}
    print(f"[source] 日线 {len(daily)} 只 / {sum(len(v) for v in daily.values())} 根")
    print(f"[source] 5 分钟线 {minute_file.name} · {len(minutes)} 只 / "
          f"{sum(len(v) for v in minutes.values())} 根")
    print(f"[source] 选股命中 {len(signals)} 只 / {sum(len(v) for v in signals.values())} 个信号日")
    print(f"[source] 历史技术信号补充 {sum(len(v) for v in extra.values())} 个")

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

    games, kinds = make_games(symbols, signals, extra,
                              args.per_symbol, random.Random(args.seed))
    with_signal = sum(1 for g in games if g.get("signal"))
    if not with_signal:
        raise SystemExit("对局包里没有任何一局包含选股信号，已中止；不生成无意义数据")
    # 裁剪到被使用区间，避免把没用到的 40 多天分钟线也塞进数据包
    kept_minutes = trim_minutes(symbols, games)
    history_bars = sum(len(v["day"]) for v in symbols.values())
    print(f"[trim] 分钟线保留 {kept_minutes} 根 / {len(symbols)} 只")
    body = {
        "version": 7,
        "windows": WINDOWS,
        "gameDays": GAME_DAYS,
        "symbols": symbols,
        "games": games,
    }
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:10]
    filename = f"sessions-{digest}.json"
    (OUT_DIR / filename).write_bytes(raw)

    manifest = {
        "version": 7,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "baostock 前复权日线（2015 起完整历史） + baostock 一年期 5 分钟线 + 腾讯股本快照",
        "adjust": "前复权，逐日按收盘价对齐",
        "dataFile": filename,
        "bytes": len(raw),
        "symbols": len(symbols),
        "games": len(games),
        "gameDays": GAME_DAYS,
        "minuteBars": kept_minutes,
        "historyBars": history_bars,
        "selection": {
            "symbols": len(signals),
            "signals": sum(len(v) for v in signals.values()),
            "scanned": selection.get("scanned", 0),
            "gamesWithSignal": with_signal,
            "screenSignals": kinds["screen"],
            "historySignals": kinds["history"],
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
