import os
import io
import re
import base64
import requests
from PIL import Image
from flask import Flask, request, jsonify
from flask_cors import CORS

# Automatically load .env file if present (using standard library)
if os.path.exists('.env'):
    try:
        with open('.env', 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, val = line.split('=', 1)
                    os.environ.setdefault(key.strip(), val.strip().strip("'").strip('"'))
    except Exception as env_err:
        print(f"[OCR Server] Notice loading .env: {env_err}")

app = Flask(__name__)
CORS(app)  # Enable Cross-Origin Resource Sharing for Chrome extension

GEMINI_PROMPT = (
    "Analyze this product image carefully. Look for any product code, SKU, serial number, "
    "barcode text, supplier code, or any alphanumeric identifier visible anywhere in the image. "
    "Return ONLY the extracted code/text with no explanation. "
    "If no readable code or identifier is visible, return null."
)

print("==================================================")
print("Meesho Product Extractor Server v4.0.0 (Gemini Vision API - Full Image Scan)")
api_key = os.environ.get("GEMINI_API_KEY")
if api_key:
    masked_key = api_key[:4] + "..." + api_key[-4:] if len(api_key) > 8 else "***"
    print(f"GEMINI_API_KEY detected: {masked_key}")
else:
    print("WARNING: GEMINI_API_KEY environment variable is NOT set!")
    print("Create a .env file with GEMINI_API_KEY=your_key or set it in environment.")
print("==================================================")

@app.route('/health', methods=['GET'])
def health():
    key_configured = bool(os.environ.get("GEMINI_API_KEY"))
    return jsonify({
        "status": "ok",
        "version": "4.0.0",
        "engine": "Gemini Vision API",
        "api_key_configured": key_configured
    }), 200

@app.route('/ocr', methods=['POST'])
def run_ocr():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("[Gemini OCR] Error: GEMINI_API_KEY not configured. Returning null.")
        return jsonify({"code": None, "warning": "GEMINI_API_KEY environment variable missing"}), 200

    try:
        data = request.get_json(force=True, silent=True)
        if not data:
            return jsonify({"code": None, "error": "Invalid JSON body"}), 400

        img = None
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }

        # Download full high-res product image
        if 'image_url' in data and data['image_url']:
            img_url = data['image_url']
            print(f"[Gemini OCR v4.0.0] Downloading full product image: {img_url}")
            resp = requests.get(img_url, headers=headers, timeout=10)
            if resp.status_code == 200:
                img = Image.open(io.BytesIO(resp.content))
                print(f"[Gemini OCR v4.0.0] Image downloaded successfully ({img.width}x{img.height} px). Sending FULL image to Gemini Vision...")

        # Base64 image payload fallback
        if img is None and 'image' in data and data['image']:
            try:
                img_data = data['image']
                if ',' in img_data:
                    img_data = img_data.split(',')[1]
                image_bytes = base64.b64decode(img_data)
                img = Image.open(io.BytesIO(image_bytes))
                print(f"[Gemini OCR v4.0.0] Using base64 image payload ({img.width}x{img.height} px).")
            except Exception as b64_err:
                print(f"[Gemini OCR v4.0.0] Base64 decode error: {b64_err}")

        if img is None:
            print("[Gemini OCR v3.9.0] Error: Could not load image from payload or URL.")
            return jsonify({"code": None}), 200

        # Ensure RGB mode. Send the FULL image to Gemini Vision (no crop constraint)
        img = img.convert('RGB')
        w, h = img.size
        print(f"[Gemini OCR v4.0.0] Processing full image ({w}x{h} px) through Gemini Vision API...")

        # Encode full image as PNG in memory buffer
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64_full = base64.b64encode(buf.getvalue()).decode("utf-8")

        # Send full image to Gemini Vision API
        extracted_code = call_gemini_vision_api(api_key, b64_full)
        print(f"[Gemini OCR v4.0.0] Result: '{extracted_code}'")

        return jsonify({"code": extracted_code}), 200

    except Exception as e:
        print(f"[Gemini OCR Error] Exception: {e}")
        return jsonify({"code": None, "error": str(e)}), 200

def call_gemini_vision_api(api_key, b64_image):
    models = ["gemini-2.5-flash", "gemini-1.5-flash"]
    
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": GEMINI_PROMPT},
                    {
                        "inline_data": {
                            "mime_type": "image/png",
                            "data": b64_image
                        }
                    }
                ]
            }
        ]
    }

    for model in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        try:
            res = requests.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=12)
            if res.status_code == 200:
                res_data = res.json()
                raw_text = extract_text_from_gemini_response(res_data)
                cleaned = sanitize_gemini_output(raw_text)
                return cleaned
            else:
                print(f"[Gemini OCR] Model {model} returned HTTP {res.status_code}: {res.text[:150]}")
        except Exception as err:
            print(f"[Gemini OCR] Request to {model} failed: {err}")

    return None

def extract_text_from_gemini_response(res_json):
    try:
        candidates = res_json.get("candidates", [])
        if candidates and "content" in candidates[0]:
            parts = candidates[0]["content"].get("parts", [])
            if parts and "text" in parts[0]:
                return parts[0]["text"]
    except Exception:
        pass
    return ""

def sanitize_gemini_output(text):
    if not text:
        return None

    cleaned = text.strip()

    # Remove code blocks or quotes
    cleaned = cleaned.replace("```", "").replace("`", "").strip()

    # Remove common model prefix phrasing
    prefixes = [
        "the code is:", "code:", "extracted code:", "text:", "extracted text:",
        "the text is:", "visible text:"
    ]
    lowered = cleaned.lower()
    for p in prefixes:
        if lowered.startswith(p):
            cleaned = cleaned[len(p):].strip()
            lowered = cleaned.lower()

    # Normalize null responses
    null_variants = ["null", "null.", "none", "none.", "n/a", "no code", "no readable text", "no text"]
    if lowered in null_variants or len(cleaned) == 0:
        return None

    return cleaned

if __name__ == '__main__':
    print("Starting Gemini Vision API OCR Server v4.0.0 on http://127.0.0.1:5000 ...")
    app.run(host='127.0.0.1', port=5000, debug=False)
