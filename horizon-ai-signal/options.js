/* AI Signal — options page logic. */
const KEY = "aisignal";
const SB_KEY = "aisignal_sb_key";
const DEFAULTS = { aiSignal: false, aiSensitivity: "med", aiHideAbove: 0, aiPageDetector: false };

let state = { ...DEFAULTS };
const $ = (id) => document.getElementById(id);
const saveNote = $("saved");

function flash() {
  saveNote.classList.add("show");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => saveNote.classList.remove("show"), 1200);
}

async function save(patch) {
  Object.assign(state, patch);
  try {
    const cur = (await chrome.storage.sync.get([KEY]))[KEY] || {};
    await chrome.storage.sync.set({ [KEY]: { ...cur, ...patch } });
  } catch (e) { /* no-op */ }
  flash();
}

function render() {
  $("aiSignal").checked = state.aiSignal;
  $("aiPageDetector").checked = state.aiPageDetector;
  $("hideSlider").value = state.aiHideAbove || 0;
  $("hideVal").textContent = state.aiHideAbove ? `≥ ${state.aiHideAbove}%` : "Off";
  document.querySelectorAll("#sensitivity button").forEach((b) => {
    b.classList.toggle("on", b.dataset.v === state.aiSensitivity);
  });
}

$("aiSignal").addEventListener("change", (e) => save({ aiSignal: e.target.checked }));

$("aiPageDetector").addEventListener("change", async (e) => {
  if (e.target.checked) {
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: ["<all_urls>"] }); } catch (err) { /* no-op */ }
    if (!granted) { e.target.checked = false; return; }
  }
  save({ aiPageDetector: e.target.checked });
});

document.querySelectorAll("#sensitivity button").forEach((b) => {
  b.addEventListener("click", () => save({ aiSensitivity: b.dataset.v }));
});

$("hideSlider").addEventListener("input", (e) => {
  const v = parseInt(e.target.value, 10) || 0;
  $("hideVal").textContent = v ? `≥ ${v}%` : "Off";
  save({ aiHideAbove: v });
});

$("sbKey").addEventListener("change", () => {
  const v = $("sbKey").value.trim();
  try {
    if (v) chrome.storage.sync.set({ [SB_KEY]: v });
    else chrome.storage.sync.remove(SB_KEY);
  } catch (e) { /* no-op */ }
  flash();
});

(async function init() {
  try {
    const r = await chrome.storage.sync.get([KEY, SB_KEY]);
    state = { ...DEFAULTS, ...(r[KEY] || {}) };
    const k = r[SB_KEY];
    if (typeof k === "string") $("sbKey").value = k;
  } catch (e) { /* fall through to defaults */ }
  render();
})();
