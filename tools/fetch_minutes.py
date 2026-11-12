#!/usr/bin/env python3
"""可选：补齐分钟线缓存，供 build_segments.py 生成分钟周期片段包。

主流程完全离线（日 / 周 / 月由本地日线生成），只有需要
「分时·5分 / 30分 / 60分」时才运行本脚本。数据源为东方财富公开行情
接口，匿名免注册、仅需 HTTPS，且只在生成数据时联网一次；生成的片段包
仍是静态文件，App 运行时完全离线。

用法：
    python tools/fetch_minutes.py --probe          # 先探通道
    python tools/fetch_minutes.py                  # 拉全量到 src/data/raw/minutes.json
    python tools/build_segments.py                 # 重新生成片段包并更新 manifest

说明：接口偶发被本机代理/WAF 掐断，脚本内置多域名轮换与重试；
若全部失败，主线不受影响，换网络后重跑即可。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAILY_FILE = ROOT / "src" / "data" / "bars.ts"
CACHE = ROOT / "src" / "data" / "raw" / "minutes.json"

HOSTS = [
    "push2his.eastmoney.com",
    "92.push2his.eastmoney.com",
    "push2delay.eastmoney.com",
]
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "*/*",
}

# key -> (东财 klt, 取数天数)。窗口只要够切出若干 141 根片段即可。
SPECS = {
    "m5": dict(klt="5", days=400),
    "m30": dict(klt="30", days=1100),
    "m60": dict(klt="60", days=2200),
}


def daily_codes() -> list[str]:
    text = DAILY_FILE.read_text(encoding="utf-8")
    marker = "export const BARS: Record<string, Bar[]> = "
    return list(json.loads(text.split(marker, 1)[1].strip()))


def secid(code: str) -> str:
    market, symbol = code.split(".", 1)
    return f"{'1' if market == 'sh' else '0'}.{symbol}"


def request_klines(code: str, klt: str, start: str, end: str, retries: int = 3):
    query = urllib.parse.urlencode({
        "secid": secid(code),
        "klt": klt,
        "fqt": "1",  # 前复权
        "beg": start,
        "end": end,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        "rtntype": "6",
        "lmt": "100000",
    })
    last_error: Exception | None = None
    for attempt in range(retries):
        host = HOSTS[attempt % len(HOSTS)]
        url = f"https://{host}/api/qt/stock/kline/get?{query}"
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=12) as res:
                payload = json.load(res)
            klines = ((payload.get("data") or {}).get("klines")) or []
            return parse_klines(klines)
        except Exception as ex:  # 连接被掐断 / 超时 / 限流，换域名重试
            last_error = ex
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"{type(last_error).__name__}: {last_error}")


def parse_klines(klines: list[str]) -> list[list]:
    bars: list[list] = []
    for line in klines:
        parts = line.split(",")
        if len(parts) < 6:
            continue
        try:
            # f51 时间, f52 开, f53 收, f54 高, f55 低, f56 成交量(手)
            volume = int(float(parts[5])) * 100  # 统一成「股」，与日线口径一致
            if volume <= 0:
                continue
            bars.append([
                parts[0],
                round(float(parts[1]), 3),
                round(float(parts[3]), 3),
                round(float(parts[4]), 3),
                round(float(parts[2]), 3),
                volume,
            ])
        except (ValueError, IndexError):
            continue
    return bars


def main() -> int:
    ap = argparse.ArgumentParser(description="拉取分钟线并写入本地缓存")
    ap.add_argument("--probe", action="store_true", help="只测一只股票的一个短窗口")
    ap.add_argument("--periods", default="m5,m30,m60", help="逗号分隔周期")
    ap.add_argument("--limit", type=int, default=0, help="限制标的数，0 表示全部")
    ap.add_argument("--end", default=date.today().isoformat(), help="截止日期")
    args = ap.parse_args()

    codes = daily_codes()
    keys = [k.strip() for k in args.periods.split(",") if k.strip() in SPECS]
    if args.probe:
        keys = ["m5"]
        codes = codes[:1]
    elif args.limit:
        codes = codes[:args.limit]
    if not keys:
        raise SystemExit(f"周期参数无效，可用：{list(SPECS)}")

    end_date = date.fromisoformat(args.end)
    result: dict[str, dict[str, list[list]]] = {}
    for key in keys:
        spec = SPECS[key]
        start = (end_date - timedelta(days=spec["days"])).strftime("%Y%m%d")
        end = end_date.strftime("%Y%m%d")
        result[key] = {}
        consecutive_failures = 0
        for i, code in enumerate(codes, 1):
            try:
                bars = request_klines(code, spec["klt"], start, end)
                if bars:
                    result[key][code] = bars
                consecutive_failures = 0
                print(f"[{key}] {i}/{len(codes)} {code} {len(bars)} 根", flush=True)
            except Exception as ex:
                consecutive_failures += 1
                print(f"[{key}] {i}/{len(codes)} {code} 跳过: {ex}", flush=True)
                if i == 1 or consecutive_failures >= 3:
                    print(f"[abort] {key} 通道不可用，停止该周期", flush=True)
                    break
            time.sleep(0.25)

    usable = {k: v for k, v in result.items() if v}
    if not usable:
        print("[fail] 没有取到任何分钟数据；换网络后重试即可，日/周/月主线不受影响")
        return 1
    if args.probe:
        print(f"[probe ok] {[(k, len(v), len(next(iter(v.values())))) for k, v in usable.items()]}")
        return 0

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(usable, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    tmp.replace(CACHE)
    print(f"[ok] {CACHE}  {CACHE.stat().st_size/1024/1024:.1f} MB")
    for k, v in usable.items():
        print(f"  {k}: {len(v)} 只 / {sum(len(x) for x in v.values())} 根")
    return 0


if __name__ == "__main__":
    sys.exit(main())
