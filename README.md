# Meesho Product Rating & Supplier-Code Extractor (v5.5.0)

Chrome extension plus a local RapidOCR service that scans Meesho search results, keeps products rated above 4.0, reads supplier codes such as `s-537307277` from product-image watermarks, and exports the results to Excel.

## How it works

1. The search-page script finds product cards with ratings strictly greater than `4.0`.
2. The background worker opens each matching product page and selects its real product-gallery images. Marketing and recommendation images are excluded.
3. The worker fetches those image bytes through Chrome and sends up to three gallery images to the local OCR service. This avoids server-side CDN/proxy failures.
4. The OCR service converts AVIF/WebP/JPEG to PNG, scans the full image and lower image bands, normalizes common OCR mistakes, and returns an `s-<digits>` code when found.

## Setup

1. Install Python dependencies:

   ```powershell
   py -3 -m pip install -r requirements.txt
   ```

2. Start the local OCR server and leave it running:

   ```powershell
   py -3 ocr_server.py
   ```

   Confirm `http://127.0.0.1:5000/health` reports `"status": "ok"`.

3. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this folder. Reload the extension after code changes.

4. Open a Meesho search page (or search from the extension), then select **Start Extraction**. Export to Excel after processing completes.

No Gemini key, Google Lens account, Selenium driver, or external OCR API is needed.

## Troubleshooting

- If all codes show `null`, first ensure the OCR server is running and reload the extension.
- The code must be visually present and readable in at least one of the first three product-gallery images; products without a visible supplier watermark correctly return `null`.
- Open the extension's service-worker console from `chrome://extensions` to see image/OCR errors.
