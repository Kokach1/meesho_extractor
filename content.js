// Content Script for Meesho Product Rating Filter & Extractor with Gemini Vision API (v3.9.0)

(function () {
  // Prevent duplicate script injection
  if (window.__meeshoExtractorInjected) {
    return;
  }
  window.__meeshoExtractorInjected = true;

  let isExtracting = false;
  let seenProductLinks = new Set();
  let filteredProducts = [];
  let totalScannedCount = 0;
  let noNewProductsAttempts = 0;
  let scrollAttempts = 0;

  const MAX_SCROLL_ATTEMPTS = 100;
  const NO_NEW_PRODUCTS_LIMIT = 3;
  const SCROLL_WAIT_MS = 1500;
  const MIN_RATING_THRESHOLD = 4.0;
  const OCR_TIMEOUT_MS = 15000;
  const EASY_OCR_SERVICE_URL = "http://127.0.0.1:5000/ocr";

  // Auto-start check if triggered by extension search navigation
  chrome.storage.local.get(["autoStartExtraction"], (res) => {
    if (res && res.autoStartExtraction && window.location.href.includes("meesho.com/search")) {
      chrome.storage.local.set({ autoStartExtraction: false });
      setTimeout(() => {
        if (!isExtracting) {
          console.log("[Meesho Extractor v3.9.0] Auto-starting extraction on search page load...");
          startExtractionLoop();
        }
      }, 1200);
    }
  });

  // Listen for control messages from popup / background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "START_EXTRACTION") {
      if (!isExtracting) {
        startExtractionLoop();
      }
      sendResponse({ status: "started" });
      return true;
    }

    if (message.action === "STOP_EXTRACTION") {
      isExtracting = false;
      sendResponse({ status: "stopping" });
      return true;
    }

    if (message.action === "GET_EXTRACTION_STATUS") {
      sendResponse({
        isExtracting,
        totalScannedCount,
        totalMatching: filteredProducts.length,
        products: filteredProducts
      });
      return true;
    }
  });

  async function startExtractionLoop() {
    isExtracting = true;
    seenProductLinks.clear();
    filteredProducts = [];
    totalScannedCount = 0;
    noNewProductsAttempts = 0;
    scrollAttempts = 0;

    notifyProgress("Scanning products...");

    // Wait for initial page content to render
    await sleep(1000);

    while (isExtracting) {
      const initialSeenSize = seenProductLinks.size;

      // Scan currently visible products in DOM
      await scanProductCards();

      const newProductsFound = seenProductLinks.size - initialSeenSize;
      if (newProductsFound === 0) {
        noNewProductsAttempts++;
      } else {
        noNewProductsAttempts = 0;
      }

      scrollAttempts++;

      notifyProgress(
        noNewProductsAttempts > 0
          ? `Loading more products... (Attempt ${noNewProductsAttempts}/${NO_NEW_PRODUCTS_LIMIT})`
          : `Scanning products... (${filteredProducts.length} high-rated found)`
      );

      // Check termination conditions
      if (!isExtracting) {
        break;
      }

      if (noNewProductsAttempts >= NO_NEW_PRODUCTS_LIMIT) {
        console.log("[Meesho Extractor v3.9.0] No new products loaded after 3 scroll attempts. Stopping.");
        break;
      }

      if (scrollAttempts >= MAX_SCROLL_ATTEMPTS) {
        console.log("[Meesho Extractor v3.9.0] Reached maximum scroll limit (100). Stopping.");
        break;
      }

      // Check if we are near bottom of page
      const isAtBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;

      // Scroll incrementally down by ~85% of viewport height
      window.scrollBy({
        top: Math.floor(window.innerHeight * 0.85),
        behavior: "smooth"
      });

      if (isAtBottom) {
        noNewProductsAttempts++;
      }

      // Wait for dynamic React content to load
      await sleep(SCROLL_WAIT_MS);
    }

    const wasStoppedManually = !isExtracting;
    isExtracting = false;

    if (wasStoppedManually) {
      notifyStopped();
    } else {
      notifyComplete();
    }
  }

  async function scanProductCards() {
    // Find all anchor tags pointing to Meesho product details (/p/)
    const productAnchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));

    for (const anchor of productAnchors) {
      if (!isExtracting) break;

      try {
        const href = anchor.getAttribute("href");
        if (!href) continue;

        // Build absolute product URL
        const fullLink = href.startsWith("http") ? href : `https://www.meesho.com${href}`;

        // Deduplicate product cards by link
        if (seenProductLinks.has(fullLink)) {
          continue;
        }

        // Find product card container
        let cardElement = anchor;
        let parent = anchor.parentElement;
        let depth = 0;
        while (parent && depth < 5) {
          if (
            parent.querySelector('p, span[class*="price"], span[class*="rating"], [class*="ProductList"]') ||
            parent.innerText.includes("₹")
          ) {
            cardElement = parent;
            break;
          }
          parent = parent.parentElement;
          depth++;
        }

        // Increment total scanned count for every unique product card encountered
        seenProductLinks.add(fullLink);
        totalScannedCount++;

        // Extract basic product metadata
        const productData = extractCardData(cardElement, fullLink);

        // Filter condition: rating strictly > 4.0 out of 5
        if (
          productData &&
          productData.rating !== null &&
          !isNaN(productData.rating) &&
          productData.rating > MIN_RATING_THRESHOLD
        ) {
          console.log(`[Meesho Extractor v3.9.0] Rating ${productData.rating} > 4.0 for '${productData.product_name}'. Accessing product page for main high-res image...`);

          // Access product detail page inside browser & extract first high-resolution primary image URL
          const highResImageUrl = await fetchPrimaryImageFromProductPage(fullLink, cardElement);

          // Extract product code using Gemini Vision API on bottom 40px of high-res image
          const productCode = await extractProductCodeWithGemini(fullLink, highResImageUrl);
          productData.code = productCode; // String or null

          filteredProducts.push(productData);

          // Update progress live
          notifyProgress(`Scanning products... (${filteredProducts.length} high-rated found)`);
        }
      } catch (err) {
        console.error("Error processing product card:", err);
      }
    }
  }

  function extractCardData(cardEl, fullLink) {
    const rawText = cardEl.innerText || cardEl.textContent || "";
    const lines = rawText.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

    // 1. Extract Price
    let price = "N/A";
    const priceMatch = rawText.match(/₹\s*[\d,]+/);
    if (priceMatch) {
      price = priceMatch[0].replace(/\s+/g, "");
    } else {
      const priceEl = cardEl.querySelector('[class*="price"], [class*="Price"], h5, h4');
      if (priceEl && priceEl.innerText.includes("₹")) {
        price = priceEl.innerText.trim().replace(/\s+/g, "");
      }
    }

    // 2. Extract Rating (must be numeric float between 1.0 and 5.0)
    let rating = null;
    const ratingEl = cardEl.querySelector('[class*="rating"], [class*="Rating"], [class*="star"]');
    if (ratingEl) {
      const match = ratingEl.innerText.match(/\b([1-5]\.\d|[1-5])\b/);
      if (match) {
        rating = parseFloat(match[1]);
      }
    }

    if (rating === null) {
      const ratingMatch = rawText.match(/\b([1-5]\.\d)\b/);
      if (ratingMatch) {
        rating = parseFloat(ratingMatch[1]);
      }
    }

    // 3. Extract Product Name / Title
    let productName = "";
    const titleEl = cardEl.querySelector('p[class*="title"], p[class*="Name"], p[class*="Title"], p');
    if (titleEl && titleEl.innerText.trim().length > 3 && !titleEl.innerText.includes("₹")) {
      productName = titleEl.innerText.trim();
    } else {
      for (const line of lines) {
        if (!line.includes("₹") && !line.match(/\b[1-5]\.\d\b/) && line.length > 3 && !line.includes("Free Delivery")) {
          productName = line;
          break;
        }
      }
    }

    if (!productName) {
      productName = "Meesho Product";
    }

    productName = sanitizeText(productName);

    // 4. Extract Category / Type
    let type = "General";
    const subtextEl = cardEl.querySelector('span[class*="subtitle"], p[class*="sub"], span[class*="category"]');
    if (subtextEl && subtextEl.innerText.trim()) {
      type = sanitizeText(subtextEl.innerText);
    } else {
      const pageTitle = document.title || "";
      if (pageTitle.includes("Buy") && pageTitle.includes("Online")) {
        const parts = pageTitle.replace("Buy ", "").split(" Online")[0];
        if (parts && parts.length < 30) {
          type = sanitizeText(parts);
        }
      }
    }

    return {
      product_name: productName,
      price: price,
      type: type,
      product_link: fullLink,
      rating: rating,
      code: null // Default fallback
    };
  }

  /**
   * Access product detail page via browser fetch() and extract the primary high-res image URL
   */
  async function fetchPrimaryImageFromProductPage(productLink, cardEl) {
    // Catalog fallback image URL
    let fallbackSrc = "";
    const imgEl = cardEl.querySelector("img[src], img[data-src], img[srcset], img");
    if (imgEl) {
      fallbackSrc = imgEl.currentSrc || imgEl.src || imgEl.getAttribute("data-src") || imgEl.getAttribute("src") || "";
      if (fallbackSrc.startsWith("//")) fallbackSrc = "https:" + fallbackSrc;
      else if (fallbackSrc.startsWith("/")) fallbackSrc = "https://www.meesho.com" + fallbackSrc;
    }

    try {
      console.log(`[Meesho Extractor v3.9.0] Fetching detail page HTML: ${productLink}`);
      const resp = await fetch(productLink, { headers: { "Accept": "text/html" } });
      if (!resp.ok) return fallbackSrc;

      const htmlText = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, "text/html");

      // 1. Try og:image meta tag
      const ogMeta = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
      if (ogMeta && ogMeta.content && ogMeta.content.includes("images.meesho.com")) {
        console.log(`[Meesho Extractor v3.9.0] Extracted primary image from og:image: ${ogMeta.content}`);
        return ogMeta.content;
      }

      // 2. Try __NEXT_DATA__ script payload
      const nextScript = doc.querySelector('script[id="__NEXT_DATA__"]');
      if (nextScript && nextScript.textContent) {
        const matches = nextScript.textContent.match(/https:\/\/images\.meesho\.com\/images\/products\/[^\s"']+/g);
        if (matches && matches.length > 0) {
          console.log(`[Meesho Extractor v3.9.0] Extracted primary image from __NEXT_DATA__: ${matches[0]}`);
          return matches[0];
        }
      }

      // 3. Try main product gallery in DOM
      const mainImg = doc.querySelector('img[src*="images.meesho.com"]');
      if (mainImg && mainImg.src) {
        console.log(`[Meesho Extractor v3.9.0] Extracted primary image from DOM: ${mainImg.src}`);
        return mainImg.src;
      }

      return fallbackSrc;
    } catch (e) {
      console.warn("[Meesho Extractor v3.9.0] Product page fetch error, using catalog fallback:", e);
      return fallbackSrc;
    }
  }

  /**
   * Send high-res image URL to local server to crop bottom 40px and call Gemini Vision API
   */
  async function extractProductCodeWithGemini(productLink, imageUrl) {
    if (!imageUrl) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

    try {
      const response = await fetch(EASY_OCR_SERVICE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_link: productLink,
          image_url: imageUrl
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn("[Meesho Extractor] Gemini Vision OCR server returned non-200 HTTP status.");
        return null;
      }

      const data = await response.json();
      if (data && data.code) {
        console.log(`[Meesho Extractor v3.9.0] Gemini Vision Code Result: '${data.code}'`);
        return sanitizeCodeText(data.code);
      }
      return null;
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      console.warn("[Meesho Extractor] Gemini Vision service unavailable or timed out:", fetchErr.message);
      return null;
    }
  }

  function sanitizeCodeText(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length < 1) return null;
    return cleaned;
  }

  function sanitizeText(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function notifyProgress(msg) {
    chrome.runtime.sendMessage({
      action: "EXTRACTION_PROGRESS",
      progressMessage: msg,
      scannedCount: totalScannedCount,
      products: filteredProducts
    }).catch(() => {});
  }

  function notifyComplete() {
    chrome.runtime.sendMessage({
      action: "EXTRACTION_COMPLETE",
      scannedCount: totalScannedCount,
      products: filteredProducts
    }).catch(() => {});
  }

  function notifyStopped() {
    chrome.runtime.sendMessage({
      action: "EXTRACTION_STOPPED",
      scannedCount: totalScannedCount,
      products: filteredProducts
    }).catch(() => {});
  }
})();
