// Meesho search-page extractor. Supplier-code watermarks are read using
// Google Lens' text-selection mode.

(function () {
  if (window.__meeshoExtractorInjected) return;
  window.__meeshoExtractorInjected = true;

  const MIN_RATING_THRESHOLD = 4.0;
  const MAX_SCROLL_ATTEMPTS = 100;
  const NO_NEW_PRODUCTS_LIMIT = 3;
  const SCROLL_WAIT_MS = 1500;

  let isExtracting = false;
  let seenProductLinks = new Set();
  let filteredProducts = [];
  let totalScannedCount = 0;
  let noNewProductsAttempts = 0;
  let scrollAttempts = 0;

  chrome.storage.local.get(["autoStartExtraction"], ({ autoStartExtraction }) => {
    if (autoStartExtraction && location.href.includes("meesho.com/search")) {
      chrome.storage.local.set({ autoStartExtraction: false });
      setTimeout(() => !isExtracting && startExtractionLoop(), 1500);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "START_EXTRACTION") {
      if (!isExtracting) startExtractionLoop();
      sendResponse({ status: "started" });
      return true;
    }
    if (message.action === "STOP_EXTRACTION") {
      isExtracting = false;
      sendResponse({ status: "stopping" });
      return true;
    }
    if (message.action === "GET_EXTRACTION_STATUS") {
      sendResponse({ isExtracting, totalScannedCount, totalMatching: filteredProducts.length, products: filteredProducts });
      return true;
    }
  });

  async function startExtractionLoop() {
    isExtracting = true;
    seenProductLinks = new Set();
    filteredProducts = [];
    totalScannedCount = 0;
    noNewProductsAttempts = 0;
    scrollAttempts = 0;
    notifyProgress("Starting scan...");
    await sleep(1000);

    while (isExtracting) {
      const previousSeenCount = seenProductLinks.size;
      await scanProductCards();
      noNewProductsAttempts = seenProductLinks.size === previousSeenCount ? noNewProductsAttempts + 1 : 0;
      scrollAttempts += 1;

      if (!isExtracting || noNewProductsAttempts >= NO_NEW_PRODUCTS_LIMIT || scrollAttempts >= MAX_SCROLL_ATTEMPTS) break;

      window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: "smooth" });
      notifyProgress(
        noNewProductsAttempts
          ? `Waiting for more products... (${noNewProductsAttempts}/${NO_NEW_PRODUCTS_LIMIT})`
          : `Scanning... (${filteredProducts.length} matched so far)`,
      );
      await sleep(SCROLL_WAIT_MS);
    }

    if (isExtracting) notifyComplete();
    else notifyStopped();
    isExtracting = false;
  }

  async function scanProductCards() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));
    for (const anchor of anchors) {
      if (!isExtracting) break;
      const fullLink = normaliseProductLink(anchor.getAttribute("href"));
      if (!fullLink || seenProductLinks.has(fullLink)) continue;

      seenProductLinks.add(fullLink);
      totalScannedCount += 1;
      const productData = extractCardData(findProductCard(anchor), fullLink);
      if (!productData || productData.rating === null || productData.rating <= MIN_RATING_THRESHOLD) continue;

      notifyProgress(`Rating ${productData.rating}★ matched! Opening Google Lens...`);
      const imageUrls = await getProductImageUrls(fullLink);
      if (!isExtracting) break;

      productData.code = imageUrls.length ? await getCodeFromGoogleLens(imageUrls) : null;
      filteredProducts.push(productData);
      notifyProgress(`${filteredProducts.length} matched — latest code: ${productData.code || "not found"}`);
    }
  }

  function normaliseProductLink(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      url.search = "";
      url.hash = "";
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function findProductCard(anchor) {
    let element = anchor.parentElement;
    for (let depth = 0; depth < 7 && element; depth += 1, element = element.parentElement) {
      const text = element.innerText || "";
      if (text.includes("₹") && /\b[1-5](?:\.\d)?\b/.test(text)) return element;
    }
    return anchor;
  }

  function getProductImageUrls(productUrl) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "GET_PRODUCT_IMAGE_URLS", productUrl }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("[Meesho Extractor] Image retrieval error:", chrome.runtime.lastError.message);
          resolve([]);
          return;
        }
        resolve(Array.isArray(response) ? response.filter(Boolean) : []);
      });
    });
  }

  function getCodeFromGoogleLens(imageUrls) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "GET_CODE_FROM_GOOGLE_LENS", imageUrls }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("[Meesho Extractor] Google Lens error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(typeof response?.code === "string" && response.code ? response.code : null);
      });
    });
  }

  function extractCardData(card, productLink) {
    const rawText = card.innerText || "";
    const lines = rawText.split("\n").map((line) => line.trim()).filter(Boolean);
    const priceMatch = rawText.match(/₹\s*[\d,]+/);
    const ratingMatch = rawText.match(/\b([1-5](?:\.\d)?)\b(?=\s*(?:★|\(|$))/m) || rawText.match(/\b([1-5]\.\d)\b/);
    const rating = ratingMatch ? Number.parseFloat(ratingMatch[1]) : null;

    const nameElement = Array.from(card.querySelectorAll("p, h1, h2, h3")).find((element) => {
      const text = element.innerText?.trim() || "";
      return text.length > 3 && !text.includes("₹") && !/\b[1-5](?:\.\d)?\b/.test(text);
    });
    const productName = nameElement?.innerText?.trim() || lines.find((line) =>
      line.length > 3 && !line.includes("₹") && !line.includes("Free Delivery") && !/\b[1-5](?:\.\d)?\b/.test(line),
    ) || "Meesho Product";

    return {
      product_name: productName.replace(/\s+/g, " "),
      price: priceMatch ? priceMatch[0].replace(/\s+/g, "") : "N/A",
      type: "General",
      product_link: productLink,
      rating,
      code: null,
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function sendState(action, progressMessage) {
    chrome.runtime.sendMessage({ action, progressMessage, scannedCount: totalScannedCount, products: filteredProducts }).catch(() => {});
  }
  const notifyProgress = (message) => sendState("EXTRACTION_PROGRESS", message);
  const notifyComplete = () => sendState("EXTRACTION_COMPLETE", "Completed");
  const notifyStopped = () => sendState("EXTRACTION_STOPPED", "Stopped");

  console.log("[Meesho Extractor] Search content script loaded (Google Lens).");
})();
