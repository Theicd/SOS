from PIL import Image
import os
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\Avatar001\AppData\Roaming\Cursor\User\workspaceStorage\empty-window\images\14118d3f-2fc8-4ed1-b688-5806cf027bea-4a33547a-7d1a-48cd-a258-7958db2c36f3.png'
out_dir = r'c:\BRAIN\SOS-main\icons'
os.makedirs(out_dir, exist_ok=True)

img = Image.open(src_path).convert('RGBA')
pixels = img.load()
w, h = img.size
print('source', w, h, src_path)

out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
out_px = out.load()

minx, miny, maxx, maxy = w, h, 0, 0
kept = 0
for y in range(h):
    for x in range(w):
        r, g, b, a = pixels[x, y]
        mx = max(r, g, b)
        luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
        # רקע שחור → שקוף; הילה כהה → אלפא רכה | HYPER CORE TECH
        if mx < 18 and luma < 16:
            continue
        if mx < 48:
            alpha = int(max(0, min(255, (mx - 18) * (255 / 30))))
            if alpha < 8:
                continue
            out_px[x, y] = (r, g, b, alpha)
        else:
            out_px[x, y] = (r, g, b, 255)
        kept += 1
        if x < minx:
            minx = x
        if y < miny:
            miny = y
        if x > maxx:
            maxx = x
        if y > maxy:
            maxy = y

print('kept', kept, 'bbox', minx, miny, maxx, maxy)
pad = 20
minx = max(0, minx - pad)
miny = max(0, miny - pad)
maxx = min(w - 1, maxx + pad)
maxy = min(h - 1, maxy + pad)
cropped = out.crop((minx, miny, maxx + 1, maxy + 1))
cw, ch = cropped.size
side = max(cw, ch)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(cropped, ((side - cw) // 2, (side - ch) // 2), cropped)

master = square.resize((512, 512), Image.Resampling.LANCZOS)
master.save(os.path.join(out_dir, 'WAPICON.png'), 'PNG', optimize=True)
master.save(os.path.join(out_dir, 'sos-app-icon-512.png'), 'PNG', optimize=True)

for size, name in [
    (192, 'sos-app-icon-192.png'),
    (180, 'sos-app-icon-180.png'),
    (96, 'sos-app-icon-96.png'),
    (64, 'sos-app-icon-64.png'),
    (32, 'favicon-32.png'),
]:
    im = square.resize((size, size), Image.Resampling.LANCZOS)
    im.save(os.path.join(out_dir, name), 'PNG', optimize=True)
    print('wrote', name, size)

sample = Image.open(os.path.join(out_dir, 'WAPICON.png'))
print('corner', sample.getpixel((0, 0)), 'center', sample.getpixel((256, 256)))
px = list(sample.getdata())
print('transparent%', round(100 * sum(1 for p in px if p[3] == 0) / len(px), 1))
