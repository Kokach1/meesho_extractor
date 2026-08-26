// Background service worker: select product-gallery images and read their
// supplier-code watermark through Google Lens' "Select text" mode.

const TAB_TIMEOUT_MS = 30000;
const HYDRATION_WAIT_MS = 1500;
const LENS_WAIT_MS = 3500;
const MAX_GALLERY_IMAGES = 3;
const WATERMARK_LEFT_FRACTION = 0.6;
const WATERMARK_TOP_FRACTION = 0.74;
const WATERMARK_SCALE = 4;

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
  const cropX = 0;
  const cropY = Math.floor(bitmap.height * WATERMARK_TOP_FRACTION);
  const cropWidth = Math.max(1, Math.floor(bitmap.width * WATERMARK_LEFT_FRACTION));
  const cropHeight = Math.max(1, bitmap.height - cropY);
  const canvas = new OffscreenCanvas(cropWidth * WATERMARK_SCALE, cropHeight * WATERMARK_SCALE);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    cropX, cropY, cropWidth, cropHeight,
    0, 0, canvas.width, canvas.height,
  );
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return {
    imageBase64: toBase64(await png.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
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
          const sleepInPage = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const findCode = (text) => {
            const match = String(text || "").match(/(?:^|[^a-z0-9])s\s*[-_–—]?\s*(\d{6,12})(?=$|[^a-z0-9])/i);
            return match ? `s-${match[1]}` : null;
          };
          const pageText = () => document.body?.innerText || "";
          if (/captcha|unusual traffic|not a robot/i.test(pageText())) {
            return { code: null, error: "Google Lens requested a CAPTCHA" };
          }

          // Lens exposes optical text inside the image only after "Select text" is activated.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const target = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
              .find((element) => element.textContent?.trim().toLowerCase() === "select text");
            if (target) {
              (target.closest('button, [role="button"], a') || target).click();
              break;
            }
            await sleepInPage(500);
          }
          await sleepInPage(800);

          // Try clicking "Select all text" if available to highlight all image text
          const selectAllBtn = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
            .find((element) => /select all text/i.test(element.textContent?.trim() || ""));
          if (selectAllBtn) {
            (selectAllBtn.closest('button, [role="button"], a') || selectAllBtn).click();
            await sleepInPage(600);
          }

          // Extract text detected specifically inside the image
          const getImageText = () => {
            // 1. Current text selection in Lens image pane
            const sel = window.getSelection()?.toString()?.trim();
            if (sel && sel.length > 0 && !/select text|copy text|translate|search/i.test(sel)) {
              return sel;
            }

            // 2. Specific Lens OCR text overlay elements
            const ocrEls = Array.from(
              document.querySelectorAll('[data-text], [data-string], .gws-lens-panes__text-region, [role="region"] span, .c2miie, .V4v0ee, .y24T4d')
            );
            if (ocrEls.length > 0) {
              const texts = ocrEls
                .map((el) => (el.getAttribute("data-text") || el.getAttribute("data-string") || el.innerText || "").trim())
                .filter((t) => t.length > 0 && !/select text|copy text|translate|search|feedback/i.test(t));
              if (texts.length > 0) {
                return Array.from(new Set(texts)).join(" ");
              }
            }

            // 3. Fallback: filter page innerText to strip Google UI noise
            const raw = document.body?.innerText || "";
            const noiseWords = [
              "google", "lens", "search", "select text", "copy text", "listen", "translate",
              "feedback", "share", "send to computer", "select all text", "visual matches",
              "exact matches", "ai overview", "add to your search", "show original",
              "about this page", "edit visual search", "privacy", "terms"
            ];
            const lines = raw
              .split("\n")
              .map((l) => l.trim())
              .filter((line) => {
                if (!line || line.length < 1) return false;
                const lower = line.toLowerCase();
                return !noiseWords.some((w) => lower === w || lower.startsWith(w + " ") || lower.endsWith(" " + w));
              });
            return lines.join(" ").trim() || null;
          };

          const imageText = getImageText();
          const isolatedCode = findCode(imageText || pageText());

          return {
            code: isolatedCode,
            extractedText: imageText,
            error: null,
          };
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
