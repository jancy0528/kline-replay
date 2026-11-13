#!/usr/bin/env python3
"""用 BaoStock 拉近一年的 5 分钟线（前复权），替换新浪只能给近 21 天的窗口。

背景：训练单位改成「一个完整交易日」后，一局要 150 根日 K，就要求这 150 天
每天都有真实分时。新浪 CN_MarketDataService 只返回最近 1023 根 5 分钟 K
（约 21 个交易日），不够用；BaoStock 的 frequency='5' 能拿到任意历史区间，
而且带 amount 字段、同样是 adjustflag=2 前复权，与本地日线口径一致。

坑：BaoStock 单次查询区间过长会挂死，连续多只查询也会挂死。实测按季度分段、
每段 login → query → logout 重连最稳（单只 4 段约 20~40 秒）。

输出 src/data/raw/minutes_long.json，结构与 minutes.json 一致：
    {"m5": {"sh.600000": [["2026-04-01 09:35", o, h, l, c, v], ...]}}

用法：
    .venv/Scripts/python.exe tools/fetch_minutes_long.py
    .venv/Scripts/python.exe tools/fetch_minutes_long.py --start 2025-07-01
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import date, timedelta
from pathlib import Path

import baostock as bs

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "src" / "data" / "raw"
PICKED_FILE = RAW / "picked.json"
OUT_FILE = RAW / "minutes_long.json"

FIELDS = "date,time,open,high,low,close,volume,amount"


def segments(start: str, end: str, days: int = 90) -> list[tuple[str, str]]:
    """把区间切成不超过 days 天的小段，避免 BaoStock 长查询挂死。"""
    a = date.fromisoformat(start)
    b = date.fromisoformat(end)
    out: list[tuple[str, str]] = []
    cur = a
    while cur <= b:
        nxt = min(cur + timedelta(days=days - 1), b)
        out.append((cur.isoformat(), nxt.isoformat()))
        cur = nxt + timedelta(days=1)
    return out


def query_segment(code: str, a: str, b: str, retries: int = 3) -> list[list[str]]:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            lg = bs.login()
            if lg.error_code != "0":
                raise RuntimeError(f"login {lg.error_code} {lg.error_msg}")
            q = bs.query_history_k_data_plus(
                code, FIELDS, start_date=a, end_date=b,
                frequency="5", adjustflag="2",
            )
            if q is None or q.error_code != "0":
                raise RuntimeError(f"query {q.error_code if q else 'None'} "
                                   f"{q.error_msg if q else ''}")
            rows: list[list[str]] = []
            while q.next():
                rows.append(q.get_row_data())
            bs.logout()
            return rows
        except Exception as exc:  # noqa: BLE001 - 网络型接口需要重连重试
            last = exc
            try:
                bs.logout()
            except Exception:
                pass
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"{code} {a}~{b} 三次重连仍失败: {last}")


def to_row(r: list[str]) -> list | None:
    """BaoStock time 形如 20260401093500000，取到分钟即可。"""
    t = r[1]
    if len(t) < 12:
        return None
    ts = f"{t[0:4]}-{t[4:6]}-{t[6:8]} {t[8:10]}:{t[10:12]}"
    vol = int(float(r[6] or 0))
    if vol <= 0:
        return None
    return [ts, round(float(r[2]), 3), round(float(r[3]), 3),
            round(float(r[4]), 3), round(float(r[5]), 3), vol]


def fetch(code: str, segs: list[tuple[str, str]]) -> list[list]:
    raw: list[list[str]] = []
    for a, b in segs:
        part = query_segment(code, a, b)
        raw.extend(part)
        print(f"    {a}~{b}: {len(part)} 根", flush=True)
    seen: set[str] = set()
    rows: list[list] = []
    for r in raw:
        row = to_row(r)
        if row and row[0] not in seen:
            seen.add(row[0])
            rows.append(row)
    rows.sort(key=lambda x: x[0])
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2026-11-12")
    ap.add_argument("--force", action="store_true", help="忽略缓存全部重拉")
    args = ap.parse_args()

    codes: list[str] = json.loads(PICKED_FILE.read_text(encoding="utf-8"))
    cache: dict = {}
    if OUT_FILE.exists() and not args.force:
        try:
            cache = json.loads(OUT_FILE.read_text(encoding="utf-8")).get("m5", {})
        except Exception:
            cache = {}
    segs = segments(args.start, args.end)
    print(f"[fetch] {len(codes)} 只 · {args.start}~{args.end} · {len(segs)} 段/只", flush=True)

    out: dict[str, list[list]] = {}
    for i, code in enumerate(codes, 1):
        if code in cache and len(cache[code]) > 5000:
            out[code] = cache[code]
            print(f"[{i}/{len(codes)}] {code} 命中缓存 {len(out[code])} 根", flush=True)
            continue
        t = time.time()
        try:
            rows = fetch(code, segs)
        except Exception as exc:  # noqa: BLE001
            print(f"[{i}/{len(codes)}] {code} 失败: {exc}", flush=True)
            continue
        out[code] = rows
        days = len({r[0][:10] for r in rows})
        print(f"[{i}/{len(codes)}] {code} {len(rows)} 根 / {days} 天 "
              f"{rows[0][0] if rows else '-'} ~ {rows[-1][0] if rows else '-'} "
              f"{round(time.time()-t, 1)}s", flush=True)
        # 每只写完就落盘，中断也不丢已完成的标的
        OUT_FILE.write_text(
            json.dumps({"m5": out}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    OUT_FILE.write_text(
        json.dumps({"m5": out}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    total = sum(len(v) for v in out.values())
    print(f"\n[ok] {OUT_FILE.name}  {len(out)} 只 / {total} 根 · "
          f"{OUT_FILE.stat().st_size/1024/1024:.2f} MB", flush=True)
    return 0 if len(out) == len(codes) else 1


if __name__ == "__main__":
    raise SystemExit(main())
