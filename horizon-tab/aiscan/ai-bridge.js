/* ════════════════════════════════════════════════════════════════════
   Horizon — AI Prompt Bridge  (opt-in, off by default)
   ════════════════════════════════════════════════════════════════════

   WHY THIS EXISTS
   ───────────────
   Most AI chats accept the prompt in the URL: Perplexity runs it,
   ChatGPT / Claude / Grok drop it in the composer. Gemini and DeepSeek
   ignore URL parameters entirely — so a search from the new tab page
   would land you on a blank chat and you'd retype what you just typed.

   (The old code worked around this by pointing "Gemini" at
   aistudio.google.com — Google's DEVELOPER console — because prefill
   works there. Right prefill, wrong product.)

   This script fills the composer itself, on the AI sites the user has
   explicitly granted, when they turn the bridge on.

   SCOPE AND SAFETY
   ────────────────
   • Off by default. Registered dynamically by background.js only while
     the setting is on AND the user has granted that specific origin.
   • Reads ONE thing: the `hz_q` parameter that the new tab page put in
     the URL it just navigated to. Never page content, never the
     conversation, never anything from the network.
   • Strips `hz_q` from the URL immediately, so a refresh or an
     in-app navigation can't re-fire it.
   • Auto-submit is a SEPARATE opt-in. Default is fill-only: the text
     is placed, the cursor is placed, you press Enter. Filling without
     sending is the conservative default on purpose — the prompt goes
     into your own logged-in account either way, and you should get to
     read it before it sends.
   ════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  if (window.top !== window) return;             // never in iframes
  if (!/^https?:$/.test(location.protocol)) return;

  const params = new URLSearchParams(location.search);
  const prompt = params.get("hz_q");
  if (!prompt) return;                           // not a Horizon navigation

  // Scrub the parameter right away — one shot only.
  try {
    params.delete("hz_q");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  } catch (e) { /* no-op */ }

  const DEADLINE = 12000;   // stop hunting after 12s
  const t0 = Date.now();
  let done = false;

  chrome.storage.sync.get(["hz"], (data) => {
    const s = (data && data.hz) || {};
    if (!s.aiBridge) return;                     // setting was turned off mid-flight
    hunt(!!s.aiBridgeSubmit);
  });

  /* Composer selectors, broadest-first. Each site is an SPA that
     hydrates late, so we poll until one appears or we hit the
     deadline. */
  const SELECTORS = [
    "div[contenteditable='true'][role='textbox']",
    "textarea[data-testid*='chat']",
    "rich-textarea div[contenteditable='true']",   // Gemini
    "div.ql-editor[contenteditable='true']",       // Gemini (Quill)
    "#chat-input",                                  // DeepSeek
    "textarea#prompt-textarea",                     // ChatGPT
    "textarea[placeholder]",
    "div[contenteditable='true']",
  ];

  function findComposer() {
    for (const sel of SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (!el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 16) continue;   // hidden/offscreen stubs
        if (el.closest("[aria-hidden='true']")) continue;
        return el;
      }
    }
    return null;
  }

  /* Frameworks (React/Angular/Lit) track their own state, so assigning
     .value directly is silently discarded on the next render. Use the
     native setter, then dispatch the events the framework listens for. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillContentEditable(el, value) {
    el.focus();
    let inserted = false;
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      inserted = document.execCommand("insertText", false, value);
    } catch (e) { /* fall through */ }
    if (!inserted) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    }
    // Caret to the end so Enter sends the whole thing.
    try {
      const sel2 = window.getSelection();
      const r2 = document.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false);
      sel2.removeAllRanges();
      sel2.addRange(r2);
    } catch (e) { /* no-op */ }
  }

  function submit(el) {
    // Prefer a real send button; fall back to synthesizing Enter.
    const btn = document.querySelector(
      "button[data-testid='send-button'], button[aria-label*='Send' i], button[aria-label*='Submit' i], button[type='submit']:not([disabled])"
    );
    if (btn && !btn.disabled) { btn.click(); return; }
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function hunt(autoSubmit) {
    if (done) return;
    const el = findComposer();
    if (el) {
      done = true;
      el.focus();
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") setNativeValue(el, prompt);
      else fillContentEditable(el, prompt);
      if (autoSubmit) {
        // Let the framework register the text before sending.
        setTimeout(() => submit(el), 420);
      }
      return;
    }
    if (Date.now() - t0 > DEADLINE) return;      // give up quietly
    setTimeout(() => hunt(autoSubmit), 250);
  }
})();
