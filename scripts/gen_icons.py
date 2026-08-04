#!/usr/bin/env python3
"""生成 Tauri 所需的占位图标。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)


def make(size, path):
    img = Image.new("RGBA", (size, size), (47, 107, 255, 255))
    d = ImageDraw.Draw(img)
    # 画一个白色 "H" 字样
    f = max(8, size // 4)
    d.text((size // 2 - f // 2, size // 2 - f // 2), "H", fill=(255, 255, 255, 255))
    img.save(path)
    print("wrote", path)


make(32, os.path.join(OUT, "32x32.png"))
make(128, os.path.join(OUT, "128x128.png"))
make(256, os.path.join(OUT, "128x128@2x.png"))

# ico
ico = Image.new("RGBA", (256, 256), (47, 107, 255, 255))
ImageDraw.Draw(ico).text((64, 64), "H", fill=(255, 255, 255, 255))
ico.save(os.path.join(OUT, "icon.ico"), sizes=[(256, 256), (128, 128), (32, 32)])

# icns (用 png 序列伪装，Tauri 接受 png 重命名)
make(512, os.path.join(OUT, "icon.png"))
os.replace(os.path.join(OUT, "icon.png"), os.path.join(OUT, "icon.icns"))
