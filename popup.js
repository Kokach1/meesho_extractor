document.addEventListener("DOMContentLoaded", async () => {
  // UI Element References
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

  // Query Active Tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];
  } catch (err) {
    console.error("Error fetching active tab:", err);
  }

  function isMeeshoUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.hostname === "meesho.com" || u.hostname.endsWith(".meesho.com");
    } catch {
      return url.includes("meesho.com");
    }
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

  // Clear Input Logic
  searchInput.addEventListener("input", () => {
    if (searchInput.value.length > 0) {
      clearBtn.removeAttribute("hidden");
    } else {
      clearBtn.setAttribute("hidden", "true");
    }
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.setAttribute("hidden", "true");
    searchInput.focus();
  });

  // Handle Search Submission (Automates search + auto-extraction!)
  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    const encodedQuery = encodeURIComponent(query);
    const targetUrl = `https://www.meesho.com/search?q=${encodedQuery}`;

    // Set flag for automatic extraction upon page load
    await chrome.storage.local.set({
      autoStartExtraction: true,
      extractionState: {
        isExtracting: true,
        progressMessage: "Searching Meesho & starting extraction...",
        scannedCount: 0,
        totalMatching: 0,
        products: [],
        tabId: currentTab ? currentTab.id : null,
        error: null
      }
    });

    if (currentTab && currentTab.id) {
      await chrome.tabs.update(currentTab.id, { url: targetUrl });
    } else {
      await chrome.tabs.create({ url: targetUrl });
    }
    window.close();
  });

  // Open Meesho homepage button if not on Meesho
  openMeeshoBtn.addEventListener("click", async () => {
    const meeshoHome = "https://www.meesho.com";
    if (currentTab && currentTab.id && !currentTab.url.startsWith("chrome://")) {
      await chrome.tabs.update(currentTab.id, { url: meeshoHome });
    } else {
      await chrome.tabs.create({ url: meeshoHome });
    }
    window.close();
  });

  // Extraction Button Handlers
  startExtractBtn.addEventListener("click", async () => {
    if (!isMeeshoTab || !currentTab) return;
    startExtractBtn.disabled = true;
    stopExtractBtn.disabled = false;
    progressMessage.textContent = "Starting extraction...";
    statusDot.className = "status-dot active";

    chrome.runtime.sendMessage({
      action: "START_EXTRACTION_REQUEST",
      tabId: currentTab.id
    });
  });

  stopExtractBtn.addEventListener("click", async () => {
    if (!currentTab) return;
    stopExtractBtn.disabled = true;
    chrome.runtime.sendMessage({
      action: "STOP_EXTRACTION_REQUEST",
      tabId: currentTab.id
    });
  });

  // Excel Export Handler
  exportExcelBtn.addEventListener("click", () => {
    if (!currentProducts || currentProducts.length === 0) {
      alert("No matching products with >4.0 rating available to export.");
      return;
    }

    if (typeof XLSX === "undefined") {
      alert("SheetJS library failed to load.");
      return;
    }

    try {
      const exportRows = currentProducts.map((p) => ({
        "Product Name": p.product_name || "N/A",
        "Price": p.price || "N/A",
        "Type": p.type || "General",
        "Product Link": p.product_link || "",
        "Rating / 5": p.rating !== null ? p.rating : "N/A"
      }));

      const worksheet = XLSX.utils.json_to_sheet(exportRows);

      const range = XLSX.utils.decode_range(worksheet["!ref"]);
      for (let R = range.s.r + 1; R <= range.e.r; ++R) {
        const cellRef = XLSX.utils.encode_cell({ r: R, c: 3 });
        if (worksheet[cellRef] && worksheet[cellRef].v) {
          const urlStr = String(worksheet[cellRef].v);
          worksheet[cellRef].l = { Target: urlStr, Tooltip: "Open Product Page" };
        }
      }

      worksheet["!cols"] = [
        { wch: 35 }, // Product Name
        { wch: 12 }, // Price
        { wch: 18 }, // Type
        { wch: 45 }, // Product Link
        { wch: 12 }  // Rating / 5
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Filtered Products");

      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
      const filename = `meesho_products_${timestamp}.xlsx`;

      XLSX.writeFile(workbook, filename);
    } catch (err) {
      console.error("Failed to export Excel file:", err);
      alert("Export failed: " + err.message);
    }
  });

  // State Updates & UI Sync
  function updateUIState(state) {
    if (!state) return;

    const { isExtracting, progressMessage: msg, scannedCount, products } = state;
    currentProducts = products || [];

    progressMessage.textContent = msg || (isExtracting ? "Scanning products..." : "Ready");

    if (isExtracting) {
      statusDot.className = "status-dot active";
      startExtractBtn.disabled = true;
      stopExtractBtn.disabled = false;
    } else {
      statusDot.className = msg === "Completed" ? "status-dot completed" : "status-dot";
      startExtractBtn.disabled = !isMeeshoTab;
      stopExtractBtn.disabled = true;
    }

    statScanned.textContent = scannedCount || 0;
    statMatching.textContent = currentProducts.length;
    resultsCountBadge.textContent = `${currentProducts.length} items`;

    if (currentProducts.length > 0) {
      exportExcelBtn.disabled = false;
      exportStatusText.textContent = `${currentProducts.length} filtered products ready for export`;
    } else {
      exportExcelBtn.disabled = true;
      exportStatusText.textContent = "0 products ready for export";
    }

    renderResultsTable(currentProducts);
  }

  function renderResultsTable(products) {
    if (!products || products.length === 0) {
      resultsTableBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">No extracted products with >4.0 rating yet. Enter a product name above to search & auto-extract.</td>
        </tr>
      `;
      return;
    }

    resultsTableBody.innerHTML = products
      .map((p) => {
        const name = escapeHtml(p.product_name);
        const price = escapeHtml(p.price);
        const type = escapeHtml(p.type);
        const rating = p.rating !== null ? p.rating.toFixed(1) : "N/A";
        const link = p.product_link;

        return `
          <tr>
            <td class="prod-name" title="${name}">${name}</td>
            <td class="prod-price">${price}</td>
            <td class="prod-type">${type}</td>
            <td><span class="rating-pill">${rating} ★</span></td>
            <td>
              <a href="${link}" target="_blank" class="prod-link-btn" title="Open product page">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </a>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Poll state from background on open
  chrome.runtime.sendMessage({ action: "GET_STATE" }, (state) => {
    updateUIState(state);
  });

  // Listen for real-time state changes in storage
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.extractionState) {
      updateUIState(changes.extractionState.newValue);
    }
  });
});
