"""Batch-generate all format SVGs and multi-size ICOs for QuiviT.

Usage:
    python generate_formats.py

Outputs:
    ../formats/<format>.ico      (multi-size ICO: 256, 128, 64, 48, 32, 16px)
    ../formats/svg/<format>.svg  (vector master)
    ../formats/formats_preview.png (composite preview grid)
"""

import io
import re
import colorsys
import pathlib
import cairosvg
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR       = pathlib.Path(__file__).resolve().parent
FONT_PATH        = SCRIPT_DIR / "Nunito" / "Nunito-ExtraBold.ttf"
FORMATS_DIR      = SCRIPT_DIR.parent / "formats"
SVG_DIR          = FORMATS_DIR / "svg"
PREVIEW_PATH     = FORMATS_DIR / "formats_preview.png"
ASSETS_ICONS_DIR = SCRIPT_DIR.parent.parent / "src" / "assets" / "icons"

# SVG geometry & render settings
VB_X, VB_Y, VB_W, VB_H = 14, 68, 394, 394
RENDER_SIZE = 1024
ICO_SIZES   = [256, 128, 64, 48, 32, 16]

# Sign geometry in SVG units: translate(30, 260), rect 220x110
SIGN_X, SIGN_Y, SIGN_W, SIGN_H = 30, 260, 220, 110


def hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return f"#{int(rgb[0]):02X}{int(rgb[1]):02X}{int(rgb[2]):02X}"


def darken_color(hex_str: str, factor: float = 0.45) -> str:
    """Generate a darkened outline tone from the fill color."""
    r, g, b = [x / 255.0 for x in hex_to_rgb(hex_str)]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = max(0.12, l * factor)
    s = min(1.0, s * 1.15)
    r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
    return rgb_to_hex((r2 * 255, g2 * 255, b2 * 255))


# 18 Colors (Catppuccin Palette)
CATPPUCCIN_FILLS = {
    # Mascot template (Standard Raster)
    "jpg":  "#3B71CA",  # Royal Blue
    "png":  "#0891B2",  # Cyan / Ocean Teal
    "jpeg": "#4E6172",  # Steel Slate
    "bmp":  "#5C5F77",  # Slate
    "ico":  "#179299",  # Soft Teal

    # Moe-1 template (Modern / Animated)
    "gif":  "#D867AE",  # Magenta Pink
    "webp": "#7B629B",  # Muted Mauve
    "apng": "#DB5A80",  # Flamingo Pink
    "svg":  "#6377DB",  # Periwinkle Lavender
    "avif": "#209FB5",  # Sapphire Teal

    # Stoic template (Archives)
    "zip":  "#4B6188",  # Indigo / Slate Blue
    "rar":  "#6C3483",  # Deep Violet
    "7z":   "#0D9488",  # Forest Teal
    "tar":  "#DF8E1D",  # Warm Bronze Amber

    # Moe-3 template (Comic Archives)
    "cbt":  "#D97443",  # Warm Terracotta
    "cbz":  "#B8435C",  # Muted Berry Rose
    "cbr":  "#9E3856",  # Wine Maroon
    "cb7":  "#BA4522",  # Rust
}

# Individual vertical adjustments in SVG units (+down, -up)
Y_OFFSETS_SVG = {
    "apng": +6.0,
    "png":  +6.0,
    "rar":  +4.5,
    "svg":  +6.0,
    "zip":  +3.0,
    "avif": -2.0,
}

# Custom font sizes (SVG units)
CUSTOM_FONT_SIZES = {
    "avif": 66,
}

# Template mapping
GROUPS = {
    "template_mascot.svg": ["jpg", "png", "jpeg", "bmp", "ico"],
    "template_moe-1.svg":  ["gif", "webp", "apng", "svg", "avif"],
    "template_stoic.svg":  ["zip", "rar", "7z", "tar"],
    "template_moe-3.svg":  ["cbt", "cbz", "cbr", "cb7"],
}


def get_font_size_svg(label: str) -> int:
    if label in CUSTOM_FONT_SIZES:
        return CUSTOM_FONT_SIZES[label]
    if len(label) <= 2:
        return 80
    if len(label) <= 3:
        return 72
    return 58


