"""Generate format SVGs from templates, or ICOs from existing SVGs.

Usage:
    python generate_formats.py svg
    python generate_formats.py ico

svg overwrites ../formats/svg from the gray templates.
ico reads those SVGs as they are (keeps hand-picked colors) and writes:
    ../formats/<format>.ico
    ../../src/assets/icons/<format>.png
"""

import io
import pathlib
import re
import sys

import cairosvg
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
FORMATS_DIR = SCRIPT_DIR.parent / "formats"
SVG_DIR = FORMATS_DIR / "svg"
ASSETS_ICONS_DIR = SCRIPT_DIR.parent.parent / "src" / "assets" / "icons"
FONT_PATH = SCRIPT_DIR / "Quicksand" / "Quicksand-Bold.ttf"

FONT_SRC_TEMPLATE = "url('./Quicksand/Quicksand-Bold.ttf')"
FONT_SRC_OUTPUT = "url('../../format-template/Quicksand/Quicksand-Bold.ttf')"

VB_X, VB_Y, VB_W = 14, 68, 394
RENDER_SIZE = 1024
ICO_SIZES = [256, 128, 64, 48, 32, 16]
SIGN_X, SIGN_Y, SIGN_W, SIGN_H = 30, 260, 220, 110

TEXT_RE = re.compile(
    r'<text x="110" y="[^"]+" class="format-text" fill="#fff" font-size="(\d+)px">([^<]+)</text>'
)

GROUPS = {
    "template_mascot.svg": ["jpg", "png", "jpeg", "bmp", "ico"],
    "template_moe-1.svg": ["gif", "webp", "apng", "svg", "avif"],
    "template_stoic.svg": ["zip", "rar", "7z", "tar"],
    "template_moe-3.svg": ["cbt", "cbz", "cbr", "cb7"],
}


def font_size_for(label: str) -> int:
    n = len(label)
    if n <= 2:
        return 80
    if n <= 3:
        return 72
    return 58


def generate_svgs():
    SVG_DIR.mkdir(parents=True, exist_ok=True)

    for template_name, formats in GROUPS.items():
        template_svg = (SCRIPT_DIR / template_name).read_text(encoding="utf-8")

        for fmt in formats:
            label = fmt.upper()
            fs = font_size_for(label)
            svg = template_svg.replace(FONT_SRC_TEMPLATE, FONT_SRC_OUTPUT)
            svg, n = TEXT_RE.subn(
                f'<text x="110" y="55" class="format-text" fill="#fff" font-size="{fs}px">{label}</text>',
                svg,
                count=1,
            )
            if n != 1:
                raise SystemExit(f"{template_name}: expected 1 format-text node, found {n}")

            out = SVG_DIR / f"{fmt}.svg"
            out.write_text(svg, encoding="utf-8")
            print(f"  {fmt:>4}  {label}  {fs}px -> {out.name}")

        print(f"[{template_name}] complete\n")


def all_formats():
    formats = []
    for names in GROUPS.values():
        formats.extend(names)
    return formats


def render_icon(fmt: str) -> Image.Image:
    path = SVG_DIR / f"{fmt}.svg"
    svg = path.read_text(encoding="utf-8")
    match = TEXT_RE.search(svg)
    if not match:
        raise SystemExit(f"{fmt}.svg: missing format-text")
    fs_svg = int(match.group(1))
    label = match.group(2)
    svg_no_text = TEXT_RE.sub("", svg)
    png_bytes = cairosvg.svg2png(
        bytestring=svg_no_text.encode("utf-8"),
        output_width=RENDER_SIZE,
        output_height=RENDER_SIZE,
        url=str(path),
    )
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    scale = RENDER_SIZE / VB_W
    sign_cx = (SIGN_X - VB_X + SIGN_W / 2) * scale
    sign_cy = (SIGN_Y - VB_Y + SIGN_H / 2) * scale
    font = ImageFont.truetype(str(FONT_PATH), int(fs_svg * scale))
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = sign_cx - tw / 2 - bbox[0]
    ty = sign_cy - th / 2 - bbox[1]
    draw.text((tx, ty), label, fill=(255, 255, 255, 255), font=font)
    return img


def generate_icos():
    FORMATS_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_ICONS_DIR.mkdir(parents=True, exist_ok=True)

    for fmt in all_formats():
        img = render_icon(fmt)
        ui = img.resize((128, 128), Image.LANCZOS)
        ui_path = ASSETS_ICONS_DIR / f"{fmt}.png"
        ui.save(str(ui_path), format="PNG", optimize=True)

        frames = [img.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
        ico_path = FORMATS_DIR / f"{fmt}.ico"
        frames[0].save(
            str(ico_path),
            format="ICO",
            sizes=[(s, s) for s in ICO_SIZES],
            append_images=frames[1:],
        )
        print(f"  {fmt:>4}  -> {ico_path.name}, {ui_path.name}")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("svg", "ico"):
        raise SystemExit("usage: python generate_formats.py svg|ico")
    if sys.argv[1] == "svg":
        generate_svgs()
    else:
        generate_icos()

