import os
import io
import base64
import requests
from PIL import Image
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# Load .env file if available
load_dotenv()

app = Flask(__name__)
CORS(app)  # Enable Cross-Origin Resource Sharing for Chrome extension

GEMINI_PROMPT = (
    "Analyze this image carefully. Extract the text or code visible in the image. "
    "Return ONLY the extracted code/text with no explanation. "
    "If no readable text or code is visible, return null."
)

print("==================================================")
print("Meesho Product Extractor Server v3.6.0 (Gemini Vision API)")
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
        "version": "3.6.0",
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

        # 1. Option A: Base64 image payload from extension
        if 'image' in data and data['image']:
            try:
                img_data = data['image']
                if ',' in img_data:
                    img_data = img_data.split(',')[1]
                image_bytes = base64.b64decode(img_data)
                img = Image.open(io.BytesIO(image_bytes))
            except Exception as b64_err:
                print(f"[Gemini OCR] Base64 decode error: {b64_err}")

        # 2. Option B: Direct CDN Image URL payload
        if img is None and 'image_url' in data and data['image_url']:
            img_url = data['image_url']
            print(f"[Gemini OCR] Fetching image from URL: {img_url}")
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            }
            resp = requests.get(img_url, headers=headers, timeout=10)
            if resp.status_code == 200:
                img = Image.open(io.BytesIO(resp.content))

        if img is None:
            print("[Gemini OCR] Error: Could not load image from payload or URL.")
            return jsonify({"code": None}), 200

        # Ensure RGB mode and crop bottom 40 pixels
        img = img.convert('RGB')
        w, h = img.size
        crop_h = min(40, h)
        if h > crop_h:
            crop_box = (0, h - crop_h, w, h)
            img_cropped = img.crop(crop_box)
        else:
            img_cropped = img

        # Save cropped slice as PNG in memory buffer
        buf = io.BytesIO()
        img_cropped.save(buf, format="PNG")
        b64_cropped = base64.b64encode(buf.getvalue()).decode("utf-8")

        # Send request to Gemini Vision API
        extracted_code = call_gemini_vision_api(api_key, b64_cropped)
        print(f"[Gemini OCR Result] Code: {extracted_code}")

        return jsonify({"code": extracted_code}), 200

    except Exception as e:
        print(f"[Gemini OCR Error] Exception: {e}")
        return jsonify({"code": None, "error": str(e)}), 200

def call_gemini_vision_api(api_key, b64_image):
    # Try gemini-2.5-flash primary endpoint, fallback to gemini-1.5-flash
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
    print("Starting Gemini Vision API OCR Server on http://127.0.0.1:5000 ...")
    app.run(host='127.0.0.1', port=5000, debug=False)
