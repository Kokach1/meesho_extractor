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
print("Initializing EasyOCR reader (languages=['en'], gpu=False)...")
reader = easyocr.Reader(['en'], gpu=False)
print("EasyOCR initialized successfully!")

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "engine": "EasyOCR"}), 200

@app.route('/ocr', methods=['POST'])
def run_ocr():
    try:
        data = request.get_json(force=True, silent=True)
        if not data:
            return jsonify({"code": None, "error": "Invalid JSON body"}), 400

        img = None

        # 1. Option A: Base64 data URL or string
        if 'image' in data and data['image']:
            img_data = data['image']
            if ',' in img_data:
                img_data = img_data.split(',')[1]
            image_bytes = base64.b64decode(img_data)
            img = Image.open(io.BytesIO(image_bytes))

        # 2. Option B: Image URL
        elif 'image_url' in data and data['image_url']:
            resp = requests.get(data['image_url'], timeout=8)
            if resp.status_code == 200:
                img = Image.open(io.BytesIO(resp.content))

        if img is None:
            return jsonify({"code": None, "error": "No valid image provided"}), 400

        # Ensure RGB mode
        img = img.convert('RGB')
        w, h = img.size

        # Crop bottom 40 pixels if full image provided (if height > 40)
        crop_h = min(40, h)
        if h > 40:
            crop_box = (0, h - crop_h, w, h)
            img_cropped = img.crop(crop_box)
        else:
            img_cropped = img

        # Convert PIL image to numpy array for EasyOCR
        img_np = np.array(img_cropped)

        # Run EasyOCR text detection
        results = reader.readtext(img_np)

        if not results:
            return jsonify({"code": None}), 200

        # Combine detected text segments
        text_segments = []
        for bbox, text, prob in results:
            cleaned = text.strip()
            if cleaned:
                text_segments.append(cleaned)

        if not text_segments:
            return jsonify({"code": None}), 200

        combined_code = " ".join(text_segments).strip()
        print(f"[OCR Result] Extracted: '{combined_code}'")

        return jsonify({"code": combined_code if len(combined_code) >= 2 else None}), 200

    except Exception as e:
        print(f"[OCR Error] {e}")
        return jsonify({"code": None, "error": str(e)}), 200

if __name__ == '__main__':
    print("Starting EasyOCR Local Service on http://127.0.0.1:5000 ...")
    app.run(host='127.0.0.1', port=5000, debug=False)
