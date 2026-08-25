// Content Script for Meesho Product Rating Filter & Extractor v5.2.0
// For each product with rating > 4.0:
//   1. Asks background.js to OPEN A REAL PRODUCT TAB
//   2. Background extracts live-rendered product image URL from DOM
//   3. Content script fetches image, crops bottom 80px, sends to Gemini Vision
//   4. Returns the s-code (e.g. s-452654917) for Excel export

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
  const GEMINI_API_URL =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  // Prompt specifically tuned for Meesho bottom-of-image product codes
  const GEMINI_PROMPT =
    "This is the bottom strip of a Meesho product image. " +
    "There is a product code printed at the bottom-left corner in small white or dark text, " +
    "typically formatted like 's-452654917' (letter 's' followed by a dash and digits). " +
    "Extract ONLY that code and return it exactly as printed. " +
    "Do not explain. Do not add any other words. " +
    "If you cannot see any such code, return the single word: null";

  // ── Auto-start ─────────────────────────────────────────────────────────────
  chrome.storage.local.get(["autoStartExtraction"], (res) => {
    if (
      res &&
      res.autoStartExtraction &&
      window.location.href.includes("meesho.com/search")
    ) {
      chrome.storage.local.set({ autoStartExtraction: false });
      setTimeout(() => {
        if (!isExtracting) startExtractionLoop();
      }, 1500);
    }
  });

  // ── Message Listener ────────────────────────────────────────────────────────
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
      sendResponse({
        isExtracting,
        totalScannedCount,
        totalMatching: filteredProducts.length,
        products: filteredProducts,
      });
      return true;
    }
  });

  // ── Main Extraction Loop ────────────────────────────────────────────────────
  async function startExtractionLoop() {
    isExtracting = true;
    seenProductLinks.clear();
    filteredProducts = [];
    totalScannedCount = 0;
    noNewProductsAttempts = 0;
    scrollAttempts = 0;

    notifyProgress("Starting scan...");
    await sleep(1000);

    while (isExtracting) {
      const prevSize = seenProductLinks.size;
      await scanProductCards();

      if (seenProductLinks.size === prevSize) noNewProductsAttempts++;
      else noNewProductsAttempts = 0;

      scrollAttempts++;

      if (
        !isExtracting ||
        noNewProductsAttempts >= NO_NEW_PRODUCTS_LIMIT ||
        scrollAttempts >= MAX_SCROLL_ATTEMPTS
      )
        break;

      window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: "smooth" });
      notifyProgress(
        noNewProductsAttempts > 0
          ? `Waiting for more products... (${noNewProductsAttempts}/${NO_NEW_PRODUCTS_LIMIT})`
          : `Scanning... (${filteredProducts.length} matched so far)`
      );
      await sleep(SCROLL_WAIT_MS);
    }

    if (isExtracting) notifyComplete();
    else notifyStopped();
    isExtracting = false;
  }

  // ── Scan Visible Product Cards ──────────────────────────────────────────────
  async function scanProductCards() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));

    for (const anchor of anchors) {
      if (!isExtracting) break;

      const href = anchor.getAttribute("href");
      if (!href) continue;
      const fullLink = href.startsWith("http")
        ? href
        : `https://www.meesho.com${href}`;
      if (seenProductLinks.has(fullLink)) continue;

      // Find card container element
      let cardEl = anchor;
      let p = anchor.parentElement;
      for (let d = 0; d < 6 && p; d++, p = p.parentElement) {
        if (p.innerText && p.innerText.includes("₹")) {
          cardEl = p;
          break;
        }
      }

      seenProductLinks.add(fullLink);
      totalScannedCount++;

      const productData = extractCardData(cardEl, fullLink);
      if (
        !productData ||
        productData.rating === null ||
        isNaN(productData.rating) ||
        productData.rating <= MIN_RATING_THRESHOLD
      )
        continue;

      console.log(
        `[v5.2.0] ✅ Match: rating ${productData.rating}★ → ${fullLink}`
      );
      notifyProgress(
        `Rating ${productData.rating}★ matched! Opening product page for code...`
      );

      // Ask background to open a real tab, get image URL, close tab
      const imageUrl = await getProductImageUrlViaTab(fullLink);

      if (!imageUrl) {
        console.warn(`[v5.2.0] No image URL returned for: ${fullLink}`);
        productData.code = null;
      } else {
        console.log(`[v5.2.0] Got image URL: ${imageUrl}`);
        notifyProgress(`Fetching image & running Gemini OCR...`);

        const b64 = await fetchImageBottomAsBase64(imageUrl);
        if (!b64) {
          console.warn(`[v5.2.0] Image fetch/crop failed for: ${imageUrl}`);
          productData.code = null;
        } else {
          const apiKey = await getApiKey();
          if (!apiKey) {
            productData.code = null;
          } else {
            productData.code = await callGeminiVision(apiKey, b64);
            console.log(`[v5.2.0] Code extracted: ${productData.code}`);
          }
        }
      }

      filteredProducts.push(productData);
      notifyProgress(
        `${filteredProducts.length} matched — latest code: ${productData.code || "null"}`
      );
    }
  }

  // ── Ask Background to Open Real Product Tab ─────────────────────────────────
  function getProductImageUrlViaTab(productUrl) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "GET_PRODUCT_IMAGE_URL", productUrl },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("[v5.2.0] Background message error:", chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response || null);
          }
        }
      );
    });
  }

  // ── Fetch Image & Crop Bottom 80px as Base64 ────────────────────────────────
  async function fetchImageBottomAsBase64(imgUrl) {
    try {
      console.log(`[v5.2.0] Fetching image for bottom crop: ${imgUrl}`);

      // Use extension fetch() — host_permissions cover *.meesho.com
      const resp = await fetch(imgUrl);
      if (!resp.ok) {
        console.warn(`[v5.2.0] Image HTTP ${resp.status}: ${imgUrl}`);
        return null;
      }

      const arrayBuffer = await resp.arrayBuffer();
      const mimeType = resp.headers.get("content-type") || "image/jpeg";
      const blob = new Blob([arrayBuffer], { type: mimeType });

      // Use Blob URL — avoids CORS canvas taint entirely
      const objectUrl = URL.createObjectURL(blob);

      return new Promise((resolve) => {
        const img = new Image();

        img.onload = () => {
          try {
            const W = img.naturalWidth;
            const H = img.naturalHeight;

            if (!W || !H) {
              URL.revokeObjectURL(objectUrl);
              return resolve(null);
            }

            // Crop the bottom 80 pixels (where product codes are printed)
            const canvas = document.createElement("canvas");
            const cropH = Math.min(80, H);
            const srcY = H - cropH;
            canvas.width = W;
            canvas.height = cropH;

            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, srcY, W, cropH, 0, 0, W, cropH);

            URL.revokeObjectURL(objectUrl);

            const dataUrl = canvas.toDataURL("image/png");
            console.log(
              `[v5.2.0] Cropped bottom ${cropH}px of ${W}×${H} image ✓`
            );
            resolve(dataUrl.split(",")[1]);
          } catch (e) {
            URL.revokeObjectURL(objectUrl);
            console.error("[v5.2.0] Canvas error:", e.message);
            resolve(null);
          }
        };

        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          console.warn("[v5.2.0] Blob image render failed.");
          resolve(null);
        };

        img.src = objectUrl;
      });
    } catch (err) {
      console.error("[v5.2.0] fetchImageBottomAsBase64 error:", err.message);
      return null;
    }
  }

  // ── Gemini Vision API ───────────────────────────────────────────────────────
  async function callGeminiVision(apiKey, b64Image) {
    try {
      const url = `${GEMINI_API_URL}?key=${apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: GEMINI_PROMPT },
                {
                  inline_data: {
                    mime_type: "image/png",
                    data: b64Image,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 50,
          },
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.warn(
          `[v5.2.0] Gemini HTTP ${resp.status}: ${errText.slice(0, 200)}`
        );
        return null;
      }

      const data = await resp.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return sanitize(raw);
    } catch (err) {
      console.error("[v5.2.0] Gemini error:", err.message);
      return null;
    }
  }

  function sanitize(text) {
    if (!text) return null;
    let s = text
      .replace(/```/g, "")
      .replace(/`/g, "")
      .replace(/\n/g, " ")
      .trim();

    // Strip common preambles
    const prefixes = [
      "the code is:",
      "code:",
      "extracted code:",
      "extracted text:",
      "text:",
    ];
    const lower = s.toLowerCase();
    for (const p of prefixes) {
      if (lower.startsWith(p)) {
        s = s.slice(p.length).trim();
        break;
      }
    }

    const nullWords = [
      "null",
      "null.",
      "none",
      "none.",
      "n/a",
      "no code",
      "no text",
      "no visible code",
      "no visible text",
      "no readable",
      "not visible",
      "cannot see",
      "i cannot",
    ];
    if (nullWords.includes(s.toLowerCase()) || s.length === 0) return null;
    return s;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  async function getApiKey() {
    return new Promise((r) =>
      chrome.storage.local.get(["geminiApiKey"], (res) => r(res.geminiApiKey))
    );
  }

  function extractCardData(cardEl, fullLink) {
    const rawText = cardEl.innerText || "";
    const lines = rawText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    let price = "N/A";
    const pm = rawText.match(/₹\s*[\d,]+/);
    if (pm) price = pm[0].replace(/\s+/g, "");

    let rating = null;
    const re = cardEl.querySelector(
      '[class*="rating"], [class*="Rating"], [class*="star"]'
    );
    if (re) {
      const m = re.innerText.match(/\b([1-5]\.\d|[1-5])\b/);
      if (m) rating = parseFloat(m[1]);
    }
    if (rating === null) {
      const rm = rawText.match(/\b([1-5]\.\d)\b/);
      if (rm) rating = parseFloat(rm[1]);
    }

    let productName = "";
    const te = cardEl.querySelector("p");
    if (te && !te.innerText.includes("₹") && te.innerText.trim().length > 3)
      productName = te.innerText.trim();
    if (!productName) {
      for (const line of lines) {
        if (
          !line.includes("₹") &&
          !line.match(/\b[1-5]\.\d\b/) &&
          line.length > 3 &&
          !line.includes("Free Delivery")
        ) {
          productName = line;
          break;
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

    return {
      product_name: productName.trim().replace(/\s+/g, " "),
      price,
      type,
      product_link: fullLink,
      rating,
      code: null,
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function notifyProgress(msg) {
    chrome.runtime
      .sendMessage({
        action: "EXTRACTION_PROGRESS",
        progressMessage: msg,
        scannedCount: totalScannedCount,
        products: filteredProducts,
      })
      .catch(() => {});
  }
  function notifyComplete() {
    chrome.runtime
      .sendMessage({
        action: "EXTRACTION_COMPLETE",
        scannedCount: totalScannedCount,
        products: filteredProducts,
      })
      .catch(() => {});
  }
  function notifyStopped() {
    chrome.runtime
      .sendMessage({
        action: "EXTRACTION_STOPPED",
        scannedCount: totalScannedCount,
        products: filteredProducts,
      })
      .catch(() => {});
  }

  console.log(
    "[Meesho Extractor v5.2.0] Loaded. Opens real product tabs via background.js for image extraction."
  );
})();
