#!/usr/bin/env python3
"""生成按周期切分的「训练片段包」，供 PWA 运行时按需 fetch。

与旧方案的区别：旧脚本把全历史塞进 TS 模块、静态打进 JS 主包（2.4MB）；
本脚本只保留每局真正需要的那一段 K 线，按周期打成独立 JSON，浏览器选到
哪个周期才加载哪个包。多个周期全上的总占用反而比过去一个周期更轻。

数据来源（全部离线，不依赖取数服务）：
  - src/data/bars.ts            已有的前复权日线（15 只 / 41994 根）
  - src/data/raw/minutes.json   可选，分钟线缓存，由 tools/fetch_minutes.py 生成
日线直接切片；周线、月线由日线在本地聚合（OHLC 取极值、成交量累加），
因此无需额外联网，且与日线前复权口径完全一致。

用法：
    .venv/Scripts/python.exe tools/build_segments.py
    .venv/Scripts/python.exe tools/build_segments.py --segments 200 --seed 7
输出：public/data/manifest.json + public/data/<period>-<hash>.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import OrderedDict
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "data"
DAILY_FILE = ROOT / "src" / "data" / "bars.ts"
MINUTE_FILE = ROOT / "src" / "data" / "raw" / "minutes.json"

# 周期顺序即界面上的切换顺序。窗口按周期调短，避免月线一次练完整只股票。
SPECS: dict[str, dict] = {
    "m5": dict(label="分时·5分", visible=60, max=80,
               note="以 5 分钟 K 线近似分时；公开数据源最细只到 5 分钟"),
    "m30": dict(label="30分钟", visible=60, max=80, note=""),
    "m60": dict(label="60分钟", visible=60, max=80, note=""),
    "day": dict(label="日线", visible=60, max=80, note=""),
    "week": dict(label="周线", visible=40, max=60, note=""),
    "month": dict(label="月线", visible=24, max=36, note=""),
}
MINUTE_KEYS = {"m5", "m30", "m60"}


def load_daily() -> dict[str, list[list]]:
    text = DAILY_FILE.read_text(encoding="utf-8")
    marker = "export const BARS: Record<string, Bar[]> = "
    if marker not in text:
        raise SystemExit(f"{DAILY_FILE} 格式不符，无法提取 BARS")
    return json.loads(text.split(marker, 1)[1].strip())


def load_minutes() -> dict[str, dict[str, list[list]]]:
    if not MINUTE_FILE.exists():
        return {}
    data = json.loads(MINUTE_FILE.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if k in MINUTE_KEYS and isinstance(v, dict)}


def aggregate(daily: list[list], freq: str) -> list[list]:
    """把日线聚合成周线或月线：开=首根开，高/低取极值，收=末根收，量累加。"""
    groups: OrderedDict[tuple, list] = OrderedDict()
    for bar in daily:
        d = date.fromisoformat(bar[0])
        key = (d.isocalendar()[0], d.isocalendar()[1]) if freq == "w" else (d.year, d.month)
        if key not in groups:
            groups[key] = list(bar)
        else:
            g = groups[key]
            g[2] = max(g[2], bar[2])
            g[3] = min(g[3], bar[3])
            g[4] = bar[4]
            g[5] += bar[5]
            g[0] = bar[0]
    return list(groups.values())


def cut_segments(code: str, bars: list[list], need: int, count: int, rng: random.Random):
    """把一只股票的历史切成最多 count 个在时间上分散的一局片段。"""
    m = len(bars) - need + 1
    if m <= 0:
        return []
    slots = min(count, m)
    step = m / slots
    out = []
    for i in range(slots):
        lo = int(i * step)
        hi = max(lo + 1, min(m, int((i + 1) * step)))
        start = rng.randint(lo, hi - 1)
        chunk = bars[start:start + need]
        out.append({"c": code, "s": chunk[0][0], "e": chunk[-1][0], "b": chunk})
    return out


def build_period(key: str, spec: dict, source: dict[str, list[list]],
                 total: int, rng: random.Random):
    need = spec["visible"] + spec["max"] + 1
    codes = list(source)
    rng.shuffle(codes)
    per_symbol = max(1, -(-total // max(1, len(codes))))
    segments: list[dict] = []
    for code in codes:
        if len(segments) >= total:
            break
        segments.extend(cut_segments(code, source[code], need, per_symbol, rng))
    rng.shuffle(segments)
    segments = segments[:total]
    if not segments:
        return None

    body = {
        "period": key,
        "label": spec["label"],
        "visible": spec["visible"],
        "max": spec["max"],
        "segments": segments,
    }
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:10]
    filename = f"{key}-{digest}.json"
    (OUT_DIR / filename).write_bytes(raw)
    return dict(
        key=key, label=spec["label"], file=filename,
        visible=spec["visible"], max=spec["max"],
        segments=len(segments), bytes=len(raw), note=spec["note"],
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="离线生成按周期切分的训练片段包")
    ap.add_argument("--segments", type=int, default=200, help="每个周期生成多少片段")
    ap.add_argument("--seed", type=int, default=20261112, help="随机种子，保证可复现")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    daily = load_daily()
    minutes = load_minutes()
    print(f"[source] 日线 {len(daily)} 只 / {sum(len(v) for v in daily.values())} 根")
    print(f"[source] 分钟缓存 {list(minutes) or '无'}")

    sources: dict[str, dict[str, list[list]] | None] = {
        "day": daily,
        "week": {c: aggregate(v, "w") for c, v in daily.items()},
        "month": {c: aggregate(v, "m") for c, v in daily.items()},
    }
    for key in MINUTE_KEYS:
        sources[key] = minutes.get(key) or None

    periods = []
    for key, spec in SPECS.items():
        source = sources.get(key)
        if not source:
            print(f"  {key:<6} {spec['label']:<9} 跳过（暂无数据）")
            # 仍在清单里保留定义，前端显示为「数据待补」，不假装已有
            periods.append(dict(key=key, label=spec["label"], file=None,
                                visible=spec["visible"], max=spec["max"],
                                segments=0, bytes=0, note=spec["note"]))
            continue
        built = build_period(key, spec, source, args.segments, rng)
        if built:
            periods.append(built)
            print(f"  {key:<6} {spec['label']:<9} {built['segments']:>3} 片段  "
                  f"{built['bytes']/1024:>7.1f} KB  {built['file']}")
        else:
            periods.append(dict(key=key, label=spec["label"], file=None,
                                visible=spec["visible"], max=spec["max"],
                                segments=0, bytes=0, note=spec["note"]))
            print(f"  {key:<6} {spec['label']:<9} 跳过（历史不足以切出片段）")

    manifest = {
        "version": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "baostock (local cache)",
        "adjust": "前复权",
        "periods": periods,
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    keep = {"manifest.json"} | {p["file"] for p in periods if p["file"]}
    for old in OUT_DIR.glob("*.json"):
        if old.name not in keep:
            old.unlink()

    total_kb = sum(p["bytes"] for p in periods) / 1024
    ready = sum(1 for p in periods if p["file"])
    print(f"\n[ok] manifest.json · {ready}/{len(periods)} 个周期可用 · 合计 {total_kb:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
