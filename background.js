// Background service worker: retrieve real product-gallery images for local OCR.

const TAB_TIMEOUT_MS = 25000;
const HYDRATION_WAIT_MS = 1500;
const MAX_GALLERY_IMAGES = 3;

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

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageAsBase64(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
  return toBase64(await response.arrayBuffer());
}

async function getProductImagesByOpeningTab(productUrl) {
  let tab = null;
  try {
    console.log("[Meesho Extractor] Opening product tab:", productUrl);
    tab = await chrome.tabs.create({ url: productUrl, active: false });
    await waitForTabComplete(tab.id);
    await new Promise((resolve) => setTimeout(resolve, HYDRATION_WAIT_MS));

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const isProductImage = (url) =>
          /https:\/\/images\.meesho\.com\/images\/products\//i.test(url || "");
        const normalise = (rawUrl) => {
          try {
            const url = new URL(rawUrl);
            // Detail pages request 64px thumbnails. Request a useful OCR size instead.
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
            const inInitialGallery = box.top < window.innerHeight + 350;
            const visible = box.width > 0 && box.height > 0;
            return {
              src: normalise(src),
              score:
                (inInitialGallery ? 2_000_000 : 0) +
                (box.width >= 250 ? 1_000_000 : 0) +
                (visible ? 100_000 : 0) +
                Math.min(image.naturalWidth * image.naturalHeight, 1_000_000) +
                Math.min(Math.round(box.width * box.height), 500_000) -
                Math.max(0, Math.round(box.top)),
            };
          })
          // Exclude marketing banners, recommendation cards, and non-product CDN assets.
          .filter((item) => isProductImage(item.src))
          .sort((left, right) => right.score - left.score);

        const uniqueUrls = [];
        for (const item of candidates) {
          if (!uniqueUrls.includes(item.src)) uniqueUrls.push(item.src);
          if (uniqueUrls.length === 3) break;
        }

        const ogImage = document.querySelector('meta[property="og:image"], meta[name="og:image"]')?.content;
        if (isProductImage(ogImage)) {
          const url = normalise(ogImage);
          if (!uniqueUrls.includes(url)) uniqueUrls.unshift(url);
        }

        return uniqueUrls.slice(0, 3);
      },
    });

    const imageUrls = result?.[0]?.result || [];
    const images = [];
    for (const imageUrl of imageUrls.slice(0, MAX_GALLERY_IMAGES)) {
      try {
        images.push({ url: imageUrl, image: await fetchImageAsBase64(imageUrl) });
      } catch (error) {
        console.warn("[Meesho Extractor] Could not fetch gallery image:", error.message);
      }
    }
    return images;
  } catch (error) {
    console.error("[Meesho Extractor] Product image extraction failed:", error.message);
    return [];
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_) {
        // The tab may already have been closed by the browser.
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_PRODUCT_IMAGES") {
    getProductImagesByOpeningTab(message.productUrl).then(sendResponse).catch(() => sendResponse([]));
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
