#!/usr/bin/env python3
"""把 BaoStock 的 A 股前复权日线导出成本项目用的静态 TS 数据模块。

用法：
    python tools/fetch_baostock.py \
        --codes sh.600000,sz.000001 \
        --start 2015-01-01 --end 2024-12-31 \
        --out src/data/bars.ts

依赖：pip install baostock   （匿名免注册，无需 token）

为什么生成 .ts 而不是 .json：数据会被打进构建产物，运行时不 fetch，
离线与子路径部署都不受 file/CORS/路径解析影响。
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

FIELDS = (
    "date,code,open,high,low,close,preclose,volume,amount,"
    "adjustflag,turn,tradestatus,pctChg,isST"
)
DEFAULT_CODES = "sh.600000,sz.000001,sz.000651,sh.601318,sh.600519"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="导出 A 股前复权日线为静态 TS 模块")
    parser.add_argument("--codes", default=DEFAULT_CODES, help="逗号分隔的 BaoStock 代码")
    parser.add_argument("--start", default="2015-01-01", help="起始日期 YYYY-MM-DD")
    parser.add_argument("--end", default="2024-12-31", help="结束日期 YYYY-MM-DD")
    parser.add_argument("--out", default="src/data/bars.ts", help="输出文件路径")
    parser.add_argument("--adjust", default="2", choices=["1", "2", "3"],
                        help="1 后复权 / 2 前复权 / 3 不复权")
    return parser.parse_args()


def fetch(bs, code: str, start: str, end: str, adjust: str) -> list[list]:
    rs = bs.query_history_k_data_plus(
        code, FIELDS, start_date=start, end_date=end,
        frequency="d", adjustflag=adjust,
    )
    if rs.error_code != "0":
        raise RuntimeError(f"{code}: {rs.error_code} {rs.error_msg}")

    bars: list[list] = []
    while rs.next():
        row = rs.get_row_data()
        # date,open,high,low,close,volume,tradestatus
        if row[11] != "1":  # 停牌日不参与回放
            continue
        try:
            bars.append([
                row[0],
                round(float(row[2]), 3), round(float(row[3]), 3),
                round(float(row[4]), 3), round(float(row[5]), 3),
                int(float(row[7] or 0)),
            ])
        except (ValueError, IndexError):
            continue
    return bars


def main() -> int:
    args = parse_args()
    try:
        import baostock as bs
    except ImportError:
        raise SystemExit("缺少依赖，请先执行: python -m pip install baostock")

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    login = bs.login()
    if login.error_code != "0":
        raise RuntimeError(f"BaoStock 登录失败: {login.error_msg}")

    try:
        data = {code: fetch(bs, code, args.start, args.end, args.adjust) for code in codes}
    finally:
        bs.logout()

    meta = {
        "source": "baostock",
        "adjust": {"1": "post", "2": "pre", "3": "none"}[args.adjust],
        "start": args.start,
        "end": args.end,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "symbols": len(data),
        "bars": sum(len(v) for v in data.values()),
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    body = (
        "// 由 tools/fetch_baostock.py 生成，请勿手工编辑\n"
        "// Bar = [date, open, high, low, close, volume]\n"
        "export type Bar = [string, number, number, number, number, number]\n\n"
        f"export const META = {json.dumps(meta, ensure_ascii=False)} as const\n\n"
        "export const BARS: Record<string, Bar[]> = "
        + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        + "\n"
    )
    out.write_text(body, encoding="utf-8")
    print(f"[ok] {out}  {meta['symbols']} 只 / {meta['bars']} 根 / {out.stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
