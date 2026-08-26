document.addEventListener("DOMContentLoaded", async () => {
  const activeBadge = document.getElementById("active-badge");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const clearBtn = document.getElementById("clear-btn");
  const errorView = document.getElementById("error-view");
  const errorMessage = document.getElementById("error-message");
  const openMeeshoBtn = document.getElementById("open-meesho-btn");

  const startExtractBtn = document.getElementById("start-extract-btn");
  const stopExtractBtn = document.getElementById("stop-extract-btn");
  const statusDot = document.getElementById("status-dot");
  const progressMessage = document.getElementById("progress-message");
  const statScanned = document.getElementById("stat-scanned");
  const statMatching = document.getElementById("stat-matching");

  const exportExcelBtn = document.getElementById("export-excel-btn");
  const exportStatusText = document.getElementById("export-status-text");
  const resultsCountBadge = document.getElementById("results-count-badge");
  const resultsTableBody = document.getElementById("results-table-body");

  let currentTab = null;
  let currentProducts = [];

  // ── Active Tab ──────────────────────────────────────────
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];
  } catch (e) {}

  function isMeeshoUrl(url) {
    if (!url) return false;
    try { return new URL(url).hostname.endsWith("meesho.com"); } catch { return url.includes("meesho.com"); }
  }

  const isMeeshoTab = currentTab && isMeeshoUrl(currentTab.url);
  if (isMeeshoTab) {
    activeBadge.textContent = "Meesho Active";
    activeBadge.classList.remove("inactive");
    errorView.classList.add("hidden");
  } else {
    activeBadge.textContent = "Not Meesho";
    activeBadge.classList.add("inactive");
    errorView.classList.remove("hidden");
    errorMessage.textContent = "Please open Meesho.com before searching.";
    startExtractBtn.disabled = true;
  }



  // ── Search Input ────────────────────────────────────────
  searchInput.addEventListener("input", () => {
    clearBtn[searchInput.value.length > 0 ? "removeAttribute" : "setAttribute"]("hidden", "true");
  });
  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.setAttribute("hidden", "true");
    searchInput.focus();
  });

  // ── Search Form Submit ──────────────────────────────────
  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    const url = `https://www.meesho.com/search?q=${encodeURIComponent(query)}`;
    await chrome.storage.local.set({
      autoStartExtraction: true,
      extractionState: { isExtracting: true, progressMessage: "Searching & starting extraction...", scannedCount: 0, totalMatching: 0, products: [], tabId: currentTab?.id, error: null }
    });
    if (currentTab?.id) await chrome.tabs.update(currentTab.id, { url });
    else await chrome.tabs.create({ url });
    window.close();
  });

  // ── Open Meesho Button ──────────────────────────────────
  openMeeshoBtn.addEventListener("click", async () => {
    if (currentTab?.id && !currentTab.url?.startsWith("chrome://")) await chrome.tabs.update(currentTab.id, { url: "https://www.meesho.com" });
    else await chrome.tabs.create({ url: "https://www.meesho.com" });
    window.close();
  });

  // ── Extraction Controls ─────────────────────────────────
  startExtractBtn.addEventListener("click", async () => {
    if (!isMeeshoTab || !currentTab) return;
    startExtractBtn.disabled = true;
    stopExtractBtn.disabled = false;
    progressMessage.textContent = "Starting extraction...";
    statusDot.className = "status-dot active";
    chrome.runtime.sendMessage({ action: "START_EXTRACTION_REQUEST", tabId: currentTab.id });
  });

  stopExtractBtn.addEventListener("click", () => {
    if (!currentTab) return;
    stopExtractBtn.disabled = true;
    chrome.runtime.sendMessage({ action: "STOP_EXTRACTION_REQUEST", tabId: currentTab.id });
  });

  // ── Excel Export ────────────────────────────────────────
  exportExcelBtn.addEventListener("click", () => {
    if (!currentProducts || currentProducts.length === 0) { alert("No matching products to export."); return; }
    if (typeof XLSX === "undefined") { alert("SheetJS library failed to load."); return; }
    try {
      const rows = currentProducts.map(p => {
        const isolatedCode = p.isolated_code || (p.code && /^s-\d{6,12}$/i.test(p.code) ? p.code : null);
        const codeVal = isolatedCode || p.code || p.lens_text || "N/A";
        const fullTextVal = p.lens_text || p.code || "N/A";

        return {
          "Product Name": p.product_name || "N/A",
          "Price": p.price || "N/A",
          "Type": p.type || "General",
          "Product Link": p.product_link || "",
          "Rating / 5": p.rating !== null ? p.rating : "N/A",
          "Code": codeVal,
          "Lens Extracted Text": fullTextVal
        };
      });

      const ws = XLSX.utils.json_to_sheet(rows);
      const range = XLSX.utils.decode_range(ws["!ref"]);
      for (let R = range.s.r + 1; R <= range.e.r; ++R) {
        const cell = XLSX.utils.encode_cell({ r: R, c: 3 });
        if (ws[cell]?.v) ws[cell].l = { Target: String(ws[cell].v) };
      }
      ws["!cols"] = [{ wch: 35 }, { wch: 12 }, { wch: 18 }, { wch: 45 }, { wch: 12 }, { wch: 20 }, { wch: 40 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Filtered Products");
      const d = new Date();
      const pad = n => String(n).padStart(2, "0");
      XLSX.writeFile(wb, `meesho_products_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.xlsx`);
    } catch (e) { alert("Export failed: " + e.message); }
  });

  // ── UI State Updates ────────────────────────────────────
  function updateUIState(state) {
    if (!state) return;
    const { isExtracting, progressMessage: msg, scannedCount, products } = state;
    currentProducts = products || [];

    progressMessage.textContent = msg || (isExtracting ? "Scanning..." : "Ready");
    statusDot.className = isExtracting ? "status-dot active" : (msg === "Completed" ? "status-dot completed" : "status-dot");
    startExtractBtn.disabled = isExtracting || !isMeeshoTab;
    stopExtractBtn.disabled = !isExtracting;

    statScanned.textContent = scannedCount || 0;
    statMatching.textContent = currentProducts.length;
    resultsCountBadge.textContent = `${currentProducts.length} items`;

    const hasProducts = currentProducts.length > 0;
    exportExcelBtn.disabled = !hasProducts;
    exportStatusText.textContent = hasProducts ? `${currentProducts.length} products ready for export` : "0 products ready for export";

    renderResultsTable(currentProducts);
  }

  function renderResultsTable(products) {
    if (!products || products.length === 0) {
      resultsTableBody.innerHTML = `<tr class="empty-row"><td colspan="6">No products with >4.0 rating yet. Enter a product name to search; Google Lens reads the code watermark automatically.</td></tr>`;
      return;
    }
    resultsTableBody.innerHTML = products.map(p => {
      const name = esc(p.product_name), price = esc(p.price), type = esc(p.type);
      const rating = p.rating !== null ? p.rating.toFixed(1) : "N/A";

      const isolatedCode = p.isolated_code || (p.code && /^s-\d{6,12}$/i.test(p.code) ? p.code : null);
      const displayText = isolatedCode || p.code || p.lens_text;

      let codeHtml = `<span class="null-code">null</span>`;
      if (isolatedCode) {
        codeHtml = `<span class="code-pill" title="Isolated Supplier Code: ${esc(isolatedCode)}">${esc(isolatedCode)}</span>`;
      } else if (displayText) {
        codeHtml = `<span class="code-pill raw-text" title="Extracted Text: ${esc(p.lens_text || displayText)}">${esc(displayText)}</span>`;
      }

      return `<tr>
        <td class="prod-name" title="${name}">${name}</td>
        <td class="prod-price">${price}</td>
        <td class="prod-type">${type}</td>
        <td><span class="rating-pill">${rating} ★</span></td>
        <td>${codeHtml}</td>
        <td><a href="${p.product_link}" target="_blank" class="prod-link-btn" title="Open product page">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </a></td>
      </tr>`;
    }).join("");
  }

  function esc(s) {
    if (!s) return "";
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  }

  chrome.runtime.sendMessage({ action: "GET_STATE" }, (state) => updateUIState(state));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.extractionState) updateUIState(changes.extractionState.newValue);
  });
});
