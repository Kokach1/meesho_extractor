// Content Script for Meesho Product Rating Filter & Extractor v5.0.0
// Calls Gemini Vision API directly from the browser — no Python server needed!

(function () {
  if (window.__meeshoExtractorInjected) return;
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
  const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  const GEMINI_PROMPT =
    "Look at this product image. Find the code, product ID, SKU, or any text printed at the BOTTOM of the image. " +
    "Return ONLY that code/text — nothing else. If nothing is visible at the bottom, return null.";

  // Auto-start check if triggered by extension search navigation
  chrome.storage.local.get(["autoStartExtraction"], (res) => {
    if (res && res.autoStartExtraction && window.location.href.includes("meesho.com/search")) {
      chrome.storage.local.set({ autoStartExtraction: false });
      setTimeout(() => {
        if (!isExtracting) {
          console.log("[Meesho Extractor v5.0.0] Auto-starting extraction...");
          startExtractionLoop();
        }
      }, 1200);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    seenProductLinks.clear();
    filteredProducts = [];
    totalScannedCount = 0;
    noNewProductsAttempts = 0;
    scrollAttempts = 0;

    notifyProgress("Scanning products...");
    await sleep(1000);

    while (isExtracting) {
      const prevSize = seenProductLinks.size;
      await scanProductCards();

      if (seenProductLinks.size - prevSize === 0) noNewProductsAttempts++;
      else noNewProductsAttempts = 0;

      scrollAttempts++;
      notifyProgress(
        noNewProductsAttempts > 0
          ? `Loading more... (${noNewProductsAttempts}/${NO_NEW_PRODUCTS_LIMIT})`
          : `Scanning... (${filteredProducts.length} matched so far)`
      );

      if (!isExtracting || noNewProductsAttempts >= NO_NEW_PRODUCTS_LIMIT || scrollAttempts >= MAX_SCROLL_ATTEMPTS) break;

      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
      window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: "smooth" });
      if (atBottom) noNewProductsAttempts++;

      await sleep(SCROLL_WAIT_MS);
    }

    isExtracting ? notifyComplete() : notifyStopped();
    isExtracting = false;
  }

  async function scanProductCards() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));

    for (const anchor of anchors) {
      if (!isExtracting) break;

      const href = anchor.getAttribute("href");
      if (!href) continue;
      const fullLink = href.startsWith("http") ? href : `https://www.meesho.com${href}`;
      if (seenProductLinks.has(fullLink)) continue;

      // Find card container
      let cardEl = anchor;
      let p = anchor.parentElement;
      for (let d = 0; d < 5 && p; d++, p = p.parentElement) {
        if (p.querySelector('p, span') || p.innerText.includes("₹")) { cardEl = p; break; }
      }

      seenProductLinks.add(fullLink);
      totalScannedCount++;

      const productData = extractCardData(cardEl, fullLink);
      if (!productData || productData.rating === null || isNaN(productData.rating) || productData.rating <= MIN_RATING_THRESHOLD) continue;

      console.log(`[v5.0.0] Match: rating=${productData.rating} → opening product page for code extraction: ${fullLink}`);
      notifyProgress(`Found match (${productData.rating}★). Fetching product page...`);

      // Open product page, get best image URL, crop bottom, call Gemini
      const code = await extractCodeFromProductPage(fullLink, cardEl);
      productData.code = code;
      filteredProducts.push(productData);
      notifyProgress(`Scanning... (${filteredProducts.length} matched — code: ${code || "null"})`);
    }
  }

  async function extractCodeFromProductPage(productLink, cardEl) {
    // Get Gemini API key from storage
    const apiKey = await new Promise((r) => chrome.storage.local.get(["geminiApiKey"], (res) => r(res.geminiApiKey)));
    if (!apiKey) {
      console.warn("[v5.0.0] No Gemini API key configured. Open the extension popup and enter your key.");
      return null;
    }

    try {
      // Open product detail page in browser (has session cookies, bypasses 403)
      console.log(`[v5.0.0] Opening product page: ${productLink}`);
      const pageResp = await fetch(productLink, {
        headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
      });
      if (!pageResp.ok) {
        console.warn(`[v5.0.0] Product page returned HTTP ${pageResp.status}. Using catalog fallback image.`);
        return await extractCodeFromCardImage(cardEl, apiKey);
      }

      const html = await pageResp.text();

      // Extract best available high-res image URL from page HTML
      const imageUrl = extractBestImageUrlFromHtml(html, cardEl);
      if (!imageUrl) {
        console.warn("[v5.0.0] No image URL found in product page. Trying catalog fallback.");
        return await extractCodeFromCardImage(cardEl, apiKey);
      }

      console.log(`[v5.0.0] Primary high-res image URL: ${imageUrl}`);

      // Fetch image and convert to base64 for Gemini
      const b64Image = await fetchImageAsBase64(imageUrl);
      if (!b64Image) {
        console.warn("[v5.0.0] Could not load image. Trying catalog fallback.");
        return await extractCodeFromCardImage(cardEl, apiKey);
      }

      // Call Gemini Vision with FULL image
      return await callGeminiVision(apiKey, b64Image);

    } catch (err) {
      console.error("[v5.0.0] Product page extraction error:", err.message);
      return await extractCodeFromCardImage(cardEl, apiKey);
    }
  }

  function extractBestImageUrlFromHtml(html, cardEl) {
    // Strategy 1: images.meesho.com URLs in __NEXT_DATA__ (sorted by resolution suffix)
    const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      const urls = nextDataMatch[1].match(/https:\/\/images\.meesho\.com\/images\/products\/[^\s"'\\]+/g);
      if (urls && urls.length > 0) {
        const scored = urls.sort((a, b) => imgScore(b) - imgScore(a));
        return scored[0];
      }
    }

    // Strategy 2: og:image meta tag
    const ogMatch = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch && ogMatch[1].includes("meesho.com")) return ogMatch[1];

    // Strategy 3: Any meesho image URL in raw HTML
    const rawMatch = html.match(/https:\/\/images\.meesho\.com\/images\/products\/[^\s"'\\]+/);
    if (rawMatch) return rawMatch[0];

    // Strategy 4: Catalog thumbnail from DOM card
    const imgEl = cardEl.querySelector("img[src], img[data-src]");
    if (imgEl) {
      let src = imgEl.currentSrc || imgEl.src || imgEl.getAttribute("data-src") || "";
      if (src.startsWith("//")) src = "https:" + src;
      if (src && !src.startsWith("data:image/svg")) return src;
    }

    return null;
  }

  function imgScore(url) {
    if (url.includes("_1024")) return 5;
    if (url.includes("_512")) return 4;
    if (url.includes("_256")) return 3;
    if (url.includes("_128")) return 2;
    if (url.includes("_80")) return 1;
    return 3; // No suffix = assume medium/high
  }

  async function extractCodeFromCardImage(cardEl, apiKey) {
    const imgEl = cardEl.querySelector("img[src], img[data-src]");
    if (!imgEl) return null;
    let src = imgEl.currentSrc || imgEl.src || imgEl.getAttribute("data-src") || "";
    if (src.startsWith("//")) src = "https:" + src;
    if (!src || src.startsWith("data:image/svg")) return null;
    const b64 = await fetchImageAsBase64(src);
    if (!b64) return null;
    return await callGeminiVision(apiKey, b64);
  }

  // Fetch an image URL and return it as base64 PNG (crops bottom 80px for focus)
  async function fetchImageAsBase64(imgUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";

      img.onload = () => {
        try {
          const W = img.naturalWidth;
          const H = img.naturalHeight;
          if (!W || !H) return resolve(null);

          // Crop bottom 80px (more generous than 40px for code region)
          const canvas = document.createElement("canvas");
          const cropH = Math.min(80, H);
          const srcY = H - cropH;
          canvas.width = W;
          canvas.height = cropH;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, srcY, W, cropH, 0, 0, W, cropH);

          // Return as base64 PNG without data: prefix
          const dataUrl = canvas.toDataURL("image/png");
          resolve(dataUrl.split(",")[1]);
        } catch (e) {
          resolve(null);
        }
      };

      img.onerror = () => resolve(null);
      img.src = imgUrl;
    });
  }

  async function callGeminiVision(apiKey, b64Image) {
    try {
      const url = `${GEMINI_API_URL}?key=${apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: GEMINI_PROMPT },
              { inline_data: { mime_type: "image/png", data: b64Image } }
            ]
          }]
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.warn(`[v5.0.0] Gemini API returned HTTP ${resp.status}: ${err.slice(0, 200)}`);
        return null;
      }

      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return sanitizeGeminiOutput(rawText);
    } catch (err) {
      console.error("[v5.0.0] Gemini Vision API error:", err.message);
      return null;
    }
  }

  function sanitizeGeminiOutput(text) {
    if (!text) return null;
    let cleaned = text.replace(/```/g, "").replace(/`/g, "").trim();

    const prefixes = ["the code is:", "code:", "extracted code:", "text:", "extracted text:", "visible text:", "the text is:"];
    const lower = cleaned.toLowerCase();
    for (const p of prefixes) {
      if (lower.startsWith(p)) { cleaned = cleaned.slice(p.length).trim(); break; }
    }

    const nullVariants = ["null", "null.", "none", "none.", "n/a", "no code", "no readable text", "no text", "no visible code", "no visible text"];
    if (nullVariants.includes(cleaned.toLowerCase()) || cleaned.length === 0) return null;
    return cleaned;
  }

  function extractCardData(cardEl, fullLink) {
    const rawText = cardEl.innerText || "";
    const lines = rawText.split("\n").map(s => s.trim()).filter(Boolean);

    let price = "N/A";
    const pm = rawText.match(/₹\s*[\d,]+/);
    if (pm) price = pm[0].replace(/\s+/g, "");

    let rating = null;
    const re = cardEl.querySelector('[class*="rating"], [class*="Rating"], [class*="star"]');
    if (re) { const m = re.innerText.match(/\b([1-5]\.\d|[1-5])\b/); if (m) rating = parseFloat(m[1]); }
    if (rating === null) { const rm = rawText.match(/\b([1-5]\.\d)\b/); if (rm) rating = parseFloat(rm[1]); }

    let productName = "";
    const te = cardEl.querySelector('p[class*="title"], p[class*="Name"], p');
    if (te && te.innerText.trim().length > 3 && !te.innerText.includes("₹")) productName = te.innerText.trim();
    if (!productName) {
      for (const line of lines) {
        if (!line.includes("₹") && !line.match(/\b[1-5]\.\d\b/) && line.length > 3 && !line.includes("Free Delivery")) {
          productName = line; break;
        }
      }
    }
    if (!productName) productName = "Meesho Product";

    let type = "General";
    const pt = document.title || "";
    if (pt.includes("Buy") && pt.includes("Online")) {
      const t = pt.replace("Buy ", "").split(" Online")[0];
      if (t && t.length < 30) type = t.trim();
    }

    return { product_name: productName.trim().replace(/\s+/g, " "), price, type, product_link: fullLink, rating, code: null };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function notifyProgress(msg) {
    chrome.runtime.sendMessage({ action: "EXTRACTION_PROGRESS", progressMessage: msg, scannedCount: totalScannedCount, products: filteredProducts }).catch(() => {});
  }
  function notifyComplete() {
    chrome.runtime.sendMessage({ action: "EXTRACTION_COMPLETE", scannedCount: totalScannedCount, products: filteredProducts }).catch(() => {});
  }
  function notifyStopped() {
    chrome.runtime.sendMessage({ action: "EXTRACTION_STOPPED", scannedCount: totalScannedCount, products: filteredProducts }).catch(() => {});
  }

  console.log("[Meesho Extractor v5.0.0] Loaded. Direct Gemini Vision (no server required).");
})();
