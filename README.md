# Meesho Product Search, Rating Filter & Gemini Vision Extractor 🛒📊🤖 (v3.6.0)

A high-performance Chrome Extension (Manifest V3) paired with a secure local Python backend microservice that performs instant product searching on [Meesho.com](https://www.meesho.com), incremental scrolling, rating filtering (**> 4.0 out of 5**), bottom 40px image code extraction using **Gemini Vision API**, and one-click export to **Excel (.xlsx)**.

---

## 🌟 Upgraded Features (v3.6.0)

- **Gemini Vision API Product Code Extraction**: Sends cropped bottom 40px image slices to Google's **Gemini Vision API** with prompt:
  `"Analyze this image carefully. Extract the text or code visible in the image. Return ONLY the extracted code/text with no explanation. If no readable text or code is visible, return null."`
- **Zero API Key Exposure**: The Gemini API key is **NEVER** hardcoded in extension content scripts or committed to GitHub. It is read securely from environment variables (`GEMINI_API_KEY`) or a local `.env` file inside `ocr_server.py`.
- **Sanitized Output**: Trims whitespace, removes conversational model phrasing, and normalizes empty or `"null"` responses into `null`.
- **Strict Rating Filter (>4.0 ★)**: Automatically filters and retains only products with numeric ratings strictly greater than **4.0 out of 5**.
- **Excel Export (.xlsx)**: Export filtered dataset directly to Microsoft Excel format using locally bundled SheetJS (`xlsx.full.min.js`). Includes timestamped filename `meesho_products_YYYY-MM-DD_HH-mm.xlsx` and active hyperlinks for product URLs.
- **Interactive Dashboard**: Real-time progress status, live scanned & matching counters, control buttons (**Search**, **Start Extraction**, **Stop Extraction**, **Export to Excel**), and scrollable table view with a dedicated **Code** column.

---

## 📁 Extension File Architecture

```
meesho-search-extractor/
├── ocr_server.py         # Local Python microservice using Gemini Vision API (modified)
├── .env.example          # Sample environment file for GEMINI_API_KEY (NEW)
├── .gitignore            # Excludes secret .env file from Git commits (NEW)
├── requirements.txt      # Python dependencies (modified)
├── manifest.json         # Extension Manifest V3 (Version 3.6.0)
├── background.js         # Service worker for background state & message relay
├── content.js            # Content script calling http://127.0.0.1:5000/ocr
├── popup.html            # Extension popup UI (Version 3.6.0)
├── popup.css             # Extension styling
├── popup.js              # Extractor UI controller & SheetJS Excel exporter
├── xlsx.full.min.js      # Bundled local SheetJS library for XLSX export
├── icons/                # Extension icons (16px, 48px, 128px)
└── README.md             # Documentation & setup instructions (v3.6.0)
```

---

## 🔑 How to Setup Gemini API Key & Run Local Server

1. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Configure API Key**:
   Create a `.env` file in the extension folder:
   ```env
   GEMINI_API_KEY=your_actual_gemini_api_key_here
   ```
   *(Or set `GEMINI_API_KEY` in your system environment variables).*

3. **Start Gemini Local Service**:
   ```bash
   python ocr_server.py
   ```
   The server will verify your API key configuration and listen on `http://127.0.0.1:5000`.

---

## 🚀 How to Install & Use the Chrome Extension

1. Go to `chrome://extensions/` in Google Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select folder:
   `c:\Users\KOKACHI\Downloads\projects\mesho\ce`
3. Pin the extension to your toolbar.
4. Click the extension icon, enter a product query (e.g. `saree` or `shoes`), and press <kbd>Enter</kbd>.
5. The extension will open Meesho, scroll down, filter products with `rating > 4.0`, extract product codes using **Gemini Vision API**, and populate the dashboard!
6. Click **Export to Excel** to download your complete `.xlsx` spreadsheet!
