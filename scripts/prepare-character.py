#!/usr/bin/env python3
"""Turn a flat character drawing into the sprite the app ships.

The source art arrives as a JPG with a baked-in checkerboard background (no
alpha) and, in the original Mizuhara art, a speech bubble that touches the hair.
Naive keying fails on all three counts, so the pipeline is:

  1. Outer background — near-greyscale, bright pixels connected to the border.
  2. Trapped checkerboard — greyscale regions enclosed by the drawing. Colour
     alone cannot separate them from the light sweater or the white collar, so
     they are matched on the *pattern*: the background is a regular ~20px
     checker, and a trapped square keeps that phase. Uniform skin matches only
     ~50 % by chance, which the threshold rejects.
  3. Speech bubble — the saturated blue blob grown by the outline's thickness.
     Its outline merges with the hair outline into one dark component, so
     components cannot split them; a bounded dilation stops at the hair edge.
  4. Erode 1px, soften the alpha, trim, downscale.

Needs numpy, Pillow and scipy (not project dependencies — this runs by hand):

    python scripts/prepare-character.py <source.jpg> [out-dir]

`out-dir` defaults to src/assets/character and must contain the result as
mizuhara.png. Previews are written beside it for a visual sanity check.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

MAX_DIM = 512

BG_FLAT = 16       # channel spread still counted as greyscale
BG_MIN = 168       # and how bright it has to be
LOOSE_FLAT = 35    # looser test used only to *find* candidate trapped regions
LOOSE_MIN = 150
CHECK_FIT = 0.72   # share of a region's pixels that must match the checker phase
BUBBLE_GROW = 10   # how far the bubble's outline reaches past the blue


def fit_checker(
    xs: np.ndarray, ys: np.ndarray, bright: np.ndarray, background: np.ndarray,
) -> tuple[float, int]:
    """Recover the background checker's cell size and parity.

    Scored on the outer background only, where the pattern is intact.
    """
    best = (20.5, 1)
    best_score = -1.0
    sample = background & (xs % 7 == 0) & (ys % 7 == 0)
    for cell in np.arange(19.0, 22.01, 0.02):
        px = np.floor(xs[sample] / cell).astype(np.int32)
        py = np.floor(ys[sample] / cell).astype(np.int32)
        white = bright[sample] >= 238
        for parity in (0, 1):
            agree = float(np.mean((((px + py) % 2) == parity) == white))
            if agree > best_score:
                best_score = agree
                best = (float(cell), parity)
    return best


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "src/assets/character"

    im = Image.open(src).convert("RGB")
    rgb = np.asarray(im).astype(np.int16)
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    bright = rgb.min(axis=2)

    # 1. Outer background.
    bgish = (spread <= BG_FLAT) & (bright >= BG_MIN)
    labels, _ = ndimage.label(bgish)
    border = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    border.discard(0)
    background = np.isin(labels, list(border))

    # 2. Checkerboard trapped inside the silhouette.
    h, w = bright.shape
    ys, xs = np.mgrid[0:h, 0:w]
    cell, parity = fit_checker(xs, ys, bright, background)
    pred_white = ((np.floor(xs / cell) + np.floor(ys / cell)).astype(np.int32) % 2) == parity
    fits = np.where(pred_white, bright >= 238, (bright >= 180) & (bright <= 220))

    cand = (spread <= LOOSE_FLAT) & (bright >= LOOSE_MIN) & ~background
    trapped = np.zeros_like(background)
    cl, cn = ndimage.label(cand)
    for i in range(1, cn + 1):
        mask = cl == i
        if fits[mask].mean() > CHECK_FIT:
            trapped |= mask
    print(f"checker: cell={cell:.2f} parity={parity} -> trapped {int(trapped.sum())} px")

    # 3. Speech bubble.
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    blue = (b > 150) & (b - r > 45) & (b - g > 25)
    bubble = np.zeros_like(blue)
    if blue.any():
        bubble = ndimage.binary_dilation(blue, iterations=BUBBLE_GROW)

    foreground = ~(background | trapped | bubble)

    flabels, fn = ndimage.label(foreground)
    if fn > 1:
        sizes = ndimage.sum(np.ones_like(flabels), flabels, index=range(1, fn + 1))
        foreground = flabels == (int(np.argmax(sizes)) + 1)

    # 4. Alpha.
    eroded = ndimage.binary_erosion(foreground, iterations=1)
    alpha = ndimage.gaussian_filter(eroded.astype(np.float32) * 255.0, sigma=0.6)
    alpha = np.clip(alpha, 0, 255).astype(np.uint8)

    sprite = Image.fromarray(np.dstack([np.asarray(im), alpha]), "RGBA")
    bbox = sprite.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    sprite = sprite.crop(bbox)
    print(f"trimmed {im.size} -> {sprite.size} (bbox {bbox})")

    if max(sprite.size) > MAX_DIM:
        k = MAX_DIM / max(sprite.size)
        sprite = sprite.resize(
            (max(1, round(sprite.width * k)), max(1, round(sprite.height * k))),
            Image.LANCZOS,
        )
        print(f"resized -> {sprite.size}")

    out_dir.mkdir(parents=True, exist_ok=True)
    sprite.save(out_dir / "mizuhara.png")
    print("wrote", out_dir / "mizuhara.png")

    for name, bg in (("preview-dark.png", (20, 21, 24)), ("preview-light.png", (235, 235, 238))):
        pad = 30
        prev = Image.new("RGB", (sprite.width + pad * 2, sprite.height + pad * 2), bg)
        prev.paste(sprite, (pad, pad), sprite)
        prev.save(out_dir / name)

    pad = 40
    prev = Image.new("RGB", (sprite.width + pad * 2, sprite.height + pad * 2), (128, 130, 136))
    prev.paste(sprite, (pad, pad), sprite)
    d = ImageDraw.Draw(prev)
    for i in range(1, 10):
        fx = pad + sprite.width * i / 10
        fy = pad + sprite.height * i / 10
        d.line([(fx, 0), (fx, prev.height)], fill=(90, 200, 255), width=1)
        d.line([(0, fy), (prev.width, fy)], fill=(90, 200, 255), width=1)
        d.text((fx + 2, 2), str(i), fill=(255, 240, 120))
        d.text((2, fy + 2), str(i), fill=(255, 240, 120))
    prev.save(out_dir / "preview-grid.png")
    print("previews written beside", out_dir / "mizuhara.png")


if __name__ == "__main__":
    main()
