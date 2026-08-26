# Meesho Product Rating & Supplier-Code Extractor (v5.7.0)

This Chrome extension scans Meesho search results, keeps products rated above 4.0, and uses Google Lens to read supplier-code watermarks such as `s-452654917` from product images. Results can be exported to Excel.

## How it works

1. The search-page script finds product cards with ratings strictly greater than `4.0`.
2. The service worker opens each matching product page and selects its product-gallery images only; banners and recommendation cards are excluded.
3. The worker crops and enlarges only the lower-left watermark area, uploads that crop to Google Lens, selects **Select text**, and extracts the first matching `s-<digits>` value.
4. The first code found is shown in the results table and Excel export.

Google Lens runs in an inactive tab. No local OCR server, Python installation, API key, or `.env` file is required.

## Install and use

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this folder.
2. Reload the extension after any code changes.
3. Open a Meesho search page, select **Start Extraction**, and export the results when complete.

If Google Lens presents a CAPTCHA, complete it normally in Chrome and retry; the extension does not bypass Google security checks.
