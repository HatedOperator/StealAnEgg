"""OCR helpers shared by the tray scanner and the Discord screenshot fallback.

Requires the Tesseract binary: https://github.com/UB-Mannheim/tesseract/wiki
(window title contains "Roblox"); set cfg["tesseract_cmd"] if it's not on PATH.
"""
from __future__ import annotations

import io

from PIL import Image, ImageOps


def configure(cfg: dict) -> None:
    import pytesseract
    if cfg.get("tesseract_cmd"):
        pytesseract.pytesseract.tesseract_cmd = cfg["tesseract_cmd"]


def preprocess(img: Image.Image, scale: int = 2) -> Image.Image:
    """Upscale + grayscale + autocontrast — banner text is light-on-dark."""
    img = img.convert("L")
    img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
    img = ImageOps.autocontrast(img)
    return img


def image_to_text(img: Image.Image) -> str:
    import pytesseract
    return pytesseract.image_to_string(
        preprocess(img), config="--psm 6"
    )


def bytes_to_text(data: bytes) -> str:
    return image_to_text(Image.open(io.BytesIO(data)))
