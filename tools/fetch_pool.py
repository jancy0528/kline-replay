#!/usr/bin/env python3
"""把 select_stocks.py 选出的实训标的补齐成训练数据。

产出三份缓存（都在 src/data/raw/，不进公开仓）：
  daily.json        18 只 × 2015 年起完整前复权日线（BaoStock，逐只重连）
  minutes.json      18 只 × 1023 根 5 分钟线（新浪）
  fundamentals.json 流通股本 / 总股本 / PE 等静态快照（腾讯 qt）

同时把日线写成 src/data/bars.ts，供 build_sessions.py 读取。

为什么 BaoStock 要逐只重连：本机实测同一连接连续查询会挂死（第一只 0.8s，
之后劣化到 >20s 且不再恢复）；每次 login→query→logout 稳定在 1.5~6s。

用法：
    .venv/Scripts/python.exe tools/fetch_pool.py
    .venv/Scripts/python.exe tools/fetch_pool.py --daily-only
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'src' / 'data' / 'raw'
DAILY_CACHE = RAW / 'daily.json'
MINUTE_CACHE = RAW / 'minutes.json'
FUND_CACHE = RAW / 'fundamentals.json'
PICKED = RAW / 'picked.json'
DAILY_TS = ROOT / 'src' / 'data' / 'bars.ts'
SNAPSHOT = RAW / 'snapshot.json'

SINA = ('https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20t=/'
        'CN_MarketDataService.getKLineData?symbol={sym}&scale=5&ma=no&datalen=1023')
QT = 'https://qt.gtimg.cn/q={codes}'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Referer': 'https://gu.qq.com/',
}
BAO_FIELDS = 'date,open,high,low,close,volume,amount,tradestatus,isST'
START, END = '2015-01-01', '2026-11-11'


def http_get(url: str, timeout: int = 20, retries: int = 5) -> str:
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('gbk', 'ignore')
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.4 * (i + 1))
    raise RuntimeError(f'GET failed {url[:100]}: {last}')


# ---- 日线 -----------------------------------------------------------------
def fetch_daily(code: str) -> tuple[str, list[list]]:
    import baostock as bs
    for attempt in range(3):
        try:
            lg = bs.login()
            if lg.error_code != '0':
                raise RuntimeError(lg.error_msg)
            rs = bs.query_history_k_data_plus(
                code, BAO_FIELDS, start_date=START, end_date=END,
                frequency='d', adjustflag='2',
            )
            rows: list[list] = []
            while rs.next():
                r = rs.get_row_data()
                # 字段顺序 date,open,high,low,close,volume,amount,tradestatus,isST
                # r[7] 才是 tradestatus（1=正常交易），r[6] 是成交额，别用错
                if r[7] == '1' and float(r[5]) > 0:   # 剔除停牌日
                    rows.append([r[0], round(float(r[1]), 3), round(float(r[2]), 3),
                                 round(float(r[3]), 3), round(float(r[4]), 3),
                                 int(float(r[5]))])
            bs.logout()
            return code, rows
        except Exception:  # noqa: BLE001
            try:
                bs.logout()
            except Exception:  # noqa: BLE001
                pass
            time.sleep(1 + attempt)
    raise RuntimeError(f'{code} 日线三次重试仍失败')


def build_daily(codes: list[str], force: bool) -> dict[str, list[list]]:
    cache = json.loads(DAILY_CACHE.read_text(encoding='utf-8')) if DAILY_CACHE.exists() else {}
    todo = [c for c in codes if force or not cache.get(c)]
    print(f'[daily] 缓存 {len(cache)} 只，需拉 {len(todo)} 只', flush=True)
    for i, code in enumerate(todo, 1):
        c, rows = fetch_daily(code)
        if len(rows) < 500:
            print(f'  ! {c} 只有 {len(rows)} 根，跳过', flush=True)
            continue
        cache[c] = rows
        DAILY_CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8')
        print(f'  [{i}/{len(todo)}] {c} {len(rows)} 根 {rows[0][0]}~{rows[-1][0]}', flush=True)
    return {c: cache[c] for c in codes if c in cache}


def write_bars_ts(daily: dict[str, list[list]]) -> None:
    if not daily:
        raise SystemExit('日线为空，拒绝覆盖 bars.ts（避免把训练数据写坏）')
    body = json.dumps(daily, ensure_ascii=False, separators=(',', ':'))
    meta = {
        'source': 'baostock', 'adjust': 'pre', 'start': START, 'end': END,
        'symbols': len(daily), 'bars': sum(len(v) for v in daily.values()),
    }
    DAILY_TS.write_text(
        '// 由 tools/fetch_pool.py 生成：选股命中的实训标的，2015 起完整前复权日线\n'
        '// Bar = [date, open, high, low, close, volume]\n'
        'export type Bar = [string, number, number, number, number, number]\n\n'
        f'export const META = {json.dumps(meta, ensure_ascii=False)} as const\n\n'
        f'export const BARS: Record<string, Bar[]> = {body}\n',
        encoding='utf-8',
    )
    print(f'[daily] 写入 {DAILY_TS.name} · {len(daily)} 只 / '
          f'{sum(len(v) for v in daily.values())} 根', flush=True)


# ---- 5 分钟线 -------------------------------------------------------------
def sina_symbol(code: str) -> str:
    return code.replace('.', '')


def fetch_minutes(code: str) -> tuple[str, list[list]]:
    text = http_get(SINA.format(sym=sina_symbol(code)))
    start, end = text.find('(['), text.rfind('])')
    if start < 0 or end < 0:
        raise RuntimeError(f'{code} 新浪返回不是预期的 JSONP 数组')
    arr = json.loads(text[start + 1:end + 1])
    rows: list[list] = []
    for r in arr:
        try:
            o, h, low, c = (float(r['open']), float(r['high']),
                            float(r['low']), float(r['close']))
            volume = int(float(r['volume']))
            if min(o, h, low, c) <= 0 or volume <= 0:
                continue
            if h < max(o, c) or low > min(o, c):
                continue
            rows.append([str(r['day'])[:16], round(o, 3), round(h, 3),
                         round(low, 3), round(c, 3), volume])
        except (KeyError, ValueError, TypeError):
            continue
    if len(rows) < 100:
        raise RuntimeError(f'{code} 有效分钟 K 仅 {len(rows)} 根')
    rows.sort(key=lambda b: b[0])
    return code, rows


def build_minutes(codes: list[str], force: bool) -> dict[str, list[list]]:
    data = json.loads(MINUTE_CACHE.read_text(encoding='utf-8')) if MINUTE_CACHE.exists() else {}
    m5: dict = data.get('m5') or {}
    todo = [c for c in codes if force or not m5.get(c)]
    print(f'[minutes] 缓存 {len(m5)} 只，需拉 {len(todo)} 只', flush=True)
    ok, fail = 0, 0
    with futures.ThreadPoolExecutor(max_workers=4) as pool:
        tasks = {pool.submit(fetch_minutes, c): c for c in todo}
        for fut in futures.as_completed(tasks):
            code = tasks[fut]
            try:
                c, rows = fut.result()
                if len(rows) < 300:
                    raise RuntimeError(f'只有 {len(rows)} 根')
                m5[c] = rows
                ok += 1
                print(f'  + {c} {len(rows)} 根 {rows[0][0]} ~ {rows[-1][0]}', flush=True)
            except Exception as e:  # noqa: BLE001
                fail += 1
                print(f'  ! {code} {str(e)[:80]}', flush=True)
    MINUTE_CACHE.write_text(json.dumps({'m5': m5}, ensure_ascii=False), encoding='utf-8')
    print(f'[minutes] 成功 {ok} / 失败 {fail}，缓存共 {len(m5)} 只', flush=True)
    return {c: m5[c] for c in codes if c in m5}


# ---- 基本面快照 -----------------------------------------------------------
def build_fundamentals(codes: list[str], force: bool) -> dict[str, dict]:
    if FUND_CACHE.exists() and not force:
        cached = json.loads(FUND_CACHE.read_text(encoding='utf-8'))
        if all(c in cached for c in codes):
            print(f'[fund] 用缓存 {len(cached)} 只', flush=True)
            return cached
    out: dict[str, dict] = {}
    qts = [sina_symbol(c) for c in codes]
    text = http_get(QT.format(codes=','.join(qts)))
    snap = json.loads(SNAPSHOT.read_text(encoding='utf-8')) if SNAPSHOT.exists() else {}
    for chunk in text.split(';'):
        chunk = chunk.strip()
        if not chunk.startswith('v_'):
            continue
        import re
        m = re.match(r'v_(\w+)="(.*)"', chunk, re.S)
        if not m:
            continue
        qt, body = m.group(1), m.group(2)
        f = body.split('~')
        if len(f) < 50:
            continue
        code = f'{qt[:2]}.{qt[2:]}'

        def n(i: int) -> float:
            try:
                return float(f[i])
            except (ValueError, IndexError):
                return 0.0

        price = n(3)
        float_mv = n(44) * 1e8       # 亿元 → 元
        total_mv = n(45) * 1e8
        out[code] = {
            'name': f[1].strip(),
            'price': price,
            'floatShares': round(float_mv / price) if price > 0 else 0,
            'totalShares': round(total_mv / price) if price > 0 else 0,
            'floatMvYi': round(float_mv / 1e8, 2),
            'totalMvYi': round(total_mv / 1e8, 2),
            'pe': n(39),
            'turnPct': n(38),
            'amountWan': n(37),
        }
    # 补齐没返回的代码：退回全市场快照里的流通市值
    for c in codes:
        if c in out:
            continue
        q = snap.get(c, {})
        p = q.get('price', 0)
        out[c] = {
            'name': q.get('name', ''), 'price': p,
            'floatShares': round(q.get('floatMvYi', 0) * 1e8 / p) if p > 0 else 0,
            'totalShares': round(q.get('floatMvYi', 0) * 1e8 / p) if p > 0 else 0,
            'floatMvYi': q.get('floatMvYi', 0), 'totalMvYi': q.get('floatMvYi', 0),
            'pe': 0, 'turnPct': q.get('turnPct', 0), 'amountWan': q.get('amountWan', 0),
        }
    FUND_CACHE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'[fund] {len(out)} 只股本/市值快照', flush=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force-daily', action='store_true')
    ap.add_argument('--force-minutes', action='store_true')
    ap.add_argument('--force-fund', action='store_true')
    ap.add_argument('--daily-only', action='store_true')
    args = ap.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    codes = json.loads(PICKED.read_text(encoding='utf-8'))
    print(f'[pool] {len(codes)} 只实训标的', flush=True)
    t0 = time.time()
    daily = build_daily(codes, args.force_daily)
    write_bars_ts(daily)
    if not args.daily_only:
        build_minutes(codes, args.force_minutes)
        build_fundamentals(codes, args.force_fund)
    print(f'[ok] 耗时 {round(time.time() - t0, 1)}s', flush=True)


if __name__ == '__main__':
    main()
