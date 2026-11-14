#!/usr/bin/env python3
"""从全 A 股筛出训练标的与「信号日」。

当前生效模式：`bottom3x`（底部三倍量，2026-11-14 用户指定）
    {底部三倍量 选股}
    三倍量:=V>=REF(V,1)*3;
    {底部：收盘价在60日最低价上方15%区间内，你可以自行修改60、0.15}
    底部:=C<=LLV(L,60)*1.15;
    {要求收阳线，过滤长上影诱多}
    阳线:=C>O;
    XG:三倍量 AND 底部 AND 阳线;
  日线字段（腾讯 fqkline）：[date, open, close, high, low, volume]

已停用但完整保留：`legacy`（三层规则，原文见对话 2026-11-13）
一、基础池过滤（最先执行）
  1 剔除 ST / *ST / 退市风险警示
  2 剔除当日连板个股
  3 流通市值沿用前期池子门槛
  4 单股一手成本 <= 6 万元（适配 20 万模拟仓）
  5 剔除无对应交易权限的科创板标的
二、量能筛选
  1 放量倍数 = 当日成交额 / 近 10 个正常交易日日均成交额 >= 2.5
     （分母剔除停牌日、不含当日；分子为当日单日成交额）
  2 近 10 日日均成交额满足池子最低门槛
三、核心技术条件（周线级别）
  周 K 收盘价计算 MA5/MA10/MA20，硬性要求 MA5 > MA10 > MA20，
  仅比较数值大小，不强制发散角度、允许小幅粘合。
  用 `python tools/select_stocks.py --mode legacy` 可重新启用（代码未删除）。

数据源：
  BaoStock query_all_stock  仅用于取一次「全市场代码 + 名称」清单（缓存）
  腾讯 qt.gtimg.cn          批量实时截面（名称/现价/成交额/流通市值/量比/涨停价）
  腾讯 fqkline              前复权日线，用于算放量倍数、连板、周线均线

为什么不用 BaoStock 逐只拉历史：本机实测连续查询会挂死（单只 4 秒后
连接劣化到 >20 秒且不再恢复），无法承受 4700 只；腾讯 HTTP 可并发。

两处「前期池子门槛」原文数值在历史对话与项目里都没有留存，按以下默认值
填入（集中放在顶部常量，拿到准确数值改一行即可重跑）：
  MIN_FLOAT_MV_YI   = 50 亿元
  MIN_AVG_AMOUNT_YI = 1 亿元

输出：src/data/raw/selection.json
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import datetime as dt
import json
import re
import time
import urllib.request
from pathlib import Path

# ---- 生效模式 ------------------------------------------------------------
# bottom3x = 底部三倍量（当前生效）；legacy = 三层规则（代码保留、默认停用）
MODE = 'bottom3x'
VALID_MODES = ('bottom3x', 'legacy')

# ---- 新公式参数：底部三倍量 -----------------------------------------------
VOLUME_MULTIPLE = 3.0        # 三倍量：V >= REF(V,1) * 3
BOTTOM_LOOKBACK = 60         # LLV(L,60)：含当日的 60 根日线最低价
BOTTOM_BUFFER = 0.15         # 底部区间：C <= LLV(L,60) * (1 + 0.15)

# ---- 旧模式参数（legacy 专用，保留以便随时切回）---------------------------
MIN_FLOAT_MV_YI = 50.0          # 流通市值下限（亿元）
MIN_AVG_AMOUNT_YI = 1.0         # 近 10 日日均成交额下限（亿元）
VOLUME_RATIO_MIN = 2.5          # 放量倍数下限
MAX_LOT_COST = 60_000.0         # 一手成本上限（元）
DAILY_BARS = 320                # 取多少根前复权日线（够算 20 周均线）
SIGNAL_SCAN_DAYS = 25           # 在最近多少个交易日里回扫信号日
QT_BATCH = 60                   # 腾讯批量截面每次查多少只
HTTP_WORKERS = 12               # 并发路数
DAILY_WORKERS = 12

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'src' / 'data' / 'raw'
UNIVERSE = RAW / 'universe.json'
SNAPSHOT = RAW / 'snapshot.json'
SELECTION = RAW / 'selection.json'
MINUTE_CACHE = RAW / 'minutes.json'

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Referer': 'https://gu.qq.com/',
}


def http_get(url: str, timeout: int = 15, retries: int = 3) -> str:
    last: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('gbk', 'ignore')
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.25 * (i + 1))
    raise RuntimeError(f'GET failed {url[:110]}: {last}')


def qt_code(bs_code: str) -> str:
    """sh.600000 -> sh600000"""
    return bs_code.replace('.', '')


def bs_code(qt: str) -> str:
    """sh600000 -> sh.600000"""
    return f'{qt[:2]}.{qt[2:]}'


def is_tradeable_stock(code: str) -> bool:
    """基础池 5：只看沪深主板 + 创业板，剔除科创板/北交所/指数/B 股。"""
    if not re.match(r'^(sh\.60[0-36]|sh\.605|sz\.00[0-3]|sz\.30[01])', code):
        return False
    if code.startswith(('sh.688', 'sh.689')):
        return False
    return True


# ---- 1. 全市场清单（BaoStock 只查一次，之后走缓存）------------------------
def build_universe(day: str, force: bool) -> list[list[str]]:
    if UNIVERSE.exists() and not force:
        return json.loads(UNIVERSE.read_text(encoding='utf-8'))
    import baostock as bs
    lg = bs.login()
    if lg.error_code != '0':
        raise RuntimeError(f'baostock login failed: {lg.error_msg}')
    rs = bs.query_all_stock(day=day)
    rows = []
    while rs.next():
        rows.append(rs.get_row_data())
    bs.logout()
    picked = [r for r in rows if is_tradeable_stock(r[0])]
    RAW.mkdir(parents=True, exist_ok=True)
    UNIVERSE.write_text(json.dumps(picked, ensure_ascii=False), encoding='utf-8')
    print(f'[universe] {len(rows)} 行 → 可交易个股 {len(picked)} 只', flush=True)
    return picked


# ---- 2. 腾讯批量截面 ------------------------------------------------------
def parse_snapshot(text: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for chunk in text.split(';'):
        chunk = chunk.strip()
        if not chunk.startswith('v_'):
            continue
        m = re.match(r'v_(\w+)="(.*)"', chunk, re.S)
        if not m:
            continue
        code, body = m.group(1), m.group(2)
        f = body.split('~')
        if len(f) < 50:
            continue

        def num(i: int) -> float:
            try:
                return float(f[i])
            except (ValueError, IndexError):
                return 0.0

        out[bs_code(code)] = {
            'name': f[1].strip(),
            'price': num(3),
            'changePct': num(32),
            'amountWan': num(37),       # 当日成交额，万元
            'turnPct': num(38),
            'floatMvYi': num(44),       # 流通市值，亿元
            'limitUp': num(47),
            'volumeRatio': num(49),
        }
    return out


def build_snapshot(universe: list[list[str]], force: bool) -> dict[str, dict]:
    if SNAPSHOT.exists() and not force:
        return json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    codes = [qt_code(r[0]) for r in universe]
    batches = [codes[i:i + QT_BATCH] for i in range(0, len(codes), QT_BATCH)]
    result: dict[str, dict] = {}
    done = 0
    with futures.ThreadPoolExecutor(max_workers=HTTP_WORKERS) as pool:
        tasks = {pool.submit(http_get, 'https://qt.gtimg.cn/q=' + ','.join(b)): b for b in batches}
        for fut in futures.as_completed(tasks):
            try:
                result.update(parse_snapshot(fut.result()))
            except Exception as e:  # noqa: BLE001
                print('[snapshot] batch failed:', str(e)[:100], flush=True)
            done += 1
            if done % 20 == 0:
                print(f'[snapshot] {done}/{len(batches)} batches, {len(result)} quotes', flush=True)
    SNAPSHOT.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    print(f'[snapshot] {len(result)} 只行情快照', flush=True)
    return result


def basic_filter_legacy(code: str, q: dict) -> tuple[bool, str]:
    """【已停用·代码保留】旧模式一、基础池过滤。返回 (是否通过, 淘汰原因)。"""
    name = q.get('name', '').upper()
    if 'ST' in name or '退' in name:
        return False, 'ST/退市'
    if q.get('floatMvYi', 0) < MIN_FLOAT_MV_YI:
        return False, '流通市值'
    if q.get('price', 0) * 100 > MAX_LOT_COST:
        return False, '一手成本'
    # 严格必要条件，零漏报：放量>=R 且 10日均额>=M ⇒ 当日额>=R*M
    if q.get('amountWan', 0) / 1e4 < VOLUME_RATIO_MIN * MIN_AVG_AMOUNT_YI:
        return False, '当日成交额不足'
    return True, ''


def basic_filter_bottom3x(code: str, q: dict) -> tuple[bool, str]:
    """新公式模式：不做任何选股过滤，只排除无法取数的无效快照。

    原公式里没有 ST / 市值 / 一手成本 / 连板 / 成交额门槛，忠实照抄即
    意味着这些条件全部不生效；仅保留「有名称、有价格、有当日成交」这类
    数据有效性检查，避免把退市无行情代码送进日线接口。
    """
    if not q.get('name'):
        return False, '无名称'
    if q.get('price', 0) <= 0 or q.get('amountWan', 0) <= 0:
        return False, '无有效行情'
    return True, ''


def basic_filter(code: str, q: dict, mode: str) -> tuple[bool, str]:
    if mode == 'legacy':
        return basic_filter_legacy(code, q)
    return basic_filter_bottom3x(code, q)


# ---- 3. 前复权日线 --------------------------------------------------------
def fetch_daily(code: str) -> list[list]:
    """腾讯前复权日线 [date, open, close, high, low, volume]。"""
    url = ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
           f'?param={qt_code(code)},day,,,{DAILY_BARS},qfq')
    text = http_get(url)
    data = json.loads(text).get('data', {}).get(qt_code(code), {})
    rows = data.get('qfqday') or data.get('day') or []
    out = []
    for r in rows:
        try:
            out.append([r[0], float(r[1]), float(r[2]), float(r[3]),
                        float(r[4]), float(r[5])])
        except (ValueError, IndexError):
            continue
    return out


def week_key(date: str) -> tuple[int, int]:
    d = dt.date.fromisoformat(date)
    y, w, _ = d.isocalendar()
    return (y, w)


def weekly_closes(daily: list[list], upto: int) -> list[float]:
    """把截至 upto 的日线按 ISO 周聚合，返回每周最后一根的收盘价。"""
    groups: dict[tuple[int, int], float] = {}
    for i in range(upto + 1):
        r = daily[i]
        if r[5] <= 0:              # 停牌日
            continue
        groups[week_key(r[0])] = r[2]
    return [groups[k] for k in sorted(groups)]


def ma(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def limit_threshold(code: str) -> float:
    """创业板/科创 20cm，其余 10cm。用 0.198/0.098 容复权与四舍五入误差。"""
    return 0.198 if code.startswith('sz.30') else 0.098


def daily_amount(daily: list[list], i: int) -> float:
    """相对成交额：量 × 收盘价。比值口径下量纲自动约掉。"""
    r = daily[i]
    return r[5] * r[2]


def signal_at_legacy(code: str, daily: list[list], i: int, scale: float) -> dict | None:
    """【已停用·代码保留】旧模式：近 10 日均额放量 + 连板剔除 + 周线多头排列。"""
    if i < 11 or daily[i][5] <= 0:
        return None
    # 近 10 个正常成交交易日，不含当日；停牌日（量 0）不计入
    prev: list[float] = []
    j = i - 1
    while j >= 0 and len(prev) < 10:
        if daily[j][5] > 0:
            prev.append(daily_amount(daily, j))
        j -= 1
    if len(prev) < 10:
        return None
    avg = sum(prev) / 10
    if avg <= 0:
        return None
    ratio = daily_amount(daily, i) / avg
    if ratio < VOLUME_RATIO_MIN:
        return None
    avg_yi = avg * scale
    if avg_yi < MIN_AVG_AMOUNT_YI:
        return None
    # 连板：当日与前一交易日都涨停 → 剔除
    th = limit_threshold(code)
    pct_i = daily[i][2] / daily[i - 1][2] - 1 if i > 0 else 0
    pct_prev = daily[i - 1][2] / daily[i - 2][2] - 1 if i > 1 else 0
    if pct_i >= th and pct_prev >= th:
        return None
    # 周线 MA5 > MA10 > MA20（周收盘价）
    wc = weekly_closes(daily, i)
    m5, m10, m20 = ma(wc, 5), ma(wc, 10), ma(wc, 20)
    if m5 is None or m10 is None or m20 is None or not (m5 > m10 > m20):
        return None
    return {
        'date': daily[i][0],
        'mode': 'legacy',
        'volumeRatio': round(ratio, 3),
        'avgAmountYi': round(avg_yi, 3),
        'amountYi': round(daily_amount(daily, i) * scale, 3),
        'weekMA': [round(m5, 3), round(m10, 3), round(m20, 3)],
        'changePct': round(pct_i * 100, 2),
    }


def signal_at_bottom3x(code: str, daily: list[list], i: int, scale: float) -> dict | None:
    """【当前生效】底部三倍量：三倍量 AND 底部 AND 阳线。

    日线为腾讯 fqkline 顺序 [date, open, close, high, low, volume]，
    因此 O=r[1] C=r[2] H=r[3] L=r[4] V=r[5]（与 BaoStock 的 bars.ts 顺序不同）。
    LLV(L,60) 按通达信口径含当日；「长上影」注释在原文里没有对应代码，
    按原公式只实现 C>O，不额外过滤影线。
    """
    if i < BOTTOM_LOOKBACK - 1 or i < 1:
        return None
    r, prev = daily[i], daily[i - 1]
    o, c, low, v = r[1], r[2], r[4], r[5]
    v_prev = prev[5]
    if v <= 0 or v_prev <= 0:
        return None
    # 1) 三倍量：V >= REF(V,1) * 3
    if v < v_prev * VOLUME_MULTIPLE:
        return None
    # 2) 底部：C <= LLV(L,60) * 1.15（LLV 含当日，共 60 根）
    lo = min(daily[j][4] for j in range(i - BOTTOM_LOOKBACK + 1, i + 1))
    if lo <= 0 or c > lo * (1 + BOTTOM_BUFFER):
        return None
    # 3) 阳线：C > O
    if not c > o:
        return None
    return {
        'date': r[0],
        'mode': 'bottom3x',
        'volumeRatio': round(v / v_prev, 3),   # 此处含义为「对昨日量的倍数」
        'prevVolume': v_prev,
        'volume': v,
        'llv60': round(lo, 3),
        'bottomCeil': round(lo * (1 + BOTTOM_BUFFER), 3),
        'close': c,
        'open': o,
        'changePct': round((c / prev[2] - 1) * 100, 2) if prev[2] > 0 else 0,
    }


def signal_at(code: str, daily: list[list], i: int, scale: float,
              mode: str = MODE) -> dict | None:
    if mode == 'legacy':
        return signal_at_legacy(code, daily, i, scale)
    return signal_at_bottom3x(code, daily, i, scale)


def evaluate(args: tuple[str, dict, str]) -> dict | None:
    code, q, mode = args
    try:
        daily = fetch_daily(code)
    except Exception as e:  # noqa: BLE001
        return {'code': code, 'error': str(e)[:80]}
    need = 110 if mode == 'legacy' else BOTTOM_LOOKBACK + SIGNAL_SCAN_DAYS
    if len(daily) < need:
        return None
    # 用「最后一根真实成交额 / 相对成交额」把比值口径换算成亿元（旧模式用）
    rel_last = daily_amount(daily, -1) if len(daily) else 0
    scale = (q['amountWan'] / 1e4) / rel_last if rel_last > 0 else 0
    signals = []
    lo = max(BOTTOM_LOOKBACK - 1, len(daily) - SIGNAL_SCAN_DAYS)
    for i in range(lo, len(daily)):
        s = signal_at(code, daily, i, scale, mode)
        if s:
            signals.append(s)
    if not signals:
        return None
    out = {
        'code': code,
        'name': q['name'],
        'price': q['price'],
        'floatMvYi': q['floatMvYi'],
        'lastAmountYi': round(q['amountWan'] / 1e4, 3),
        'signals': signals,
        'dailyLast': daily[-1][0],
    }
    if signals[-1].get('weekMA'):
        out['weekMA'] = signals[-1]['weekMA']
    return out


def pick_pool(symbols: list[dict], n: int) -> list[str]:
    """从命中里挑实训标的：排除 ST/退市 + 按代码板块轮转 + 同板块按信号新近/量比排序。

    selection.json 保留全部命中（忠实原公式），这里只决定「哪些标的进训练包」，
    因此排除 ST 属于训练可用性取舍，不是选股条件。
    """
    cand = [p for p in symbols
            if 'ST' not in p['name'].upper() and '退' not in p['name']]
    groups: dict[str, list[dict]] = {}
    for p in cand:
        groups.setdefault(p['code'].split('.')[1][:3], []).append(p)
    for v in groups.values():
        v.sort(key=lambda x: (x['signals'][-1]['date'],
                              x['signals'][-1]['volumeRatio']), reverse=True)
    out: list[str] = []
    keys = sorted(groups)
    while len(out) < n:
        added = False
        for k in keys:
            while groups[k]:
                p = groups[k].pop(0)
                if p['code'] not in out:
                    out.append(p['code'])
                    added = True
                    break
            if len(out) >= n:
                break
        if not added:
            break
    return out


def write_public_summary(out: dict) -> None:
    """把命中摘要写到 public/ 供线上直接查验（不参与应用逻辑）。"""
    path = ROOT / 'public' / 'selection.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    summary = {
        'mode': out['mode'],
        'generatedAt': out['generatedAt'],
        'rules': out['rules'],
        'note': out['note'],
        'disclaimer': '本清单仅用于 K 线回放训练的标的筛选，不构成任何投资建议或依据。',
        'scanned': out['scanned'],
        'symbols': len(out['symbols']),
        'signalDays': out['signalDays'],
        'hits': [
            {'code': p['code'], 'name': p['name'], 'floatMvYi': p['floatMvYi'],
             'signals': [{'date': s['date'], 'volumeRatio': s['volumeRatio'],
                          'llv60': s.get('llv60'), 'close': s.get('close')}
                         for s in p['signals']]}
            for p in out['symbols']
        ],
    }
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'[summary] 线上查验清单 → {path}', flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--day', default='2026-11-11', help='全市场清单基准交易日')
    ap.add_argument('--force-universe', action='store_true')
    ap.add_argument('--force-snapshot', action='store_true')
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 只，用于调试')
    ap.add_argument('--write-picked', type=int, default=0,
                    help='从命中里挑 N 只写入 src/data/raw/picked.json')
    ap.add_argument('--mode', default=MODE, choices=VALID_MODES,
                    help='bottom3x=底部三倍量（默认生效）；legacy=旧三层规则（保留但停用）')
    args = ap.parse_args()
    mode = args.mode
    print(f'[mode] {mode}'
          + ('  <-- 旧三层规则代码保留但本轮不生效' if mode == 'bottom3x' else ''), flush=True)

    t0 = time.time()
    universe = build_universe(args.day, args.force_universe)
    snapshot = build_snapshot(universe, args.force_snapshot)

    candidates: list[tuple[str, dict]] = []
    rejects: dict[str, int] = {}
    for code, q in snapshot.items():
        ok, why = basic_filter(code, q, mode)
        if ok:
            candidates.append((code, q))
        else:
            rejects[why] = rejects.get(why, 0) + 1
    if args.limit:
        candidates = candidates[:args.limit]
    print(f'[basic] 通过 {len(candidates)} 只；淘汰 {rejects}', flush=True)

    picked: list[dict] = []
    errors = 0
    tasks = [(c, q, mode) for c, q in candidates]
    with futures.ThreadPoolExecutor(max_workers=DAILY_WORKERS) as pool:
        for n, res in enumerate(pool.map(evaluate, tasks), 1):
            if res and 'error' in res:
                errors += 1
            elif res:
                picked.append(res)
            if n % 300 == 0:
                print(f'[scan] {n}/{len(candidates)}，命中 {len(picked)}，错误 {errors}', flush=True)

    # 按最近一次信号日、信号强度排序，越靠前越典型
    picked.sort(key=lambda x: (x['signals'][-1]['date'], x['signals'][-1]['volumeRatio']), reverse=True)
    if mode == 'bottom3x':
        rules = {
            'formula': '三倍量:=V>=REF(V,1)*3; 底部:=C<=LLV(L,60)*1.15; '
                       '阳线:=C>O; XG:三倍量 AND 底部 AND 阳线;',
            'volumeMultiple': VOLUME_MULTIPLE,
            'bottomLookback': BOTTOM_LOOKBACK,
            'bottomBuffer': BOTTOM_BUFFER,
            'llvIncludesToday': True,
            'volumeBasis': 'VOLUME（成交量，非成交额）',
            'upperShadowFilter': False,
            'basicPoolFilter': False,
            'signalScanDays': SIGNAL_SCAN_DAYS,
        }
        note = ('按截屏原公式逐行实现：LLV(L,60) 含当日；原文注释「过滤长上影诱多」'
                '在代码里只有 C>O、并未实现影线过滤，故不额外加条件；'
                '旧三层规则（ST/连板/市值/一手成本/科创板/近10日均额/周线MA）本模式全部不生效。'
                '信号日限制在分时数据可覆盖的近 25 个交易日内。')
    else:
        rules = {
            'minFloatMvYi': MIN_FLOAT_MV_YI,
            'minAvgAmountYi': MIN_AVG_AMOUNT_YI,
            'volumeRatioMin': VOLUME_RATIO_MIN,
            'maxLotCost': MAX_LOT_COST,
            'signalScanDays': SIGNAL_SCAN_DAYS,
            'weekMA': [5, 10, 20],
        }
        note = 'legacy 旧三层规则；两个池子门槛为可推翻的默认填值'
    out = {
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'mode': mode,
        'rules': rules,
        'note': note,
        'scanned': len(candidates),
        'errors': errors,
        'symbols': picked,
        'signalDays': sum(len(p['signals']) for p in picked),
    }
    SELECTION.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    write_public_summary(out)
    if args.write_picked:
        codes = pick_pool(picked, args.write_picked)
        picked_file = RAW / 'picked.json'
        picked_file.write_text(json.dumps(codes, ensure_ascii=False), encoding='utf-8')
        print(f'[picked] 实训标的 {len(codes)} 只 → {picked_file}', flush=True)
    print(f'\n[ok] {mode} 命中 {len(picked)} 只 / {out["signalDays"]} 个信号日，'
          f'耗时 {round(time.time() - t0, 1)}s → {SELECTION}', flush=True)
    for p in picked[:20]:
        print(f"  {p['code']} {p['name']:<8} 市值 {p['floatMvYi']:>8.1f}亿  "
              f"信号 {','.join(s['date'] for s in p['signals'][-3:])}  "
              f"量比 {p['signals'][-1]['volumeRatio']}x", flush=True)


if __name__ == '__main__':
    main()
