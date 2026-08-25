// Content Script for Meesho Product Rating Filter & Extractor with Bottom 40px Image OCR

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
  const OCR_TIMEOUT_MS = 3000;

  // Auto-start check if triggered by extension search navigation
  chrome.storage.local.get(["autoStartExtraction"], (res) => {
    if (res && res.autoStartExtraction && window.location.href.includes("meesho.com/search")) {
      chrome.storage.local.set({ autoStartExtraction: false });
      setTimeout(() => {
        if (!isExtracting) {
          console.log("Auto-starting product extraction on search load...");
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
        console.log("No new products loaded after 3 scroll attempts. Stopping.");
        break;
      }

      if (scrollAttempts >= MAX_SCROLL_ATTEMPTS) {
        console.log("Reached maximum scroll limit (100). Stopping.");
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
          // Perform bottom 40px image cropping & OCR for product code extraction
          const productCode = await extractProductCodeFromCard(cardElement);
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
   * Crop bottom 40 pixels of product image and run OCR with 3-second timeout
   */
  async function extractProductCodeFromCard(cardEl) {
    return new Promise((resolve) => {
      let isSettled = false;

      const safeResolve = (val) => {
        if (!isSettled) {
          isSettled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          resolve(val);
        }
      };

      // Strict 3-second timeout requirement
      const timeoutTimer = setTimeout(() => {
        safeResolve(null);
      }, OCR_TIMEOUT_MS);

      try {
        const imgEl = cardEl.querySelector("img[src], img[srcset], img[data-src]");
        if (!imgEl) {
          return safeResolve(null);
        }

        const imgSrc = imgEl.getAttribute("data-src") || imgEl.src;
        if (!imgSrc || imgSrc.startsWith("data:image/svg")) {
          return safeResolve(null);
        }

        const img = new Image();
        img.crossOrigin = "anonymous";

        img.onload = async () => {
          try {
            if (!img.naturalWidth || !img.naturalHeight) {
              return safeResolve(null);
            }

            // Create Canvas & Crop bottom 40 pixels
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");

            const cropHeight = Math.min(40, img.naturalHeight);
            const sourceY = Math.max(0, img.naturalHeight - cropHeight);

            canvas.width = img.naturalWidth;
            canvas.height = cropHeight;

            ctx.drawImage(
              img,
              0, sourceY, img.naturalWidth, cropHeight,
              0, 0, img.naturalWidth, cropHeight
            );

            const croppedDataUrl = canvas.toDataURL("image/png");

            // Run OCR if Tesseract library is loaded
            if (typeof Tesseract !== "undefined" && Tesseract.recognize) {
              const res = await Tesseract.recognize(croppedDataUrl, "eng");
              if (res && res.data && res.data.text) {
                const text = sanitizeCodeText(res.data.text);
                return safeResolve(text ? text : null);
              }
            }
            safeResolve(null);
          } catch (e) {
            safeResolve(null);
          }
        };

        img.onerror = () => safeResolve(null);
        img.src = imgSrc;
      } catch (err) {
        safeResolve(null);
      }
    });
  }

  function sanitizeCodeText(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length < 2) return null;
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
