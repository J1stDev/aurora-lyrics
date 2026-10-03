"""Helpers shared by the theme art generators (gen-neon.py, gen-rain.py): SVG data URIs, a small
PNG writer (standard library and numpy only, so no imaging package is needed) and a few colour tools.

The art is drawn once, here, with seeded random numbers, so every build is identical; the CSS
only moves it (transform and opacity)."""
import base64
import struct
import zlib
from urllib.parse import quote

import numpy as np


# ------------------------------------------------------------------------------------ SVG
def uri(svg_text):
    """An SVG document as a CSS url("data:...")."""
    svg_text = " ".join(svg_text.split())
    return 'url("data:image/svg+xml,' + quote(svg_text, safe=" =:/,.-;'()!*") + '")'


def svg(w, h, body, defs="", par="none"):
    d = f"<defs>{defs}</defs>" if defs else ""
    return uri(f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' preserveAspectRatio='{par}'>{d}{body}</svg>")


def n(v, digits=1):
    """A short number for path data."""
    s = f"{v:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def stops(spec):
    """[(offset, colour, opacity)] as gradient stops."""
    return "".join(f"<stop offset='{o}' stop-color='{c}'" + (f" stop-opacity='{a}'" if a != 1 else "") + "/>" for o, c, a in spec)


# ------------------------------------------------------------------------------------ PNG
def _chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def _paeth(a, b, c):
    p = a.astype(np.int16) + b - c
    pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
    return np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c)).astype(np.uint8)


def png_bytes(img):
    """uint8 array (h, w, 3) or (h, w, 4) -> PNG bytes. Each row picks the filter that leaves the
    smallest residue, which is what lets smooth, soft pictures shrink."""
    h, w, ch = img.shape
    ct = {3: 2, 4: 6}[ch]
    rows = img.reshape(h, w * ch)
    left = np.zeros_like(rows)
    left[:, ch:] = rows[:, :-ch]
    up = np.zeros_like(rows)
    up[1:] = rows[:-1]
    ul = np.zeros_like(rows)
    ul[1:, ch:] = rows[:-1, :-ch]
    cands = [
        rows,
        (rows - left).astype(np.uint8),
        (rows - up).astype(np.uint8),
        (rows - ((left.astype(np.uint16) + up) >> 1).astype(np.uint8)).astype(np.uint8),
        (rows - _paeth(left, up, ul)).astype(np.uint8),
    ]
    cost = np.stack([np.abs(c.astype(np.int8).astype(np.int16)).sum(axis=1) for c in cands])
    best = cost.argmin(axis=0)
    raw = bytearray()
    for y in range(h):
        raw.append(int(best[y]))
        raw += cands[best[y]][y].tobytes()
    ihdr = struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b"")


def png_uri(img):
    return 'url("data:image/png;base64,' + base64.b64encode(png_bytes(img)).decode() + '")'


# ------------------------------------------------------------------------------------ images (numpy)
def to_u8(img):
    return np.clip(img * 255 + 0.5, 0, 255).astype(np.uint8)


def blur_gauss(img, sigma):
    """Separable gaussian blur of (h, w, c) floats, edges clamped."""
    if sigma <= 0:
        return img
    r = int(sigma * 3 + 1)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = img
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out)
        for i, kv in enumerate(k):
            sl = [slice(None)] * out.ndim
            sl[axis] = slice(i, i + out.shape[axis])
            acc += kv * p[tuple(sl)]
        out = acc
    return out


def blur_disc(img, radius):
    """Blur with a flat disc (what an out-of-focus light looks like), by FFT; edges wrap, so pad the picture first."""
    if radius <= 0.5:
        return img
    h, w = img.shape[:2]
    r = int(np.ceil(radius)) + 1
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    d = np.sqrt(xx * xx + yy * yy)
    k = np.clip(radius + 0.5 - d, 0, 1)
    k = k * (0.8 + 0.2 * np.clip((d - radius * 0.6) / (radius * 0.4 + 1e-6), 0, 1))  # a slightly brighter rim
    k /= k.sum()
    H, W = h + 2 * r, w + 2 * r
    kern = np.zeros((H, W))
    kern[: 2 * r + 1, : 2 * r + 1] = k
    kern = np.roll(kern, (-r, -r), axis=(0, 1))
    fk = np.fft.rfft2(kern)
    out = np.empty_like(img)
    padded = np.pad(img, ((r, r), (r, r), (0, 0)), mode="edge")
    for c in range(img.shape[2]):
        out[..., c] = np.fft.irfft2(np.fft.rfft2(padded[..., c]) * fk, s=(H, W))[r : r + h, r : r + w]
    return out


def hex_rgb(s):
    s = s.lstrip("#")
    return tuple(int(s[i : i + 2], 16) for i in (0, 2, 4))
