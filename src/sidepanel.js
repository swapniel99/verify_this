import { marked } from "marked";

const $ = (s) => document.querySelector(s);
let activeChatId = null;

// Configure marked
marked.setOptions({
  gfm: true,
  breaks: true,
});

// --- Theme ---
function applyTheme(theme) {
  if (theme === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

async function initTheme() {
  const { theme = "system" } = await chrome.storage.local.get("theme");
  applyTheme(theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
    const { theme = "system" } = await chrome.storage.local.get("theme");
    if (theme === "system") applyTheme("system");
  });
}

document.querySelectorAll(".theme-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.theme;
    chrome.storage.local.set({ theme });
    applyTheme(theme);
    document.querySelectorAll(".theme-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === theme);
    });
  });
});

$("#btn-theme").addEventListener("click", async () => {
  const { theme = "system" } = await chrome.storage.local.get("theme");
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const nextTheme = isDark ? "light" : "dark";
  chrome.storage.local.set({ theme: nextTheme });
  applyTheme(nextTheme);
});

// --- Navigation ---
function showView(view) {
  ["chat-list-view", "chat-view", "settings-view"].forEach((id) => {
    $(`#${id}`).classList.add("hidden");
  });
  $(`#${view}`).classList.remove("hidden");

  const isChat = view === "chat-view";
  $("#btn-back").classList.toggle("hidden", !isChat && view !== "settings-view");
  $("#header-title").textContent =
    view === "settings-view" ? "Settings" : isChat ? "Fact Check" : "Verify This";
}

$("#btn-back").addEventListener("click", () => {
  activeChatId = null;
  showView("chat-list-view");
  renderChatList();
});

$("#btn-settings").addEventListener("click", async () => {
  const { geminiApiKey = "" } = await chrome.storage.local.get("geminiApiKey");
  $("#api-key-input").value = geminiApiKey;
  const { theme = "system" } = await chrome.storage.local.get("theme");
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
  const { groundingEnabled = false } = await chrome.storage.local.get("groundingEnabled");
  $("#grounding-toggle").checked = groundingEnabled;
  showView("settings-view");
});

$("#btn-save-key").addEventListener("click", () => {
  const key = $("#api-key-input").value.trim();
  chrome.storage.local.set({ geminiApiKey: key });
  showView("chat-list-view");
  renderChatList();
});

// --- Chat List ---
async function renderChatList() {
  const { chats = {} } = await chrome.storage.local.get("chats");
  const list = $("#chat-list");

  Object.values(chats).forEach((chat) => {
    if (!chat.messages) chat.messages = [];
  });
  await chrome.storage.local.set({ chats });

  const sorted = Object.values(chats).sort((a, b) => b.createdAt - a.createdAt);

  if (sorted.length === 0) {
    list.innerHTML = "";
    $("#empty-state").classList.remove("hidden");
    return;
  }

  $("#empty-state").classList.add("hidden");
  list.innerHTML = sorted
    .map(
      (chat) => `
    <div class="chat-item" data-id="${chat.id}">
      <div class="chat-item-content">
        <div class="chat-item-title">${escapeHtml(chat.title)}</div>
        <div class="chat-item-date">${new Date(chat.createdAt).toLocaleDateString()}</div>
      </div>
      <button class="chat-item-delete" data-id="${chat.id}" title="Delete">✕</button>
    </div>
  `
    )
    .join("");

  list.querySelectorAll(".chat-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("chat-item-delete")) return;
      openChat(el.dataset.id);
    });
  });

  list.querySelectorAll(".chat-item-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { chats = {} } = await chrome.storage.local.get("chats");
      delete chats[btn.dataset.id];
      await chrome.storage.local.set({ chats });
      renderChatList();
    });
  });
}

