#!/usr/bin/env python3
"""补齐 5 分钟线缓存，供 build_sessions.py 生成「分时」时间窗口。

主流程完全离线（日线来自本地 src/data/bars.ts），只有启用「分时」
窗口时才运行本脚本。数据源为新浪财经公开行情接口，匿名免注册、
仅需 HTTPS，且只在生成数据时联网一次；生成的对局包仍是静态文件，
App 运行时完全离线。

    为什么要新浪：东方财富 push2his 在本机 TUN 代理下会被 RST 掐断，
    新浪 quotes.sina.cn 通道稳定；接口单次最多返回 1023 根 5 分钟 K
    （约 21 个交易日），足够一局 480 根的训练窗口。

用法：
    python tools/fetch_minutes.py --probe        # 先探通道
    python tools/fetch_minutes.py                # 拉全量到 src/data/raw/minutes.json
    python tools/build_sessions.py               # 生成对局包并更新 manifest

已取到的标的会立即写回缓存；中断后重跑只补缺失标的，不丢已有数据。
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAILY_FILE = ROOT / "src" / "data" / "bars.ts"
CACHE = ROOT / "src" / "data" / "raw" / "minutes.json"

ENDPOINT = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20t=/CN_MarketDataService.getKLineData"
HOSTS = ["quotes.sina.cn", "quotes.sina.cn"]
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Referer": "https://finance.sina.com.cn/",
    "Accept": "*/*",
}
DATALEN = 1023  # 新浪上限，超过会返回空


def daily_codes() -> list[str]:
    text = DAILY_FILE.read_text(encoding="utf-8")
    marker = "export const BARS: Record<string, Bar[]> = "
    return list(json.loads(text.split(marker, 1)[1].strip()))


def sina_symbol(code: str) -> str:
    return code.replace(".", "")


def request_klines(code: str, retries: int = 6) -> list[list]:
    url = f"{ENDPOINT}?symbol={sina_symbol(code)}&scale=5&ma=no&datalen={DATALEN}"
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=15) as res:
                text = res.read().decode("utf-8", "ignore")
            return parse_response(text)
        except Exception as ex:
            last_error = ex
            time.sleep(min(2.0, 0.3 * (attempt + 1)) + random.random() * 0.2)
    raise RuntimeError(f"{type(last_error).__name__}: {last_error}")


def parse_response(text: str) -> list[list]:
    # 形如 /*<script>…*/\nvar t=([{...},{...}]);  —— 只取数组部分
    start = text.find("([")
    end = text.rfind("])")
    if start < 0 or end < 0:
        raise RuntimeError("响应不是预期的 JSONP 数组")
    rows = json.loads(text[start + 1:end + 1])
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("空数据")
    bars: list[list] = []
    for r in rows:
        try:
            o, h, low, c = (float(r["open"]), float(r["high"]),
                            float(r["low"]), float(r["close"]))
            volume = int(float(r["volume"]))
            if min(o, h, low, c) <= 0 or volume <= 0:
                continue
            if h < max(o, c) or low > min(o, c):
                continue
            # 去掉秒，保留「YYYY-MM-DD HH:MM」，与日线前 10 位日期可直接比对
            label = str(r["day"])[:16]
            bars.append([label, round(o, 3), round(h, 3), round(low, 3),
                         round(c, 3), volume])
        except (KeyError, ValueError, TypeError):
            continue
    if len(bars) < 100:
        raise RuntimeError(f"有效 K 线仅 {len(bars)} 根")
    bars.sort(key=lambda b: b[0])
    return bars


def write_cache(data: dict) -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    tmp.replace(CACHE)


def main() -> int:
    ap = argparse.ArgumentParser(description="拉取 5 分钟线并写入本地缓存")
    ap.add_argument("--probe", action="store_true", help="只测一只股票")
    ap.add_argument("--limit", type=int, default=0, help="限制标的数，0 表示全部")
    ap.add_argument("--refresh", action="store_true", help="忽略已有缓存，全部重取")
    args = ap.parse_args()

    codes = daily_codes()
    if args.limit:
        codes = codes[:args.limit]
    if args.probe:
        codes = codes[:1]
        bars = request_klines(codes[0])
        print(f"[probe ok] {codes[0]} {len(bars)} 根  {bars[0][0]} ~ {bars[-1][0]}")
        return 0

    cached: dict[str, dict[str, list[list]]] = {}
    if CACHE.exists() and not args.refresh:
        try:
            cached = json.loads(CACHE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            cached = {}
    # 旧版缓存来自东财，时间标签是 10 位日期 + 时间，格式不同；统一重取
    result: dict[str, list[list]] = dict(cached.get("m5") or {})
    if cached.get("source") not in (None, "sina"):
        result = {}

    missing = [c for c in codes if not result.get(c)]
    print(f"[cache] 已有 {len(codes) - len(missing)}/{len(codes)} 只，待取 {len(missing)} 只", flush=True)
    consecutive_failures = 0
    for i, code in enumerate(missing, 1):
        try:
            bars = request_klines(code)
            result[code] = bars
            consecutive_failures = 0
            write_cache({"source": "sina", "scale": 5,
                         "fetchedAt": datetime.now().isoformat(timespec="seconds"),
                         "m5": result})
            print(f"[m5] {i}/{len(missing)} {code} {len(bars)} 根 "
                  f"{bars[0][0]} ~ {bars[-1][0]}", flush=True)
        except Exception as ex:
            consecutive_failures += 1
            print(f"[m5] {i}/{len(missing)} {code} 跳过: {ex}", flush=True)
            if consecutive_failures >= 5:
                print("[abort] 连续 5 只失败，链路可能断了；重跑本脚本即可续取", flush=True)
                break
        time.sleep(0.25)

    if not result:
        print("[fail] 没有取到任何分钟数据；换网络后重试即可，日线窗口不受影响")
        return 1
    write_cache({"source": "sina", "scale": 5,
                 "fetchedAt": datetime.now().isoformat(timespec="seconds"),
                 "m5": result})
    print(f"[ok] {CACHE}  {CACHE.stat().st_size/1024/1024:.1f} MB · "
          f"{len(result)} 只 / {sum(len(v) for v in result.values())} 根")
    return 0


if __name__ == "__main__":
    sys.exit(main())
