#!/usr/bin/env python3
"""
Generates the app's PNG icons with no external dependencies (stdlib zlib/struct
only) since PIL isn't available in this environment. Draws a small stylized
"neural node" glyph — a center node with satellite nodes connected by lines —
on a rounded dark background, matching the app's color scheme.

Run: python3 scripts/gen_icons.py
"""
import os
import struct
import zlib

BG = (11, 12, 16)  # #0b0c10
NODE_A = (125, 211, 252)  # accent (#7dd3fc)
NODE_B = (196, 181, 253)  # accent2 (#c4b5fd)
LINE = (90, 100, 120)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "icons")


def write_png(path, width, height, get_pixel):
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type: none
        for x in range(width):
            r, g, b, a = get_pixel(x, y)
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (
            struct.pack("!I", len(data))
            + tag
            + data
            + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)
    compressed = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def dist_to_segment(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    t = 0.0 if ab2 == 0 else max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
    cx, cy = ax + t * abx, ay + t * aby
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_icon(width, height, corner_radius_frac=0.22, padding_frac=0.0):
    cx0, cy0 = width / 2, height / 2
    r_outer = min(width, height) * 0.5 * (1 - padding_frac)
    corner_r = min(width, height) * corner_radius_frac

    # Node layout (fractions of size), center node + 5 satellites.
    center = (0.5, 0.46)
    satellites = [
        (0.5, 0.20),
        (0.76, 0.34),
        (0.78, 0.66),
        (0.5, 0.80),
        (0.22, 0.66),
        (0.24, 0.34),
    ]
    node_r = min(width, height) * 0.052
    center_r = min(width, height) * 0.072
    line_w = max(1.5, min(width, height) * 0.012)

    def in_rounded_rect(x, y):
        # squircle-ish rounded-rect mask so the glyph fills the whole icon
        # (iOS applies its own mask on top of this for home-screen icons).
        hw, hh = width / 2, height / 2
        dx, dy = abs(x - cx0) - (hw - corner_r), abs(y - cy0) - (hh - corner_r)
        if dx <= 0 or dy <= 0:
            return True
        return (dx * dx + dy * dy) <= corner_r * corner_r

    def get_pixel(x, y):
        px, py = x + 0.5, y + 0.5
        if not in_rounded_rect(px, py):
            return (0, 0, 0, 0)

        # subtle vertical gradient background
        t_bg = py / height
        bg = lerp((11, 12, 16), (18, 16, 28), t_bg)

        fx, fy = px / width, py / height

        # lines from center to each satellite
        best_line_d = 1e9
        for sx, sy in satellites:
            d = dist_to_segment(fx, fy, center[0], center[1], sx, sy)
            best_line_d = min(best_line_d, d)
        line_d_px = best_line_d * min(width, height)
        if line_d_px < line_w:
            a = max(0.0, 1 - line_d_px / line_w)
            col = lerp(bg, LINE, 0.9 * a)
            return (col[0], col[1], col[2], 255)

        # satellite nodes
        for i, (sx, sy) in enumerate(satellites):
            d_px = ((fx - sx) ** 2 + (fy - sy) ** 2) ** 0.5 * min(width, height)
            if d_px < node_r:
                edge = max(0.0, min(1.0, (node_r - d_px) / (node_r * 0.35)))
                col = lerp(NODE_B, NODE_A, i / max(1, len(satellites) - 1))
                col = lerp(bg, col, edge)
                return (col[0], col[1], col[2], 255)

        # center node (brighter, larger)
        d_px = ((fx - center[0]) ** 2 + (fy - center[1]) ** 2) ** 0.5 * min(width, height)
        if d_px < center_r:
            edge = max(0.0, min(1.0, (center_r - d_px) / (center_r * 0.35)))
            col = lerp(bg, (226, 240, 253), edge)
            return (col[0], col[1], col[2], 255)

        return (bg[0], bg[1], bg[2], 255)

    return get_pixel


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        ("icon-192.png", 192, 192, 0.22),
        ("icon-512.png", 512, 512, 0.22),
        ("apple-touch-icon.png", 180, 180, 0.0),  # iOS masks its own rounding
        ("maskable-512.png", 512, 512, 0.0, 0.1),  # safe-zone padding for maskable
        ("favicon-32.png", 32, 32, 0.22),
        ("favicon-16.png", 16, 16, 0.22),
    ]
    for name, w, h, *rest in targets:
        corner = rest[0] if len(rest) > 0 else 0.22
        pad = rest[1] if len(rest) > 1 else 0.0
        get_pixel = make_icon(w, h, corner_radius_frac=corner, padding_frac=pad)
        path = os.path.join(OUT_DIR, name)
        write_png(path, w, h, get_pixel)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