// --- Chat ---
async function openChat(chatId) {
  activeChatId = chatId;
  showView("chat-view");
  const { chats = {} } = await chrome.storage.local.get("chats");
  const chat = chats[chatId];
  if (!chat) return;

  const messagesEl = $("#messages");
  messagesEl.innerHTML = "";

  const messages = chat.messages || [];
  for (const msg of messages) {
    appendMessage(msg.role, msg.text, msg.sources);
  }

  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === "user") {
    showLoading();
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessage(role, text, sources) {
  const messagesEl = $("#messages");
  const div = document.createElement("div");
  div.className = `message ${role}`;
  
  // Use marked to parse markdown
  if (role === 'model') {
    div.innerHTML = marked.parse(text);
    // Ensure links open in new tab
    div.querySelectorAll('a').forEach(a => a.target = '_blank');
  } else {
    div.textContent = text;
  }

  if (sources && sources.length > 0) {
    const srcDiv = document.createElement("div");
    srcDiv.className = "sources";
    srcDiv.innerHTML =
      "<strong>Sources:</strong>" +
      sources.map((s) => `<a href="${escapeHtml(s.url)}" target="_blank">${escapeHtml(s.title || s.url)}</a>`).join("");
    div.appendChild(srcDiv);
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function showLoading() {
  const div = document.createElement("div");
  div.className = "message model loading-dots";
  div.id = "loading-msg";
  $("#messages").appendChild(div);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function removeLoading() {
  const el = $("#loading-msg");
  if (el) el.remove();
}

async function sendMessage(text) {
  if (!text.trim() || !activeChatId) return;

  const chatId = activeChatId;

  appendMessage("user", text);

  const { chats = {} } = await chrome.storage.local.get("chats");
  const history = chats[chatId]?.messages || [];

  if (chats[chatId]) {
    if (!chats[chatId].messages) chats[chatId].messages = [];
    chats[chatId].messages.push({ role: "user", text, timestamp: Date.now() });
    await chrome.storage.local.set({ chats });
  }

  showLoading();

  const response = await chrome.runtime.sendMessage({
    type: "call-gemini",
    chatId,
    text,
    history,
  });

  if (response.error) {
    if (activeChatId === chatId) {
      removeLoading();
      appendMessage("model", `Error: ${response.error}`);
    }
  }
}

async function reloadMessages(chatId) {
  const { chats = {} } = await chrome.storage.local.get("chats");
  const chat = chats[chatId];
  if (!chat) return;
  const messagesEl = $("#messages");
  messagesEl.innerHTML = "";
  for (const msg of (chat.messages || [])) {
    appendMessage(msg.role, msg.text, msg.sources);
  }
}

$("#btn-send").addEventListener("click", () => {
  const input = $("#user-input");
  sendMessage(input.value);
  input.value = "";
  input.style.height = "auto";
});

$("#user-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#btn-send").click();
  }
});

$("#user-input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 100) + "px";
});

$("#grounding-toggle").addEventListener("change", () => {
  chrome.storage.local.set({ groundingEnabled: $("#grounding-toggle").checked });
});

async function checkPendingFactCheck() {
  const { pendingFactCheck } = await chrome.storage.local.get("pendingFactCheck");
  if (pendingFactCheck) {
    await chrome.storage.local.remove("pendingFactCheck");
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.action.setBadgeText({ text: "", tabId: tabs[0].id });
    }
    activeChatId = pendingFactCheck.chatId;
    showView("chat-view");
    $("#messages").innerHTML = "";
    sendMessage(`Fact-check this claim: "${pendingFactCheck.text}"\n\nSource: ${pendingFactCheck.sourceUrl}`);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.pendingFactCheck && changes.pendingFactCheck.newValue) {
    checkPendingFactCheck();
  }

  if (changes.chats && activeChatId) {
    const updatedChats = changes.chats.newValue;
    if (!updatedChats) return;
    const chat = updatedChats[activeChatId];
    if (!chat) return;
    const messages = chat.messages || [];
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "model" && $("#loading-msg")) {
      reloadMessages(activeChatId);
    }
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

initTheme();
renderChatList();
checkPendingFactCheck();
