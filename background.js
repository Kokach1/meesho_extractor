// Background Service Worker for Meesho Product Search & Rating Extractor (v5.0.0)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relay messages between popup and content script tabs
  if (message.action === "START_EXTRACTION_REQUEST" || message.action === "STOP_EXTRACTION_REQUEST") {
    const tabId = message.tabId;
    const contentAction = message.action === "START_EXTRACTION_REQUEST" ? "START_EXTRACTION" : "STOP_EXTRACTION";
    chrome.tabs.sendMessage(tabId, { action: contentAction }, (response) => {
      sendResponse(response);
    });
    return true;
  }

  // Forward extraction events to popup
  if (
    message.action === "EXTRACTION_PROGRESS" ||
    message.action === "EXTRACTION_COMPLETE" ||
    message.action === "EXTRACTION_STOPPED"
  ) {
    // Save state to storage for popup to poll
    const isExtracting = message.action === "EXTRACTION_PROGRESS";
    const completedMsg = message.action === "EXTRACTION_COMPLETE" ? "Completed" : message.action === "EXTRACTION_STOPPED" ? "Stopped" : message.progressMessage;

    chrome.storage.local.set({
      extractionState: {
        isExtracting,
        progressMessage: completedMsg,
        scannedCount: message.scannedCount || 0,
        totalMatching: (message.products || []).length,
        products: message.products || [],
        tabId: sender.tab ? sender.tab.id : null,
        error: null
      }
    });
  }

  if (message.action === "GET_STATE") {
    chrome.storage.local.get(["extractionState"], (res) => {
      sendResponse(res.extractionState || null);
    });
    return true;
  }
});

// Auto-trigger extraction when Meesho search page finishes loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    tab.url.includes("meesho.com/search")
  ) {
    chrome.storage.local.get(["autoStartExtraction"], (res) => {
      if (res.autoStartExtraction) {
        chrome.tabs.sendMessage(tabId, { action: "START_EXTRACTION" }).catch(() => {});
      }
    });
  }
});
