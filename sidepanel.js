const $ = (s) => document.querySelector(s);
let activeChatId = null;

// --- Theme ---
function applyTheme(theme) {
  if (theme === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
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
  });
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

  // Ensure all chats have messages array
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

  // If last message is from user, a response is still being generated
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
  div.textContent = text;

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

  // Capture chatId at call time — activeChatId may change while awaiting
  const chatId = activeChatId;

  appendMessage("user", text);

  // Get history BEFORE saving the current message — Gemini must not see it twice
  const { chats = {} } = await chrome.storage.local.get("chats");
  const history = chats[chatId]?.messages || [];

  // Now persist the user message so navigating away doesn't lose it
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
    // Show error inline; storage listener won't fire since nothing was saved
    if (activeChatId === chatId) {
      removeLoading();
      appendMessage("model", `Error: ${response.error}`);
    }
  }
  // On success, the storage.onChanged listener detects the saved response and reloads
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

// Send button & Enter key
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

// Auto-resize textarea
$("#user-input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 100) + "px";
});

// --- Pick up pending fact-checks from storage ---
async function checkPendingFactCheck() {
  const { pendingFactCheck } = await chrome.storage.local.get("pendingFactCheck");
  if (pendingFactCheck) {
    await chrome.storage.local.remove("pendingFactCheck");
    // Clear the badge
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

// Listen for storage changes
chrome.storage.onChanged.addListener((changes) => {
  // New pending fact-check arrived
  if (changes.pendingFactCheck && changes.pendingFactCheck.newValue) {
    checkPendingFactCheck();
  }

  // Current chat's data was updated (e.g. response saved by background)
  if (changes.chats && activeChatId) {
    const updatedChats = changes.chats.newValue;
    if (!updatedChats) return;
    const chat = updatedChats[activeChatId];
    if (!chat) return;
    const messages = chat.messages || [];
    const lastMsg = messages[messages.length - 1];
    // If response just arrived (last message is now from model) and loading is showing
    if (lastMsg && lastMsg.role === "model" && $("#loading-msg")) {
      reloadMessages(activeChatId);
    }
  }
});

// --- Utils ---
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
initTheme();
renderChatList();
checkPendingFactCheck();
