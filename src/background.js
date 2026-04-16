import { GoogleGenAI } from "@google/genai";

const SYSTEM_INSTRUCTION = `You are a fact-checking assistant. When given a claim or piece of text, verify its accuracy using grounded search results. Provide:
1. A clear verdict (True / False / Partially True / Unverifiable)
2. A brief explanation with evidence from sources
3. Key sources that support or refute the claim

Be concise but thorough. If the user asks follow-up questions, answer them in context of the original fact-check.`;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "verify-this",
    title: "Verify This",
    contexts: ["selection"],
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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

    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "call-gemini") {
    callGemini(message.chatId, message.text, message.history)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function callGemini(chatId, userMessage, history) {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (!geminiApiKey) {
    return { error: "API key not set. Please set your Gemini API key in settings." };
  }

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const chat = ai.chats.create({
    model: "gemini-3.1-flash-lite-preview",
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
    },
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

  // Save to chat history
  const { chats = {} } = await chrome.storage.local.get("chats");
  if (chats[chatId]) {
    chats[chatId].messages.push(
      { role: "user", text: userMessage, timestamp: Date.now() },
      { role: "model", text: text || "No response", sources, timestamp: Date.now() }
    );
    await chrome.storage.local.set({ chats });
  }

  return { text, sources };
}
