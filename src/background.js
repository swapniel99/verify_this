import { GoogleGenAI } from "@google/genai";

const SYSTEM_INSTRUCTION = `You are a fact-checking assistant. When given a claim or piece of text, verify its accuracy.

IMPORTANT: Focus on the latest available information and recent events whenever appropriate. If the claim relates to current events, breaking news, or rapidly evolving topics, prioritize up-to-date sources over historical data.

Provide:
1. A clear verdict (True / False / Partially True / Unverifiable)
2. A brief explanation with evidence, highlighting the most recent developments
3. Key sources that support or refute the claim (if available)

Be concise but thorough. If the user asks follow-up questions, answer them in context of the original fact-check.`;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "verify-this",
    title: "Verify This",
    contexts: ["selection"],
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.log("Failed to open side panel:", err);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "verify-this" && info.selectionText) {
    const chatId = `chat_${Date.now()}`;
    const chat = {
      id: chatId,
      title: info.selectionText.slice(0, 80),
      sourceUrl: tab.url,
      messages: [],
      createdAt: Date.now(),
    };

    const { chats = {} } = await chrome.storage.local.get("chats");
    chats[chatId] = chat;
    await chrome.storage.local.set({ chats });

    await chrome.storage.local.set({
      pendingFactCheck: {
        chatId,
        text: info.selectionText,
        sourceUrl: tab.url,
      },
    });

    // Use content script as intermediary to open side panel
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "open-panel", tabId: tab.id });
    } catch (err) {
      console.log("Content script not available, trying direct open");
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch (err2) {
        console.log("sidePanel.open failed, showing badge");
        chrome.action.setBadgeText({ text: "1", tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: "#4285f4" });
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "call-gemini") {
    callGemini(message.chatId, message.text, message.history)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === "do-open-panel") {
    chrome.sidePanel.open({ tabId: message.tabId }).catch((err) => {
      console.log("Failed to open side panel:", err);
    });
  }
});

async function callGemini(chatId, userMessage, history) {
  const { geminiApiKey, groundingEnabled = false } = await chrome.storage.local.get(["geminiApiKey", "groundingEnabled"]);
  if (!geminiApiKey) {
    return { error: "API key not set. Please set your Gemini API key in settings." };
  }

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const now = new Date().toLocaleString("en-US", { 
    timeZoneName: "short",
    year: "numeric", 
    month: "long", 
    day: "numeric", 
    hour: "2-digit", 
    minute: "2-digit" 
  });

  const config = {
    systemInstruction: `${SYSTEM_INSTRUCTION}\n\nCurrent local time: ${now}`,
  };

  // Add grounding tool if enabled
  if (groundingEnabled) {
    config.tools = [{ googleSearch: {} }];
  }

  const chat = ai.chats.create({
    model: "gemini-3.1-flash-lite-preview",
    config,
    history: history.map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.text }],
    })),
  });

  const response = await chat.sendMessage({ message: userMessage });

  const text = response.text;

  const sources =
    response.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.filter((c) => c.web)
      ?.map((c) => ({ title: c.web.title, url: c.web.uri })) || [];

  // Save model response to chat history (user message is saved by frontend)
  const { chats = {} } = await chrome.storage.local.get("chats");
  if (chats[chatId]) {
    if (!chats[chatId].messages) {
      chats[chatId].messages = [];
    }
    chats[chatId].messages.push({
      role: "model",
      text: text || "No response",
      sources,
      timestamp: Date.now(),
    });
    await chrome.storage.local.set({ chats });
  }

  return { text, sources };
}