def generate_icons():
    FORMATS_DIR.mkdir(parents=True, exist_ok=True)
    SVG_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_ICONS_DIR.mkdir(parents=True, exist_ok=True)

    scale = RENDER_SIZE / VB_W
    sign_cx = (SIGN_X - VB_X + SIGN_W / 2) * scale
    sign_cy = (SIGN_Y - VB_Y + SIGN_H / 2) * scale

    for template_name, formats in GROUPS.items():
        template_svg = (SCRIPT_DIR / template_name).read_text(encoding="utf-8")

        for fmt in formats:
            fill = CATPPUCCIN_FILLS[fmt]
            outline = darken_color(fill)
            fs = get_font_size_svg(fmt)
            y_offset = Y_OFFSETS_SVG.get(fmt, 0.0)
            svg_y_pos = 52 + y_offset

            # Populate template placeholders
            svg = template_svg
            svg = svg.replace("{COLOR}", fill)
            svg = svg.replace("{OUTLINE_COLOR}", outline)
            svg = svg.replace("{FONT_SIZE}", str(fs))
            svg = svg.replace("{FORMAT_TEXT}", fmt)
            svg = svg.replace('y="52"', f'y="{svg_y_pos:.1f}"')

            # Save SVG
            svg_file = SVG_DIR / f"{fmt}.svg"
            svg_file.write_text(svg, encoding="utf-8")

            # Strip <text> for exact Pillow text rendering with Nunito
            svg_no_text = re.sub(r"<text[^>]*>.*?</text>", "", svg, flags=re.DOTALL)
            png_bytes = cairosvg.svg2png(
                bytestring=svg_no_text.encode("utf-8"),
                output_width=RENDER_SIZE,
                output_height=RENDER_SIZE,
            )
            img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")

            # Draw Nunito ExtraBold text
            draw = ImageDraw.Draw(img)
            pil_font = ImageFont.truetype(str(FONT_PATH), int(fs * scale))
            bbox = draw.textbbox((0, 0), fmt, font=pil_font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            tx = sign_cx - tw / 2 - bbox[0]
            ty = sign_cy - th / 2 - bbox[1] + (y_offset * scale)
            draw.text((tx, ty), fmt, fill=(255, 255, 255, 255), font=pil_font)

            # Save UI raster PNG (128x128 for razor-sharp display at all UI DPIs)
            ui_png_file = ASSETS_ICONS_DIR / f"{fmt}.png"
            img_ui = img.resize((128, 128), Image.LANCZOS)
            img_ui.save(str(ui_png_file), format="PNG", optimize=True)

            # Lanczos downsample -> Multi-size ICO
            frames = [img.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
            ico_file = FORMATS_DIR / f"{fmt}.ico"
            frames[0].save(
                str(ico_file),
                format="ICO",
                sizes=[(s, s) for s in ICO_SIZES],
                append_images=frames[1:],
            )
            print(f"  {fmt:>4}  {fill} / {outline} -> {ico_file.name}, {ui_png_file.name}")

        print(f"[{template_name}] complete\n")


def generate_preview():
    thumb_size = 128
    pad = 16
    label_h = 24
    cols = 5

    group_defs = [
        ("Mascot (jpg, png, jpeg, bmp, ico)", ["jpg", "png", "jpeg", "bmp", "ico"]),
        ("Moe-1 (gif, webp, apng, svg, avif)", ["gif", "webp", "apng", "svg", "avif"]),
        ("Stoic (zip, rar, 7z, tar)", ["zip", "rar", "7z", "tar"]),
        ("Moe-3 (cbt, cbz, cbr, cb7)", ["cbt", "cbz", "cbr", "cb7"]),
    ]

    canvas_w = cols * (thumb_size + pad) + pad
    canvas_h = pad
    for _, fmts in group_defs:
        canvas_h += 30
        row_count = (len(fmts) + cols - 1) // cols
        canvas_h += row_count * (thumb_size + label_h + pad) + pad

    canvas = Image.new("RGBA", (canvas_w, canvas_h), (30, 30, 30, 255))
    draw = ImageDraw.Draw(canvas)

    y = pad
    for group_name, fmts in group_defs:
        draw.text((pad, y), group_name, fill=(200, 200, 200, 255))
        y += 30

        for i, fmt in enumerate(fmts):
            col = i % cols
            row = i // cols
            x = pad + col * (thumb_size + pad)
            iy = y + row * (thumb_size + label_h + pad)

            ico_file = FORMATS_DIR / f"{fmt}.ico"
            if ico_file.exists():
                icon = Image.open(str(ico_file)).convert("RGBA")
                icon = icon.resize((thumb_size, thumb_size), Image.LANCZOS)
                canvas.paste(icon, (x, iy), icon)

            draw.text(
                (x + thumb_size // 2 - len(fmt) * 4, iy + thumb_size + 4),
                fmt,
                fill=(255, 255, 255, 255),
            )

        row_count = (len(fmts) + cols - 1) // cols
        y += row_count * (thumb_size + label_h + pad) + pad

    canvas.save(str(PREVIEW_PATH))
    print(f"Composite preview saved to: {PREVIEW_PATH}")


if __name__ == "__main__":
    generate_icons()
    generate_preview()
