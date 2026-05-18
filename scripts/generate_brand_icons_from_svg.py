#!/usr/bin/env python3
"""
Rasterize assets/prod/logo.svg into web favicons, Apple touch icon, and Windows .ico
bundles used by scripts/lib/brand-assets.ts.

Dependencies: pip install -r scripts/favicon-gen-requirements.txt
(System Cairo is required by cairosvg; on macOS: brew install cairo pango gdk-pixbuf libffi.)
"""

from __future__ import annotations

import argparse
import io
import shutil
import sys
from pathlib import Path

try:
  import cairosvg
  from PIL import Image
except ModuleNotFoundError as e:
  print(
    "Missing dependency:",
    e.name,
    file=sys.stderr,
  )
  print(
    "Create a venv and install: pip install -r scripts/favicon-gen-requirements.txt",
    file=sys.stderr,
  )
  sys.exit(1)


def _repo_root() -> Path:
  return Path(__file__).resolve().parent.parent


def _svg_to_image(svg_bytes: bytes, size: int) -> Image.Image:
  png = cairosvg.svg2png(
    bytestring=svg_bytes,
    output_width=size,
    output_height=size,
  )
  return Image.open(io.BytesIO(png)).convert("RGBA")


def _save_web_ico(path: Path, images: list[Image.Image], sizes: list[int]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  images[0].save(
    path,
    format="ICO",
    sizes=[(s, s) for s in sizes],
    append_images=images[1:],
  )


def _save_png(path: Path, image: Image.Image) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  image.save(path, format="PNG", optimize=True)


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
    "--svg",
    type=Path,
    help="Source SVG (default: <repo>/assets/prod/logo.svg)",
  )
  parser.add_argument(
    "--repo-root",
    type=Path,
    default=_repo_root(),
    help="Repository root",
  )
  args = parser.parse_args()
  root: Path = args.repo_root.resolve()
  svg_path = (args.svg or (root / "assets" / "prod" / "logo.svg")).resolve()
  if not svg_path.is_file():
    print(f"SVG not found: {svg_path}", file=sys.stderr)
    sys.exit(1)

  svg_bytes = svg_path.read_bytes()

  web_ico_sizes = (16, 32, 48)
  web_images = [_svg_to_image(svg_bytes, s) for s in web_ico_sizes]

  img16 = web_images[0]
  img32 = web_images[1]
  img180 = _svg_to_image(svg_bytes, 180)

  win_sizes = (16, 32, 48, 64, 128, 256)
  win_images = [_svg_to_image(svg_bytes, s) for s in win_sizes]

  brands = (
    ("prod", "t3-black"),
    ("nightly", "blueprint"),
    ("dev", "blueprint"),
  )

  for sub, prefix in brands:
    base = root / "assets" / sub
    ico_web = base / f"{prefix}-web-favicon.ico"
    ico_win = base / f"{prefix}-windows.ico"
    png16 = base / f"{prefix}-web-favicon-16x16.png"
    png32 = base / f"{prefix}-web-favicon-32x32.png"
    apple = base / f"{prefix}-web-apple-touch-180.png"

    _save_web_ico(ico_web, web_images, list(web_ico_sizes))
    _save_web_ico(ico_win, win_images, list(win_sizes))
    _save_png(png16, img16)
    _save_png(png32, img32)
    _save_png(apple, img180)

  web_public = root / "apps" / "web" / "public"
  marketing_public = root / "apps" / "marketing" / "public"
  dev_ico = root / "assets" / "dev" / "blueprint-web-favicon.ico"
  dev16 = root / "assets" / "dev" / "blueprint-web-favicon-16x16.png"
  dev32 = root / "assets" / "dev" / "blueprint-web-favicon-32x32.png"
  dev_apple = root / "assets" / "dev" / "blueprint-web-apple-touch-180.png"

  for dest_dir in (web_public, marketing_public):
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(dev_ico, dest_dir / "favicon.ico")
    shutil.copy2(dev16, dest_dir / "favicon-16x16.png")
    shutil.copy2(dev32, dest_dir / "favicon-32x32.png")
    shutil.copy2(dev_apple, dest_dir / "apple-touch-icon.png")

  n_brand_files = len(brands) * 5
  print(f"Wrote {n_brand_files} files under assets/{{prod,nightly,dev}}/ from {svg_path.relative_to(root)}")
  print(
    f"Copied dev web icons (ico, 16/32 png, apple touch) to "
    f"{web_public.relative_to(root)} and {marketing_public.relative_to(root)}",
  )


if __name__ == "__main__":
  main()
