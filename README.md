# Meesho Product Search, Rating Filter & EasyOCR Extractor 🛒📊🐍

A high-performance Chrome Extension (Manifest V3) paired with a local Python **EasyOCR** microservice that performs instant product searching on [Meesho.com](https://www.meesho.com), incremental scrolling, rating filtering (**> 4.0 out of 5**), bottom 40px image text extraction via **EasyOCR**, and one-click export to **Excel (.xlsx)**.

---

## 🌟 Architecture & Features

- **Automated Search & Extraction**: Enter a product query in the popup to search Meesho and automatically trigger product extraction upon page load.
- **Strict Rating Filter (>4.0 ★)**: Automatically filters and retains only products with numeric ratings strictly greater than **4.0 out of 5**.
- **EasyOCR Local Python Microservice (`ocr_server.py`)**:
  - Uses `EasyOCR` (`languages=['en']`, `gpu=False`).
  - Crops bottom 40 pixels of high-rated product images and runs EasyOCR text extraction via a local REST API (`http://127.0.0.1:5000/ocr`).
  - Enforces a 10-second timeout per product card (`timeout_seconds: 10`).
- **Fault-Tolerant Fallback**: If the local Python EasyOCR server is offline or unreachable, the Chrome Extension catches the network error gracefully, sets `Code` to `null`, and continues extracting remaining products without crashing.
- **Excel Export (.xlsx)**: Export filtered dataset directly to Microsoft Excel format using locally bundled SheetJS (`xlsx.full.min.js`). Includes timestamped filename `meesho_products_YYYY-MM-DD_HH-mm.xlsx` and active hyperlinks for product URLs.
- **Interactive Dashboard**: Real-time progress status, live scanned & matching counters, control buttons (**Search**, **Start Extraction**, **Stop Extraction**, **Export to Excel**), and scrollable table view with a dedicated **Code** column.

---

## 📁 Extension File Architecture

```
meesho-search-extractor/
├── ocr_server.py         # Local Python Flask microservice using EasyOCR (NEW)
├── requirements.txt      # Python dependencies for EasyOCR server (NEW)
├── manifest.json         # Manifest V3 extension manifest (modified)
├── background.js         # Service worker for background state & message relay
├── content.js            # Content script calling http://127.0.0.1:5000/ocr (modified)
├── popup.html            # Extension popup UI with Code column table
├── popup.css             # Extension styling with Code badge formatting
├── popup.js              # Extractor UI controller & SheetJS Excel exporter
├── xlsx.full.min.js      # Bundled local SheetJS library for XLSX export
├── icons/                # Extension icons (16px, 48px, 128px)
└── README.md             # Complete documentation & setup instructions (modified)
```

---

## 🐍 How to Setup & Run the Local EasyOCR Python Server

1. **Install Python Dependencies**:
   Open your terminal in the extension folder and run:
   ```bash
   pip install -r requirements.txt
   ```

2. **Start EasyOCR Service**:
   Run the local server script:
   ```bash
   python ocr_server.py
   ```
   The server will start listening on `http://127.0.0.1:5000`.

*(Note: If you choose not to run the Python server, the Chrome extension will still extract all product details normally and default the `Code` field to `null`.)*

---

## 🚀 How to Install & Use the Chrome Extension

1. Go to `chrome://extensions/` in Google Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select folder:
   `c:\Users\KOKACHI\Downloads\projects\mesho\ce`
3. Pin the extension to your toolbar.
4. Click the extension icon, enter a product query (e.g. `kurti` or `shoes`), and press <kbd>Enter</kbd>.
5. The extension will open Meesho, scroll down, filter products with `rating > 4.0`, run EasyOCR on bottom 40px images, and populate the dashboard!
6. Click **Export to Excel** to download your complete `.xlsx` spreadsheet!
