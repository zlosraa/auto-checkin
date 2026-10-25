#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 build/icon.ico（多尺寸，PNG 内嵌格式）。

纯标准库实现，不依赖 Pillow：
  python tools/make-icon.py
图案：蓝色渐变圆角方块 + 四个白色圆角小方块（与界面左上角品牌标一致）。
"""

import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "icon.ico")
SUPERSAMPLE = 768  # 必须能被所有 SIZES 整除，才能做整数倍面积降采样
SIZES = [16, 24, 32, 48, 64, 128, 256]

# 渐变色（起点 / 终点）
C1 = (47, 107, 255)
C2 = (124, 92, 255)


def rounded_rect_coverage(x, y, left, top, right, bottom, radius):
    """点 (x, y) 是否在圆角矩形内（1.0 / 0.0）。"""
    if not (left <= x <= right and top <= y <= bottom):
        return 0.0
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    dx = x - cx
    dy = y - cy
    return 1.0 if dx * dx + dy * dy <= radius * radius else 0.0


def render(size):
    """返回 RGBA bytes（size * size * 4）。"""
    buf = bytearray(size * size * 4)
    # 画布内边距：留一点边，让图标在任务栏里不顶格
    pad = size * 0.055
    left = top = pad
    right = bottom = size - pad
    radius = size * 0.22

    tile = size * 0.205          # 小方块边长
    gap = size * 0.055
    group = tile * 2 + gap
    ox = (size - group) / 2.0
    oy = (size - group) / 2.0
    tile_radius = tile * 0.24

    for y in range(size):
        for x in range(size):
            px = x + 0.5
            py = y + 0.5
            idx = (y * size + x) * 4

            if rounded_rect_coverage(px, py, left, top, right, bottom, radius) == 0.0:
                continue

            # 对角渐变
            t = (px / size + py / size) / 2.0
            r = int(C1[0] + (C2[0] - C1[0]) * t)
            g = int(C1[1] + (C2[1] - C1[1]) * t)
            b = int(C1[2] + (C2[2] - C1[2]) * t)

            # 四个小方块
            for row in range(2):
                for col in range(2):
                    tx = ox + col * (tile + gap)
                    ty = oy + row * (tile + gap)
                    if rounded_rect_coverage(px, py, tx, ty, tx + tile, ty + tile, tile_radius) > 0:
                        # 右下角那块用半透明白，做出层次
                        alpha = 200 if (row, col) == (1, 1) else 255
                        r = int(r + (255 - r) * (alpha / 255.0))
                        g = int(g + (255 - g) * (alpha / 255.0))
                        b = int(b + (255 - b) * (alpha / 255.0))

            buf[idx] = r
            buf[idx + 1] = g
            buf[idx + 2] = b
            buf[idx + 3] = 255
    return bytes(buf)


def downsample(src, src_size, dst_size):
    """按面积平均降采样，保证小尺寸边缘平滑。"""
    assert src_size % dst_size == 0
    factor = src_size // dst_size
    out = bytearray(dst_size * dst_size * 4)
    for y in range(dst_size):
        for x in range(dst_size):
            r = g = b = a = 0
            for dy in range(factor):
                base = ((y * factor + dy) * src_size + x * factor) * 4
                for dx in range(factor):
                    i = base + dx * 4
                    r += src[i]
                    g += src[i + 1]
                    b += src[i + 2]
                    a += src[i + 3]
            n = factor * factor
            o = (y * dst_size + x) * 4
            out[o] = r // n
            out[o + 1] = g // n
            out[o + 2] = b // n
            out[o + 3] = a // n
    return bytes(out)


def png_bytes(width, height, rgba):
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter: none
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def main():
    master = render(SUPERSAMPLE)
    images = []
    for size in SIZES:
        rgba = master if size == SUPERSAMPLE else downsample(master, SUPERSAMPLE, size)
        images.append((size, png_bytes(size, size, rgba)))

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries = b""
    datas = b""
    for size, data in images:
        entries += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        datas += data
        offset += len(data)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(header + entries + datas)
    print(f"已生成 {OUT}（{len(SIZES)} 个尺寸：{', '.join(str(s) for s in SIZES)}）")


if __name__ == "__main__":
    main()
