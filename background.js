// Background Service Worker v5.2.0
// Handles opening product tabs, extracting image URLs from live DOM, closing tabs

const TAB_TIMEOUT_MS = 15000; // Max time to wait for product page to load

// ── Tab Image Extraction ────────────────────────────────────────────────────────
async function getProductImageUrlByOpeningTab(productUrl) {
  let tab = null;
  let timeoutId = null;

  try {
    console.log(`[BG v5.2.0] Opening product tab: ${productUrl}`);
    tab = await chrome.tabs.create({ url: productUrl, active: false });

    // Wait for page to fully load (or timeout)
    await new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tab load timeout after ${TAB_TIMEOUT_MS}ms`));
      }, TAB_TIMEOUT_MS);

      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeoutId);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // Extra wait for React/Next.js hydration and image rendering
    await new Promise((r) => setTimeout(r, 2000));

    // Inject script into the loaded product tab to extract the primary image URL
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Priority 1: Find the biggest rendered product image on page
        // (the main image gallery on Meesho uses Meesho CDN URLs)
        const allImgs = Array.from(
          document.querySelectorAll('img[src*="images.meesho.com"]')
        );

        // Score images: prefer larger natural size, prefer /images/products/ path
        const scored = allImgs
          .map((img) => {
            const src = img.src || "";
            let score = 0;
            if (src.includes("/images/products/")) score += 100;
            score += (img.naturalWidth || 0) + (img.naturalHeight || 0);
            return { src, score };
          })
          .filter((x) => x.src && x.score > 100)
          .sort((a, b) => b.score - a.score);

        if (scored.length > 0) return scored[0].src;

        // Priority 2: Try __NEXT_DATA__ embedded JSON
        const nextEl = document.getElementById("__NEXT_DATA__");
        if (nextEl) {
          const matches = nextEl.textContent.match(
            /https:\/\/images\.meesho\.com\/images\/products\/[^\s"'\\]+/g
          );
          if (matches && matches.length > 0) {
            // Prefer higher res (no small suffix)
            const best = matches
              .filter((u) => !u.includes("_128") && !u.includes("_80"))
              .concat(matches)[0];
            return best;
          }
        }

        // Priority 3: og:image meta
        const og = document.querySelector(
          'meta[property="og:image"], meta[name="og:image"]'
        );
        if (og && og.content && og.content.includes("meesho.com")) {
          return og.content;
        }

        return null;
      },
    });

    const imageUrl = results?.[0]?.result;
    console.log(`[BG v5.2.0] Extracted image URL from live DOM: ${imageUrl}`);
    return imageUrl || null;

  } catch (err) {
    console.error(`[BG v5.2.0] Tab extraction error: ${err.message}`);
    return null;
  } finally {
    // Always close the product tab
    if (tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
        console.log(`[BG v5.2.0] Closed product tab ${tab.id}`);
      } catch (_) {}
    }
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── Message Listener ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Open product page tab and return its primary image URL ──
  if (message.action === "GET_PRODUCT_IMAGE_URL") {
    getProductImageUrlByOpeningTab(message.productUrl)
      .then((url) => sendResponse(url))
      .catch(() => sendResponse(null));
    return true; // Keep channel open for async response
  }

  // ── Relay start/stop between popup and content script ──
  if (
    message.action === "START_EXTRACTION_REQUEST" ||
    message.action === "STOP_EXTRACTION_REQUEST"
  ) {
    const contentAction =
      message.action === "START_EXTRACTION_REQUEST"
        ? "START_EXTRACTION"
        : "STOP_EXTRACTION";
    chrome.tabs
      .sendMessage(message.tabId, { action: contentAction })
      .then((response) => sendResponse(response))
      .catch(() => sendResponse(null));
    return true;
  }

  // ── Forward extraction state updates to storage for popup polling ──
  if (
    message.action === "EXTRACTION_PROGRESS" ||
    message.action === "EXTRACTION_COMPLETE" ||
    message.action === "EXTRACTION_STOPPED"
  ) {
    const isExtracting = message.action === "EXTRACTION_PROGRESS";
    chrome.storage.local.set({
      extractionState: {
        isExtracting,
        progressMessage:
          message.action === "EXTRACTION_COMPLETE"
            ? "Completed"
            : message.action === "EXTRACTION_STOPPED"
            ? "Stopped"
            : message.progressMessage,
        scannedCount: message.scannedCount || 0,
        totalMatching: (message.products || []).length,
        products: message.products || [],
        tabId: sender.tab ? sender.tab.id : null,
        error: null,
      },
    });
  }

  if (message.action === "GET_STATE") {
    chrome.storage.local.get(["extractionState"], (res) => {
      sendResponse(res.extractionState || null);
    });
    return true;
  }
});

// ── Auto-trigger extraction on search page load ─────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    tab.url.includes("meesho.com/search")
  ) {
    chrome.storage.local.get(["autoStartExtraction"], (res) => {
      if (res.autoStartExtraction) {
        chrome.storage.local.set({ autoStartExtraction: false });
        chrome.tabs.sendMessage(tabId, { action: "START_EXTRACTION" }).catch(() => {});
      }
    });
  }
});
