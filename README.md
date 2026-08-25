# Meesho Product Search, Rating Filter & Extractor Extension 🛒📊

A feature-rich Chrome Extension (Manifest V3) that enables instant product searching on [Meesho.com](https://www.meesho.com), automated DOM extraction & incremental scrolling, real-time product filtering for items with ratings strictly **> 4.0 out of 5**, and one-click export to **Excel (.xlsx)**.

---

## 🌟 Upgraded Features

- **Direct Search**: Perform product searches directly on your active Meesho tab.
- **Automated Product Scraping**: Extracts product cards dynamically from the live DOM while on Meesho search pages.
- **Incremental Auto-Scrolling**: Automatically scrolls down by ~1 viewport height every 1.5 seconds to trigger loading of dynamic content (stops after 3 consecutive scrolls with no new products or max 100 scrolls).
- **Strict Rating Filter (>4.0 ★)**: Automatically filters and retains only products with numeric ratings strictly greater than **4.0 out of 5**.
- **Product Deduplication**: Uses `product_link` as unique deduplication key to eliminate repeated extraction of identical items during scroll.
- **Excel Export (.xlsx)**: Export filtered dataset directly to Microsoft Excel format using locally bundled SheetJS (`xlsx.full.min.js`). Includes timestamped filename `meesho_products_YYYY-MM-DD_HH-mm.xlsx` and active hyperlinks for product URLs.
- **Interactive Dashboard**: Real-time progress notifications ("Searching Meesho...", "Scanning products...", "Filtering results...", "Completed"), live total scanned & matching counters, and control buttons (**Search**, **Start Extraction**, **Stop Extraction**, **Export to Excel**).

---

## 📁 Extension File Architecture

```
meesho-search-extractor/
├── manifest.json         # Manifest V3 extension manifest (modified)
├── background.js         # Service worker for background state & message relay (NEW)
├── content.js            # Content script for DOM scraping & auto-scrolling (NEW)
├── popup.html            # Extension popup UI with extractor dashboard (modified)
├── popup.css             # Extension styling with dark glassmorphism & tables (modified)
├── popup.js              # Extractor UI controller & SheetJS Excel exporter (modified)
├── xlsx.full.min.js      # Bundled local SheetJS library for XLSX export (NEW)
├── icons/                # Extension icons (16px, 48px, 128px)
└── README.md             # Complete documentation & usage guide (modified)
```

---

## 🚀 How to Install / Load Unpacked Extension in Chrome

1. **Open Chrome Extensions Page**:
   - Open Google Chrome.
   - Go to `chrome://extensions/` in the address bar (or navigate to **Menu ➔ Extensions ➔ Manage Extensions**).

2. **Enable Developer Mode**:
   - Turn on the **Developer mode** toggle switch in the top-right corner.

3. **Load Unpacked Extension**:
   - Click **Load unpacked** in the top-left area.
   - Select the project root folder:
     `c:\Users\KOKACHI\Downloads\projects\mesho\ce`
   - Click **Select Folder**.

4. **Pin to Toolbar**:
   - Click the puzzle icon in Chrome toolbar and pin **Meesho Product Search & Rating Extractor**.

---

## 💡 How to Use the Extractor & Excel Export

### 1. Perform Product Search
- Open [meesho.com](https://www.meesho.com) or click the extension popup.
- Enter your search keyword (e.g. `saree`, `mens tshirt`, `kurti`, `shoes`) and click **Search Meesho** (or press <kbd>Enter</kbd>).

### 2. Extract & Filter Products
- Once search results load on Meesho, click the extension icon.
- Click **Start Extraction**.
- The extension will automatically scroll the page incrementally, scan live product listing cards, and extract product details.
- Watch the live counters:
  - **Scanned**: Total unique products encountered on the page.
  - **Matching (>4.0 ★)**: Total products passing the strictly `> 4.0` rating threshold.
- Click **Stop Extraction** anytime to pause/cancel extraction manually.

### 3. Export to Excel (.xlsx)
- Once extraction completes (or is stopped), the **Export to Excel** button becomes active.
- Click **Export to Excel**.
- A `.xlsx` file named e.g. `meesho_products_2026-08-25_19-30.xlsx` will automatically download to your computer!
- Open the `.xlsx` file in Microsoft Excel, Google Sheets, or LibreOffice Calc.
- All product links inside the Excel spreadsheet are formatted as clickable hyperlinks!

---

## 📊 Extracted Excel Sheet Data Schema

| Column Name | Description | Example |
| :--- | :--- | :--- |
| **Product Name** | Full title of the product card | `Women Cotton Printed Saree` |
| **Price** | Current displayed price | `₹349` |
| **Type** | Product classification / category | `Saree` |
| **Product Link** | Full URL link (Clickable hyperlink) | `https://www.meesho.com/p/1abc2d` |
| **Rating / 5** | Numeric rating out of 5 | `4.3` |

---

## 🔒 Privacy & Security

- **100% Local Processing**: All product extraction, filtering, and Excel spreadsheet creation happens client-side within your browser.
- **Zero External Server Transmission**: No product data or personal info is sent to any external server or API.
