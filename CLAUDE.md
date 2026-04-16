# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Build the extension (bundles src/background.js and src/sidepanel.js):**
```bash
pnpm build
```

**Watch mode (auto-rebuild on changes):**
```bash
pnpm watch
```

**Load extension in Chrome:**
1. Open `chrome://extensions/`
2. Enable "Developer mode" (top-right)
3. Click "Load unpacked"
4. Select the project root directory

After making changes, reload the extension in Chrome to see them.

## Architecture

**Three-tier extension architecture:**

1. **Service Worker** (`src/background.js` → bundled as `background.js`)
   - Handles context menu creation and clicks
   - Manages Gemini API calls
   - Persists chat messages to Chrome storage
   - Coordinates with content script to open the side panel

2. **Side Panel UI** (`sidepanel.html`, `src/sidepanel.js` → bundled as `sidepanel.js`)
   - Displays chat list, chat view, and settings
   - Manages theme (light/dark/system)
   - Handles message sending and rendering (uses `marked` for markdown)
   - Synchronizes with background via `chrome.storage.onChanged` reactive updates

3. **Content Script** (`src/content.js` → bundled as `content.js`)
   - Minimal relay between background and page context
   - Required for sidePanel.open() to work (user gesture requirement)

### Data Flow: Context Menu Click → Fact Check Response

```
1. User highlights text → right-click "Verify This"
2. background.js creates new chat in chrome.storage.local
3. background.js sends message to content.js to relay sidePanel.open()
4. Side panel opens; sidepanel.js detects pendingFactCheck in storage
5. User clicks "Send" in side panel
6. sidepanel.js sends call-gemini message to background.js
7. background.js calls Gemini API with chat history
8. Response saved to chat.messages in storage with sources
9. storage.onChanged listener in sidepanel.js detects update and reloads UI
```

## Chrome Storage Schema

All data lives in `chrome.storage.local` (sync-safe, no quota limits):

```javascript
{
  chats: {
    "chat_1234567890": {
      id: "chat_1234567890",
      title: "First 80 chars of selected text",
      sourceUrl: "https://example.com",
      createdAt: 1712345678901,
      messages: [
        { role: "user", text: "...", timestamp: ... },
        { role: "model", text: "...", sources: [...], timestamp: ... }
      ]
    }
  },
  geminiApiKey: "sk-...",
  groundingEnabled: false,
  theme: "system" | "light" | "dark",
  pendingFactCheck: { chatId: "...", text: "...", sourceUrl: "..." } // temp
}
```

## Gemini API Integration

**Model:** `gemini-3.1-flash-lite-preview`

**System instruction:** Instructs model to fact-check with verdict, explanation, and sources.

**Grounding (optional):** If `groundingEnabled: true` in storage, adds `tools: [{ googleSearch: {} }]` to API config. Requires paid Gemini tier. Extracts sources from `response.candidates[0].groundingMetadata.groundingChunks`.

**Key files:**
- API calls: `src/background.js` → `callGemini()` function
- SDK: `@google/genai` (v1.50.1)

## Key Development Patterns

**Message passing between service worker and side panel:**
- Service worker listens: `chrome.runtime.onMessage.addListener()`
- Side panel sends: `chrome.runtime.sendMessage()`
- Return `true` from listener to keep channel open for `sendResponse()`

**Storage watchers:**
- Side panel uses `chrome.storage.onChanged` listener to detect updates (e.g., when background saves a response) and reloads the UI automatically.
- Polling is not required.

**DOM utilities:**
- `const $ = (s) => document.querySelector(s)` — shorthand for selectors in sidepanel.js
- `escapeHtml()` prevents XSS when rendering user-selected text and URLs

**Theme system:**
- Stored as "system", "light", or "dark" in storage
- Applied via `data-theme` attribute on `<html>`
- CSS variables `--bg-primary`, `--text-primary`, etc. handle light/dark
- System theme watches `(prefers-color-scheme: dark)` media query

## Important Files

| File | Purpose |
|------|---------|
| `src/background.js` | Service worker—Gemini API calls, storage, context menu |
| `src/sidepanel.js` | UI source code—messaging, markdown rendering, theme |
| `src/content.js` | Minimal content script for sidePanel.open() relay |
| `sidepanel.html` | HTML structure (chat list, chat view, settings) |
| `sidepanel.css` | Styling and light/dark theme variables |
| `manifest.json` | Extension config (permissions, background worker, content scripts) |
| `package.json` | Dependencies (`@google/genai`, `esbuild`), build scripts |

## Common Edits

**Add a new setting:**
1. Add input/toggle to `sidepanel.html`
2. Save to storage in `$("#btn-save-key").addEventListener()`
3. Read from storage when opening settings
4. Use in service worker by reading from `chrome.storage.local.get()`

**Modify system instruction:**
- Edit `SYSTEM_INSTRUCTION` in `src/background.js`
- Redeploy with `pnpm build` and reload extension

**Change theme colors:**
- Edit CSS variables in `sidepanel.css` under `[data-theme="light"]` and `[data-theme="dark"]`
- No rebuild needed; reload side panel

**Add new message type:**
- Define listener in `src/background.js` or `src/content.js` with `if (message.type === "...")`
- Send from opposite end with `chrome.runtime.sendMessage({ type: "..." })`
- Remember to `return true` if using `sendResponse()`

## Build Output

`pnpm build` runs esbuild with these settings:
- Input: `src/background.js`, `src/sidepanel.js`
- Output: `background.js`, `sidepanel.js` (bundled, IIFE format)
- Note: `src/content.js` is currently NOT bundled; it's referenced directly in manifest.

The bundled output includes all dependencies like `@google/genai` and `marked` inline.

## API Key & Permissions

**Permissions in manifest.json:**
- `contextMenus` — right-click menu
- `sidePanel` — open side panel
- `storage` — save chats and settings
- `activeTab` — read URL and open side panel

**API key stored unencrypted** in `chrome.storage.local`. Users must set it manually in Settings. No server-side proxy.

## Testing Tips

- Open DevTools for service worker: `chrome://extensions` → "Verify This" → "Service Worker" link
- Open DevTools for side panel: right-click side panel → Inspect
- Check storage contents: DevTools → Application tab → Local Storage → chrome-extension://<id>
- Simulate slow Gemini API: add delays in `callGemini()` to test loading state
