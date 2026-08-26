import os
import io
import re
import base64
import requests
from PIL import Image
from flask import Flask, request, jsonify
from flask_cors import CORS
from rapidocr_onnxruntime import RapidOCR

app = Flask(__name__)
CORS(app)

print("==================================================")
print("Meesho Local OCR Server v5.4.0 (RapidOCR Neural Engine)")
print("==================================================")

# Initialize RapidOCR engine once
ocr_engine = RapidOCR()

def extract_s_code(text_list):
    """
    Search extracted text lines for Meesho product code patterns:
    e.g. 'S-537307277', 's-12345678', 's - 98765432'
    """
    for text in text_list:
        if not text:
            continue
        cleaned = text.strip()
        # Direct pattern: s- followed by 6-12 digits
        m = re.search(r'\b[sS]-?(\d{6,12})\b', cleaned)
        if m:
            return f"s-{m.group(1)}"

        # Resilient pattern: handle potential OCR confusion on 'S' or missing dash
        m_flex = re.search(r'(?:^|\s|[^\w])([sS5$])\s*[-_–—]?\s*(\d{6,12})(?:$|\s|[^\w])', cleaned)
        if m_flex:
            return f"s-{m_flex.group(2)}"

    return None

def process_image_bytes(img_bytes):
    # Pass 1: Run OCR on the full provided image bytes
    result, _ = ocr_engine(img_bytes)
    texts = [item[1] for item in (result or [])]
    code = extract_s_code(texts)
    if code:
        return code, texts

    # Pass 2: Crop bottom 25% (where Meesho watermarks are located) and retry
    try:
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        w, h = img.size
        crop_h = min(350, max(100, int(h * 0.25)))
        cropped = img.crop((0, h - crop_h, w, h))
        buf = io.BytesIO()
        cropped.save(buf, format="PNG")
        cropped_bytes = buf.getvalue()
        
        result_crop, _ = ocr_engine(cropped_bytes)
        texts_crop = [item[1] for item in (result_crop or [])]
        code_crop = extract_s_code(texts_crop)
        if code_crop:
            return code_crop, texts_crop
    except Exception as e:
        print(f"[OCR] Crop retry error: {e}")

    return None, texts

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "version": "5.4.0",
        "engine": "RapidOCR Neural Engine"
    }), 200

@app.route('/ocr', methods=['POST'])
def run_ocr():
    try:
        data = request.get_json(force=True, silent=True)
        if not data:
            return jsonify({"code": None, "error": "Invalid JSON body"}), 400

        img_bytes = None

        # Base64 payload
        if 'image' in data and data['image']:
            try:
                img_data = data['image']
                if ',' in img_data:
                    img_data = img_data.split(',', 1)[1]
                img_bytes = base64.b64decode(img_data)
            except Exception as e:
                print(f"[OCR] Base64 decode error: {e}")

        # Image URL payload
        elif 'image_url' in data and data['image_url']:
            url = data['image_url']
            print(f"[OCR] Downloading: {url}")
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "image/*,*/*;q=0.8"
            }
            resp = requests.get(url, headers=headers, timeout=15)
            if resp.status_code == 200:
                img_bytes = resp.content
            else:
                print(f"[OCR] Download failed HTTP {resp.status_code}")
                return jsonify({"code": None}), 200

        if not img_bytes:
            return jsonify({"code": None, "error": "No valid image payload"}), 400

        code, detected_texts = process_image_bytes(img_bytes)
        print(f"[OCR] Extracted: {code!r} (detected texts: {detected_texts})")
        return jsonify({"code": code}), 200

    except Exception as e:
        print(f"[OCR] Error: {e}")
        return jsonify({"code": None, "error": str(e)}), 200

if __name__ == '__main__':
    print("Starting Meesho Local OCR Server v5.4.0 on http://127.0.0.1:5000 ...")
    app.run(host='127.0.0.1', port=5000, debug=False)
