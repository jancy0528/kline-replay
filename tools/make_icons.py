#!/usr/bin/env python3
"""用纯标准库生成 PWA 图标，避免为几张 PNG 引入图像依赖。

输出：public/icon-192.png、public/icon-512.png、public/apple-touch-icon.png
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

BG = (17, 21, 31, 255)
GRID = (38, 46, 66, 255)
UP = (240, 69, 75, 255)    # 涨：红
DOWN = (34, 176, 125, 255)  # 跌：绿

# [open, high, low, close]，0=底 1=顶
CANDLES = [
    (0.30, 0.70, 0.22, 0.60),
    (0.60, 0.78, 0.42, 0.46),
    (0.46, 0.88, 0.36, 0.76),
    (0.76, 0.94, 0.56, 0.62),
    (0.62, 0.86, 0.44, 0.72),
]


def canvas(size: int) -> list[list[tuple[int, int, int, int]]]:
    return [[BG for _ in range(size)] for _ in range(size)]


def rect(px, x0, y0, x1, y1, color) -> None:
    size = len(px)
    for y in range(max(0, int(y0)), min(size, int(y1))):
        row = px[y]
        for x in range(max(0, int(x0)), min(size, int(x1))):
            row[x] = color


def draw(size: int) -> list[list[tuple[int, int, int, int]]]:
    px = canvas(size)
    pad = size * 0.12
    top, bottom = pad, size - pad
    height = bottom - top

    # 三条水平参考线
    for ratio in (0.25, 0.5, 0.75):
        y = top + height * ratio
        rect(px, pad, y, size - pad, y + max(1, size / 256), GRID)

    step = (size - 2 * pad) / len(CANDLES)
    body_w = step * 0.52
    for i, (op, hi, lo, cl) in enumerate(CANDLES):
        cx = pad + step * (i + 0.5)
        color = UP if cl >= op else DOWN
        y_hi = top + height * (1 - hi)
        y_lo = top + height * (1 - lo)
        y_op = top + height * (1 - op)
        y_cl = top + height * (1 - cl)
        wick = max(1, size / 180)
        rect(px, cx - wick / 2, y_hi, cx + wick / 2, y_lo, color)
        rect(px, cx - body_w / 2, min(y_op, y_cl),
             cx + body_w / 2, max(y_op, y_cl) + max(1, size / 256), color)
    return px


def encode(px) -> bytes:
    size = len(px)
    raw = b"".join(
        b"\x00" + bytes(channel for pixel in row for channel in pixel) for row in px
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "public"
    out.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512),
                       ("apple-touch-icon.png", 180)):
        target = out / name
        target.write_bytes(encode(draw(size)))
        print(f"[ok] {target.name} {size}x{size} {target.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
