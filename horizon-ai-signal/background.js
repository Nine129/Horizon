/* Horizon AI Signal — background service worker.
   Two jobs:
   1. DYNAMIC PAGE-DETECTOR REGISTRATION
      Registered only when BOTH the user turns on "Page detector" in
      options AND the optional <all_urls> host permission is granted.
      Turning the setting off (or revoking the permission) unregisters
      it. SERP badges are a static content script scoped to the three
      search engines and are unaffected.
   2. SAFE BROWSING RELAY
      Handles cross-origin fetches the content scripts can't make.
      The Google Safe Browsing API requires an API key, which the user
      provides via the options page. It is stored in chrome.storage.sync
      (never bundled with the extension) and applied at request time. If
      no key is configured, the check is skipped silently. */

const DETECTOR_SCRIPT_ID = "aisignal-page-detector";
const SERP_MATCHES = [
  "*://*.google.com/search*",
  "*://*.duckduckgo.com/*",
  "*://search.brave.com/search*",
];

async function detectorRegistered() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
    return !!(scripts && scripts.length);
  } catch (e) {
    return false;
  }
}

async function hasAllUrlsPermission() {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (e) {
    return false;
  }
}

async function syncDetectorRegistration() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;

  let enabled = false;
  try {
    const r = await chrome.storage.sync.get(["aisignal"]);
    enabled = !!(r && r.aisignal && r.aisignal.aiPageDetector);
  } catch (e) { /* default off */ }

  const want = enabled && (await hasAllUrlsPermission());
  const have = await detectorRegistered();

  try {
    if (want && !have) {
      await chrome.scripting.registerContentScripts([{
        id: DETECTOR_SCRIPT_ID,
        js: ["score.js", "detector.js"],
        css: ["badge.css"],
        matches: ["<all_urls>"],
        excludeMatches: SERP_MATCHES,
        runAt: "document_idle",
        persistAcrossSessions: true,
      }]);
    } else if (!want && have) {
      await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
    }
  } catch (err) {
    console.error("[AI Signal] detector registration failed:", err);
  }
}

function syncAll() { syncDetectorRegistration(); }

chrome.runtime.onInstalled.addListener(syncAll);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(syncAll);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.aisignal) syncAll();
});
if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(syncAll);
if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(syncAll);
syncAll();

/* Toolbar button → options page. */
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
}

/* ── Safe Browsing relay ───────────────────────────────────────────── */

const safeBrowsingCache = {};
const SAFE_BROWSING_TTL_MS = 60 * 60 * 1000;

async function getSafeBrowsingKey() {
  try {
    const r = await chrome.storage.sync.get(["aisignal_sb_key"]);
    return typeof r.aisignal_sb_key === "string" && r.aisignal_sb_key.length > 10
      ? r.aisignal_sb_key
      : null;
  } catch {
    return null;
  }
}

async function checkSafeBrowsing(hostname) {
  const now = Date.now();
  if (safeBrowsingCache[hostname] && (now - safeBrowsingCache[hostname].t) < SAFE_BROWSING_TTL_MS) {
    return safeBrowsingCache[hostname].result;
  }

  const apiKey = await getSafeBrowsingKey();
  if (!apiKey) {
    return { skipped: true, reason: "no api key configured" };
  }

  try {
    const url = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`;
    const body = {
      client: { clientId: "horizon-ai-signal", clientVersion: "1.0" },
      threatInfo: {
        threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: [
          { url: `https://${hostname}` },
          { url: `http://${hostname}` },
        ],
      },
    };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const result = { checked: true, threats: data.matches || [] };
    safeBrowsingCache[hostname] = { t: now, result };
    return result;
  } catch (err) {
    console.error("[AI Signal] Safe Browsing check failed:", err);
    return { skipped: true, reason: "request failed", error: String(err && err.message || err) };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === "checkSafeBrowsing" && request.hostname) {
    checkSafeBrowsing(request.hostname).then(result => {
      sendResponse({ ok: true, result });
    }).catch(err => {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    });
    return true;
  }
  sendResponse({ ok: false, reason: "no handler" });
  return true;
});
