#!/usr/bin/env python3
"""產生 PWA 圖示（icons/*.png）。

用法：
  python3 tools/make_icons.py                  # 使用內建手繪鍋貼（暫代圖）
  python3 tools/make_icons.py --photo 鍋貼.jpg  # 使用真實鍋貼照片，加上發光效果

需求：Pillow（pip install pillow）
"""
import argparse, math, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
S = 1024  # 工作解析度，最後縮小
BG_IN, BG_OUT = (74, 49, 32), (36, 23, 18)   # wood-700 -> wood-900
GLOW = (255, 150, 60)


def background():
    img = Image.new('RGB', (S, S), BG_OUT)
    px = img.load()
    cx = cy = S / 2
    for y in range(S):
        for x in range(S):
            d = min(1.0, math.hypot(x - cx, y - cy) / (S * 0.72))
            px[x, y] = tuple(int(BG_IN[i] + (BG_OUT[i] - BG_IN[i]) * d) for i in range(3))
    return img


def glow_layer(mask, radius, strength):
    blur = mask.filter(ImageFilter.GaussianBlur(radius))
    blur = blur.point(lambda v: min(255, int(v * strength)))
    layer = Image.new('RGB', (S, S), GLOW)
    return layer, blur


def draw_gyoza(scale):
    """手繪鍋貼：金黃煎面 + 麵皮 + 摺痕。回傳 RGBA 與輪廓遮罩。"""
    W, H = int(S * 0.74 * scale), int(S * 0.42 * scale)
    g = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    cx, cy = S // 2, int(S * 0.52)
    box = (cx - W // 2, cy - H // 2, cx + W // 2, cy + H // 2)
    # 月牙輪廓：上半橢圓 + 較平的底
    body = Image.new('L', (S, S), 0)
    bd = ImageDraw.Draw(body)
    bd.pieslice((box[0], box[1], box[2], box[3] + H), 180, 360, fill=255)
    bd.rounded_rectangle((box[0], cy + H // 2 - int(H * .38), box[2], cy + H // 2), radius=int(H * .2), fill=255)
    # 麵皮底色（淡金）
    dough = Image.new('RGBA', (S, S), (250, 222, 160, 255))
    g.paste(dough, (0, 0), body)
    # 煎面（深金褐，靠底部）
    fry = Image.new('L', (S, S), 0)
    fd = ImageDraw.Draw(fry)
    fd.rounded_rectangle((box[0], cy + H // 2 - int(H * .46), box[2], cy + H // 2), radius=int(H * .2), fill=255)
    fry = ImageChops.multiply(fry, body).filter(ImageFilter.GaussianBlur(S * .012))
    g.paste(Image.new('RGBA', (S, S), (196, 112, 30, 255)), (0, 0), fry)
    # 摺痕
    n = 9
    for i in range(n):
        t = (i + .5) / n
        x = box[0] + W * (.12 + .76 * t)
        top = cy - H // 2 + (1 - math.sin(math.pi * (.12 + .76 * t))) * H * .0 + H * (.02 + .55 * abs(t - .5) ** 1.6 * 1.0)
        d.line((x, top + H * .06, x + W * .015, top + H * .30), fill=(214, 168, 96, 255), width=int(S * .011))
    # 高光
    hl = Image.new('L', (S, S), 0)
    ImageDraw.Draw(hl).ellipse((cx - W * .30, cy - H * .50, cx + W * .05, cy - H * .18), fill=120)
    hl = ImageChops.multiply(hl, body).filter(ImageFilter.GaussianBlur(S * .02))
    g.paste(Image.new('RGBA', (S, S), (255, 250, 230, 255)), (0, 0), hl)
    # 邊緣收尾
    g.putalpha(body.filter(ImageFilter.GaussianBlur(1.2)))
    return g, body


def compose(photo, safe):
    """safe=1.0 一般圖示；safe<1.0 為 maskable（內容縮進安全區）。"""
    img = background()
    if photo:
        size = int(S * 0.62 * safe)
        p = Image.open(photo).convert('RGB')
        m = min(p.size)
        p = p.crop(((p.width - m) // 2, (p.height - m) // 2, (p.width + m) // 2, (p.height + m) // 2)).resize((size, size), Image.LANCZOS)
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        full = Image.new('L', (S, S), 0)
        full.paste(mask, ((S - size) // 2, (S - size) // 2))
        layer, blur = glow_layer(full, S * .05, 2.2)
        img.paste(layer, (0, 0), blur)
        img.paste(p, ((S - size) // 2, (S - size) // 2), mask)
    else:
        g, body = draw_gyoza(safe)
        layer, blur = glow_layer(body, S * .06, 2.4)
        img.paste(layer, (0, 0), blur)
        layer2, blur2 = glow_layer(body, S * .018, 1.6)
        img.paste(layer2, (0, 0), blur2)
        img.paste(g, (0, 0), g)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--photo', help='真實鍋貼照片（jpg/png）')
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    std, mask = compose(a.photo, 1.0), compose(a.photo, 0.78)
    for name, im, size in [('icon-512.png', std, 512), ('icon-192.png', std, 192),
                           ('icon-maskable-512.png', mask, 512), ('apple-touch-icon.png', std, 180),
                           ('favicon-32.png', std, 32)]:
        im.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)
        print('wrote', name)


if __name__ == '__main__':
    main()
