"""tooling/pixel_diff.py — honest pixel-diff measurement (no parity chase).

Loads reference + clone screenshots, center-crops to the common size,
reports mean absolute per-channel difference and share of pixels with
max-channel delta > 25. Prints dimensions + numbers only.
"""
import sys
from PIL import Image, ImageChops

ref_path = sys.argv[1] if len(sys.argv) > 1 else 'Screenshot from 2026-10-12 18-38-59.png'
shot_path = sys.argv[2] if len(sys.argv) > 2 else 'tooling/shots/final-1920.png'

ref = Image.open(ref_path).convert('RGB')
shot = Image.open(shot_path).convert('RGB')
print(f'ref: {ref.size} shot: {shot.size}')

w = min(ref.width, shot.width)
h = min(ref.height, shot.height)

def center_crop(im, w, h):
    x0 = (im.width - w) // 2
    y0 = (im.height - h) // 2
    return im.crop((x0, y0, x0 + w, y0 + h))

ref_c = center_crop(ref, w, h)
shot_c = center_crop(shot, w, h)

diff = ImageChops.difference(ref_c, shot_c)
hist = diff.histogram()  # 256 bins per channel concatenated
total = w * h
mad = sum(i * c for ch in range(3) for i, c in enumerate(hist[ch * 256:(ch + 1) * 256])) / (total * 3)

# share of pixels whose max-channel delta exceeds 25
import math
px = diff.load()
n_big = 0
step = max(1, total // 200000)  # sample for speed on 2MP images
# iterate rows with sampling
for y in range(0, h, step):
    for x in range(0, w, step):
        r, g, b = diff.getpixel((x, y))
        if max(r, g, b) > 25:
            n_big += 1
sampled = ((h + step - 1) // step) * ((w + step - 1) // step)
print(f'common: {w}x{h} total={total}')
print(f'meanAbsChannelDiff(0-255): {mad:.2f}')
print(f'pixelsΔ>25 (sampled 1/{step}): {100.0 * n_big / sampled:.1f}% of sampled pixels')
print('method: PIL center-crop common area, ImageChops.difference; measurement only')
