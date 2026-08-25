// Background service worker for Meesho Product Extractor Extension

const DEFAULT_STATE = {
  isExtracting: false,
  progressMessage: "Ready",
  scannedCount: 0,
  totalMatching: 0,
  products: [],
  tabId: null,
  error: null
};

// Initialize extension storage on installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    extractionState: DEFAULT_STATE,
    autoStartExtraction: false
  });
});

// Watch tab updates to trigger auto-extraction after search navigation completes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.includes("meesho.com/search")) {
    chrome.storage.local.get(["autoStartExtraction"], async (res) => {
      if (res.autoStartExtraction) {
        console.log("Auto-starting extraction for tab:", tabId);
        // Clear flag to avoid re-triggering on manual reloads
        await chrome.storage.local.set({ autoStartExtraction: false });
        
        // Wait briefly for Meesho React DOM hydration
        await new Promise(r => setTimeout(r, 1200));
        handleStartExtraction(tabId);
      }
    });
  }
});

// Relay message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_STATE") {
    chrome.storage.local.get("extractionState", (res) => {
      sendResponse(res.extractionState || DEFAULT_STATE);
    });
    return true; // async response
  }

  if (message.action === "START_EXTRACTION_REQUEST") {
    handleStartExtraction(message.tabId).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  if (message.action === "STOP_EXTRACTION_REQUEST") {
    handleStopExtraction(message.tabId).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  if (message.action === "EXTRACTION_PROGRESS") {
    const newState = {
      isExtracting: true,
      progressMessage: message.progressMessage || "Scanning products...",
      scannedCount: message.scannedCount || 0,
      totalMatching: message.products ? message.products.length : 0,
      products: message.products || [],
      tabId: sender.tab ? sender.tab.id : null,
      error: null
    };
    chrome.storage.local.set({ extractionState: newState });
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "EXTRACTION_COMPLETE") {
    const newState = {
      isExtracting: false,
      progressMessage: "Completed",
      scannedCount: message.scannedCount || 0,
      totalMatching: message.products ? message.products.length : 0,
      products: message.products || [],
      tabId: sender.tab ? sender.tab.id : null,
      error: null
    };
    chrome.storage.local.set({ extractionState: newState });
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "EXTRACTION_STOPPED") {
    chrome.storage.local.get("extractionState", (res) => {
      const currentState = res.extractionState || DEFAULT_STATE;
      const newState = {
        ...currentState,
        isExtracting: false,
        progressMessage: "Stopped by user",
        products: message.products || currentState.products || [],
        scannedCount: message.scannedCount || currentState.scannedCount || 0,
        totalMatching: message.products ? message.products.length : (currentState.products ? currentState.products.length : 0)
      };
      chrome.storage.local.set({ extractionState: newState });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === "RESET_STATE") {
    chrome.storage.local.set({ extractionState: DEFAULT_STATE, autoStartExtraction: false }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

async function handleStartExtraction(tabId) {
  try {
    const initialState = {
      ...DEFAULT_STATE,
      isExtracting: true,
      progressMessage: "Scanning products...",
      tabId: tabId
    };
    await chrome.storage.local.set({ extractionState: initialState });

    try {
      await chrome.tabs.sendMessage(tabId, { action: "START_EXTRACTION" });
    } catch (err) {
      console.log("Injecting content script into tab", tabId);
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["content.js"]
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await chrome.tabs.sendMessage(tabId, { action: "START_EXTRACTION" });
    }

    return { success: true };
  } catch (err) {
    console.error("Failed to start extraction:", err);
    const errorState = {
      ...DEFAULT_STATE,
      isExtracting: false,
      progressMessage: "Error starting extraction",
      error: err.message
    };
    await chrome.storage.local.set({ extractionState: errorState });
    return { success: false, error: err.message };
  }
}

async function handleStopExtraction(tabId) {
  try {
    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, { action: "STOP_EXTRACTION" });
      } catch (e) {
        console.log("Could not send stop message to tab", e);
      }
    }
    chrome.storage.local.get("extractionState", (res) => {
      const currentState = res.extractionState || DEFAULT_STATE;
      const newState = {
        ...currentState,
        isExtracting: false,
        progressMessage: "Stopped by user"
      };
      chrome.storage.local.set({ extractionState: newState });
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
