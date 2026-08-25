# Meesho Product Search, Rating Filter & OCR Code Extractor 🛒📊🔍

A powerful Chrome Extension (Manifest V3) that enables instant product searching on [Meesho.com](https://www.meesho.com), automated DOM extraction & incremental scrolling, real-time product filtering for items with ratings strictly **> 4.0 out of 5**, **bottom 40px product image OCR code extraction**, and one-click export to **Excel (.xlsx)**.

---

## 🌟 Upgraded Features

- **Automated Search & Extract**: Enter a product query in the popup to search Meesho and automatically start product extraction as soon as the search page loads!
- **Strict Rating Filter (>4.0 ★)**: Automatically filters and retains only products with numeric ratings strictly greater than **4.0 out of 5**.
- **Product Code OCR (Bottom 40px Crop)**: For every product passing the rating filter, crops the bottom 40 pixels of its primary image using HTML5 `<canvas>` and runs local OCR (`tesseract.min.js`) with a strict **3-second timeout** to extract visible product codes.
- **Graceful Null Fallback**: If an image cannot be loaded, produces no readable text, or exceeds the 3-second timeout, `Code` is set to `null` while extraction continues for remaining products.
- **Product Deduplication**: Uses `product_link` as unique deduplication key to eliminate duplicate product cards during continuous page scrolling.
- **Excel Export (.xlsx)**: Export filtered dataset directly to Microsoft Excel format using locally bundled SheetJS (`xlsx.full.min.js`). Includes timestamped filename `meesho_products_YYYY-MM-DD_HH-mm.xlsx` and active hyperlinks for product URLs.
- **Interactive Dashboard**: Real-time progress status, live scanned & matching counters, control buttons (**Search**, **Start Extraction**, **Stop Extraction**, **Export to Excel**), and scrollable table view with a dedicated **Code** column.

---

## 📁 Extension File Architecture

```
meesho-search-extractor/
├── manifest.json         # Manifest V3 extension manifest (modified)
├── background.js         # Service worker for background state & message relay (modified)
├── content.js            # Content script for DOM scraping, auto-scroll & OCR (modified)
├── popup.html            # Extension popup UI with Code column table (modified)
├── popup.css             # Extension styling with Code badge formatting (modified)
├── popup.js              # Extractor UI controller & SheetJS Excel exporter (modified)
├── xlsx.full.min.js      # Bundled local SheetJS library for XLSX export
├── tesseract.min.js     # Bundled local Tesseract.js engine for OCR extraction (NEW)
├── icons/                # Extension icons (16px, 48px, 128px)
└── README.md             # Complete documentation & usage guide (modified)
```

---

## 📊 Extracted Excel Sheet Schema

| Column Name | Description | Fallback / Example |
| :--- | :--- | :--- |
| **Product Name** | Full title of the product card | `Women Cotton Printed Saree` |
| **Price** | Current displayed price | `₹349` |
| **Type** | Product classification / category | `Saree` |
| **Product Link** | Full URL link (Clickable hyperlink) | `https://www.meesho.com/p/1abc2d` |
| **Rating / 5** | Numeric rating out of 5 | `4.3` |
| **Code** | Extracted code from bottom 40px image OCR | `saree_code1` or `null` |

---

## 🚀 How to Install & Use in Chrome

1. Go to `chrome://extensions/` in Google Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select folder:
   `c:\Users\KOKACHI\Downloads\projects\mesho\ce`
3. Pin the extension to your toolbar.
4. Click the extension icon, enter a product query (e.g. `kurti` or `shoes`), and press <kbd>Enter</kbd>.
5. The extension will automatically open Meesho, scroll down, filter products with `rating > 4.0`, run bottom 40px image OCR, and populate the dashboard!
6. Click **Export to Excel** to download your complete `.xlsx` spreadsheet!
