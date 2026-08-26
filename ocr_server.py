"""Local OCR endpoint for supplier codes printed on Meesho product images."""

import base64
import io
import re

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR

app = Flask(__name__)
CORS(app)
ocr_engine = RapidOCR()

# Do not inherit a system proxy configuration for legacy image_url requests.
# The extension normally posts image bytes, so its authenticated browser fetch is
# used instead of a second network request from this local process.
image_session = requests.Session()
image_session.trust_env = False


def extract_s_code(texts):
    """Return a normalized s-<digits> code from OCR text, if present."""
    candidates = [str(text) for text in texts if text]
    # OCR can split a code over neighbouring text boxes, so test their joined form too.
    candidates.append(" ".join(candidates))
    pattern = re.compile(
        r"(?:^|[^a-z0-9])(?:s|5|\$)\s*[-_–—]?\s*((?:[0-9oOil]\s*){6,12})(?=$|[^a-z0-9])",
        re.IGNORECASE,
    )
    for candidate in candidates:
        match = pattern.search(candidate)
        if not match:
            continue
        digits = re.sub(r"\s+", "", match.group(1)).translate(str.maketrans({"o": "0", "O": "0", "i": "1", "I": "1", "l": "1"}))
        if digits.isdigit() and 6 <= len(digits) <= 12:
            return f"s-{digits}"
    return None


def image_to_png(image):
    """Convert AVIF/WebP/JPEG consistently and enlarge small text for RapidOCR."""
    image = ImageOps.exif_transpose(image).convert("RGB")
    if image.width < 1200:
        scale = min(3, max(2, 1200 // max(image.width, 1) + 1))
        image = image.resize((image.width * scale, image.height * scale), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), image


def ocr_texts(image_bytes):
    result, _ = ocr_engine(image_bytes)
    return [item[1] for item in (result or []) if len(item) > 1 and item[1]]


def process_image_bytes(image_bytes):
    """OCR the full image and focused lower areas, returning (code, detected_text)."""
    try:
        image = Image.open(io.BytesIO(image_bytes))
        normalized_bytes, normalized_image = image_to_png(image)
    except Exception as error:
        raise ValueError(f"Unsupported or invalid image: {error}") from error

    all_texts = []
    regions = [normalized_bytes]
    width, height = normalized_image.size
    # Codes are normally near the lower edge. Use two bands to avoid losing a
    # watermark that sits just above the old 25% crop boundary.
    for top_ratio in (0.55, 0.72):
        crop = normalized_image.crop((0, int(height * top_ratio), width, height))
        buffer = io.BytesIO()
        crop.save(buffer, format="PNG", optimize=True)
        regions.append(buffer.getvalue())

    for region in regions:
        texts = ocr_texts(region)
        all_texts.extend(texts)
        code = extract_s_code(texts)
        if code:
            return code, all_texts
    return None, all_texts


def decode_base64_image(value):
    if not isinstance(value, str) or not value:
        return None
    if "," in value:
        value = value.split(",", 1)[1]
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError(f"Invalid base64 image: {error}") from error


def download_image(url):
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise ValueError("Invalid image URL")
    response = image_session.get(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"},
        timeout=20,
    )
    response.raise_for_status()
    return response.content


@app.get("/health")
def health():
    return jsonify({"status": "ok", "version": "5.5.0", "engine": "RapidOCR"})


@app.post("/ocr")
def run_ocr():
    try:
        data = request.get_json(force=True, silent=True) or {}
        # Current extension protocol: image bytes already fetched by Chrome.
        encoded_images = data.get("images") or ([] if not data.get("image") else [data["image"]])
        image_bytes_list = [decode_base64_image(value) for value in encoded_images]
        image_bytes_list = [value for value in image_bytes_list if value]

        # Backward-compatible protocol for callers still sending image URLs.
        if not image_bytes_list:
            urls = data.get("image_urls") or ([] if not data.get("image_url") else [data["image_url"]])
            image_bytes_list = [download_image(url) for url in urls[:3]]

        if not image_bytes_list:
            return jsonify({"code": None, "error": "No valid image payload"}), 400

        detected_texts = []
        for image_bytes in image_bytes_list[:3]:
            code, texts = process_image_bytes(image_bytes)
            detected_texts.extend(texts)
            if code:
                print(f"[OCR] Extracted {code!r}")
                return jsonify({"code": code}), 200

        print(f"[OCR] No supplier code found (detected: {detected_texts})")
        return jsonify({"code": None}), 200
    except Exception as error:
        print(f"[OCR] Error: {error}")
        return jsonify({"code": None, "error": str(error)}), 200


if __name__ == "__main__":
    print("Meesho Local OCR Server v5.5.0 listening on http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
