// Background service worker v5.9.0: select product-gallery images and read their
// supplier-code watermark through Google Lens' "Select text" mode.

const TAB_TIMEOUT_MS = 30000;
const HYDRATION_WAIT_MS = 1500;
const LENS_WAIT_MS = 4000;
const MAX_GALLERY_IMAGES = 3;

// Watermark is always at the BOTTOM-LEFT corner of the product image.
// Based on a 588px tall reference image, the watermark occupies ~204px wide × 40px tall.
// That maps to roughly the left 38% width and bottom 7% of the image height.
// We crop EXACTLY that region and scale it up 6× for clear OCR.
const WATERMARK_WIDTH_FRACTION  = 0.38;  // left 38% of image width
const WATERMARK_HEIGHT_FRACTION = 0.08;  // bottom 8% of image height (covers ~47px in a 588px image)
const WATERMARK_SCALE = 6;               // scale up heavily for Google Lens OCR clarity

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function cropWatermarkForLens(imageUrl) {
  const response = await fetch(imageUrl, { credentials: "omit" });
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);

  const bitmap = await createImageBitmap(await response.blob());
  const W = bitmap.width;
  const H = bitmap.height;

  // Crop precisely: bottom-left region only
  const cropW = Math.max(1, Math.floor(W * WATERMARK_WIDTH_FRACTION));
  const cropH = Math.max(1, Math.floor(H * WATERMARK_HEIGHT_FRACTION));
  const cropX = 0;
  const cropY = H - cropH;

  // Scale up heavily so Google Lens can read the small text clearly
  const outW = cropW * WATERMARK_SCALE;
  const outH = cropH * WATERMARK_SCALE;

  const canvas = new OffscreenCanvas(outW, outH);
  const context = canvas.getContext("2d");
  // White background so transparent PNGs don't go dark
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outW, outH);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
  bitmap.close();

  const png = await canvas.convertToBlob({ type: "image/png" });
  return {
    imageBase64: toBase64(await png.arrayBuffer()),
    width: outW,
    height: outH,
  };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      callback(value);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish(resolve);
    };
    const timeoutId = setTimeout(
      () => finish(reject, new Error(`Tab load timeout after ${TAB_TIMEOUT_MS}ms`)),
      TAB_TIMEOUT_MS,
    );
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getProductImageUrlsByOpeningTab(productUrl) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: productUrl, active: false });
    await waitForTabComplete(tab.id);
    await sleep(HYDRATION_WAIT_MS);

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const isProductImage = (url) =>
          /https:\/\/images\.meesho\.com\/images\/products\//i.test(url || "");
        const normalise = (rawUrl) => {
          try {
            const url = new URL(rawUrl);
            url.pathname = url.pathname.replace(/_\d+(?=\.[a-z0-9]+$)/i, "_512");
            url.searchParams.set("width", "512");
            return url.href;
          } catch (_) {
            return rawUrl;
          }
        };

        const candidates = Array.from(document.images)
          .map((image) => {
            const src = image.currentSrc || image.src || "";
            const box = image.getBoundingClientRect();
            return {
              src: normalise(src),
              score:
                (box.top < window.innerHeight + 350 ? 2_000_000 : 0) +
                (box.width >= 250 ? 1_000_000 : 0) +
                (box.width > 0 && box.height > 0 ? 100_000 : 0) +
                Math.min(image.naturalWidth * image.naturalHeight, 1_000_000) -
                Math.max(0, Math.round(box.top)),
            };
          })
          .filter((item) => isProductImage(item.src))
          .sort((left, right) => right.score - left.score);

        const imageUrls = [];
        for (const candidate of candidates) {
          if (!imageUrls.includes(candidate.src)) imageUrls.push(candidate.src);
          if (imageUrls.length === 3) break;
        }
        const ogImage = document.querySelector('meta[property="og:image"], meta[name="og:image"]')?.content;
        if (isProductImage(ogImage)) {
          const url = normalise(ogImage);
          if (!imageUrls.includes(url)) imageUrls.unshift(url);
        }
        return imageUrls.slice(0, 3);
      },
    });
    return result?.[0]?.result || [];
  } catch (error) {
    console.error("[Meesho Extractor] Product image lookup failed:", error.message);
    return [];
  } finally {
    if (tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

async function getCodeFromGoogleLens(imageUrls) {
  for (const imageUrl of imageUrls.slice(0, MAX_GALLERY_IMAGES)) {
    let tab = null;
    try {
      // Lens should see only the lower-left supplier-code watermark, not the
      // product, title artwork, or any text elsewhere in the gallery image.
      const watermark = await cropWatermarkForLens(imageUrl);
      tab = await chrome.tabs.create({ url: "https://lens.google.com/", active: false });
      await waitForTabComplete(tab.id);

      // Lens' documented web flow supports uploading an image. Create the same
      // multipart form in its page so the cropped PNG, rather than the whole
      // product image, becomes the Lens input.
      const uploadComplete = waitForTabComplete(tab.id);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [watermark.imageBase64, watermark.width, watermark.height],
        func: (imageBase64, width, height) => {
          const binary = atob(imageBase64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

          const form = document.createElement("form");
          form.action = `https://lens.google.com/upload?ep=gisbubb&st=${Date.now()}`;
          form.method = "post";
          form.enctype = "multipart/form-data";

          const fileInput = document.createElement("input");
          fileInput.type = "file";
          fileInput.name = "encoded_image";
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Blob([bytes], { type: "image/png" })], "meesho-supplier-code.png", { type: "image/png" }));
          fileInput.files = transfer.files;

          const dimensions = document.createElement("input");
          dimensions.type = "hidden";
          dimensions.name = "processed_image_dimensions";
          dimensions.value = `${width},${height}`;

          form.append(fileInput, dimensions);
          document.body.append(form);
          form.submit();
        },
      });
      await uploadComplete;
      await sleep(LENS_WAIT_MS);
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const sleepInPage = (ms) => new Promise((r) => setTimeout(r, ms));

          // ---- CAPTCHA guard ----
          if (/captcha|unusual traffic|not a robot/i.test(document.body?.innerText || "")) {
            return { code: null, extractedText: null, error: "Google Lens CAPTCHA" };
          }

          // ---- Helper: extract real s-code from a string ----
          const findCode = (text) => {
            if (!text) return null;
            const s = String(text);
            // Primary: s- or S- prefix followed by 6-12 digits
            const m1 = s.match(/(?:^|\s|[^a-zA-Z0-9])[sS]\s*[-–—_.·]?\s*(\d{6,12})(?=[^0-9]|$)/);
            if (m1) return `s-${m1[1]}`;
            // Secondary: OCR misread of 's' as '1.' e.g. "1.7021.1.462"
            const m2 = s.match(/(?:^|\s)1[._](\d[\d._]{4,11})(?=[^0-9]|$)/);
            if (m2) {
              const digits = m2[1].replace(/\D/g, "");
              if (digits.length >= 5 && digits.length <= 11) return `s-1${digits}`;
            }
            return null;
          };

          // ---- Wait for page to fully render Lens results ----
          // Google Lens now redirects to google.com/search?vsrid=... where
          // the OCR output appears in the AI Overview and page text — no "Select text" needed.
          await sleepInPage(2000);

          // ---- Read full page text ----
          const fullText = document.body?.innerText || "";

          // ---- Extract the code from anywhere in the page ----
          // The AI Overview text already contains the supplier code recognised in the image,
          // e.g. "The image shows a product code or SKU number (s-594370800)"
          const isolatedCode = findCode(fullText);

          // ---- Build a clean "Lens output" summary ----
          // Grab just the first few meaningful lines (AI Overview + image label near thumbnail)
          const lensOutput = (() => {
            // Try to get the text shown in the image card area / query label
            const queryInputs = Array.from(document.querySelectorAll('input[aria-label], textarea[aria-label], [role="combobox"] input'));
            for (const inp of queryInputs) {
              const val = (inp.value || inp.getAttribute("aria-label") || "").trim();
              if (val && val.length > 1 && !/^(search|google)/i.test(val)) return val;
            }

            // Fallback: grab first paragraph-like text on the page that contains a code
            const lines = fullText.split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 4 && !/^(google|sign in|settings|search)/i.test(l));

            // Prefer any line that contains our supplier code pattern
            const codeLine = lines.find((l) => findCode(l));
            if (codeLine) return codeLine;

            // Otherwise return first 3 non-trivial lines joined
            return lines.slice(0, 3).join(" ") || null;
          })();

          return { code: isolatedCode, extractedText: lensOutput, error: null };
        },
      });
      const response = result?.[0]?.result;
      if (response?.code || response?.extractedText) {
        return {
          code: response.code || null,
          extractedText: response.extractedText || null,
          error: null,
        };
      }
      if (response?.error) return response;
    } catch (error) {
      console.warn("[Meesho Extractor] Google Lens request failed:", error.message);
    } finally {
      if (tab?.id) {
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
      }
    }
  }
  return { code: null, extractedText: null, error: null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_PRODUCT_IMAGE_URLS") {
    getProductImageUrlsByOpeningTab(message.productUrl).then(sendResponse).catch(() => sendResponse([]));
    return true;
  }
  if (message.action === "GET_CODE_FROM_GOOGLE_LENS") {
    getCodeFromGoogleLens(message.imageUrls || []).then(sendResponse).catch(() => sendResponse({ code: null, extractedText: null }));
    return true;
  }
  if (message.action === "START_EXTRACTION_REQUEST" || message.action === "STOP_EXTRACTION_REQUEST") {
    const action = message.action === "START_EXTRACTION_REQUEST" ? "START_EXTRACTION" : "STOP_EXTRACTION";
    chrome.tabs.sendMessage(message.tabId, { action }).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (["EXTRACTION_PROGRESS", "EXTRACTION_COMPLETE", "EXTRACTION_STOPPED"].includes(message.action)) {
    chrome.storage.local.set({
      extractionState: {
        isExtracting: message.action === "EXTRACTION_PROGRESS",
        progressMessage: message.action === "EXTRACTION_COMPLETE" ? "Completed" : message.action === "EXTRACTION_STOPPED" ? "Stopped" : message.progressMessage,
        scannedCount: message.scannedCount || 0,
        totalMatching: (message.products || []).length,
        products: message.products || [],
        tabId: sender.tab?.id || null,
        error: null,
      },
    });
  }
  if (message.action === "GET_STATE") {
    chrome.storage.local.get(["extractionState"], (result) => sendResponse(result.extractionState || null));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url?.includes("meesho.com/search")) return;
  chrome.storage.local.get(["autoStartExtraction"], ({ autoStartExtraction }) => {
    if (!autoStartExtraction) return;
    chrome.storage.local.set({ autoStartExtraction: false });
    chrome.tabs.sendMessage(tabId, { action: "START_EXTRACTION" }).catch(() => {});
  });
});
