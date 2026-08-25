import io
import base64
import requests
import numpy as np
from PIL import Image
from flask import Flask, request, jsonify
from flask_cors import CORS
import easyocr

app = Flask(__name__)
CORS(app)  # Enable Cross-Origin Resource Sharing for Chrome extension

# Initialize EasyOCR reader (English, CPU mode)
print("==================================================")
print("Initializing EasyOCR reader (languages=['en'], gpu=False)...")
reader = easyocr.Reader(['en'], gpu=False)
print("EasyOCR initialized successfully! Ready for requests.")
print("==================================================")

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "engine": "EasyOCR"}), 200

@app.route('/ocr', methods=['POST'])
def run_ocr():
    try:
        data = request.get_json(force=True, silent=True)
        if not data:
            print("[OCR Server] Error: Empty or invalid JSON body received")
            return jsonify({"code": None, "error": "Invalid JSON body"}), 400

        img = None

        # 1. Base64 data URL payload
        if 'image' in data and data['image']:
            try:
                img_data = data['image']
                if ',' in img_data:
                    img_data = img_data.split(',')[1]
                image_bytes = base64.b64decode(img_data)
                img = Image.open(io.BytesIO(image_bytes))
                print("[OCR Server] Successfully received base64 cropped image.")
            except Exception as b64_err:
                print(f"[OCR Server] Base64 decode failed: {b64_err}. Trying image_url fallback...")

        # 2. Image URL payload (bypasses browser CORS completely!)
        if img is None and 'image_url' in data and data['image_url']:
            img_url = data['image_url']
            print(f"[OCR Server] Fetching image directly from CDN URL: {img_url}")
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            }
            resp = requests.get(img_url, headers=headers, timeout=10)
            if resp.status_code == 200:
                img = Image.open(io.BytesIO(resp.content))
                print(f"[OCR Server] Image fetched successfully ({len(resp.content)} bytes).")
            else:
                print(f"[OCR Server] HTTP {resp.status_code} error when fetching image URL.")

        if img is None:
            print("[OCR Server] Error: Unable to load image from payload or URL.")
            return jsonify({"code": None, "error": "No valid image provided"}), 400

        # Ensure RGB mode
        img = img.convert('RGB')
        w, h = img.size

        # Crop bottom 40 pixels (or height of image if smaller)
        crop_h = min(40, h)
        if h > crop_h:
            crop_box = (0, h - crop_h, w, h)
            img_cropped = img.crop(crop_box)
        else:
            img_cropped = img

        # Upscale 2x for clearer OCR recognition of small printed text
        cw, ch = img_cropped.size
        img_upscaled = img_cropped.resize((cw * 2, ch * 2), Image.Resampling.LANCZOS)
        img_np = np.array(img_upscaled)

        # Run EasyOCR text detection
        results = reader.readtext(img_np)

        if not results:
            print("[OCR Server] No text detected in bottom 40px region.")
            return jsonify({"code": None}), 200

        # Combine detected text segments
        text_segments = []
        for bbox, text, prob in results:
            cleaned = text.strip()
            if cleaned and len(cleaned) >= 1:
                text_segments.append(cleaned)

        if not text_segments:
            print("[OCR Server] Text segments empty after cleaning.")
            return jsonify({"code": None}), 200

        combined_code = " ".join(text_segments).strip()
        print(f"==================================================")
        print(f" SUCCESS: Extracted Code -> '{combined_code}'")
        print(f"==================================================")

        return jsonify({"code": combined_code if len(combined_code) >= 1 else None}), 200

    except Exception as e:
        print(f"[OCR Server Error] {e}")
        return jsonify({"code": None, "error": str(e)}), 200

if __name__ == '__main__':
    print("Starting EasyOCR Local Service on http://127.0.0.1:5000 ...")
    app.run(host='127.0.0.1', port=5000, debug=False)
