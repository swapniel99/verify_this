chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "open-panel") {
    chrome.runtime.sendMessage({ type: "do-open-panel", tabId: message.tabId });
    sendResponse({ ok: true });
  }
});
