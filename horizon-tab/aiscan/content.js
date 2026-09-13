/* ════════════════════════════════════════════════════════════════════
   Horizon AI Signal — SERP content script
   v2.1 — Storage split + live rescoring + observer batching.
          SELECTORS engine unchanged from v1.7.8 (known working).

   Changes vs v2.0.7:
   • Dismissals + user marks moved to their own sync key ("hzAI").
     They used to live inside the main "hz" settings object, which the
     new-tab page rewrites without them — so changing ANY setting wiped
     every dismissed domain. Split key + read-modify-write fixes it.
   • Settings changes now actually apply live: changing sensitivity or
     hide-threshold clears the per-card done flags and rescores. (The
     old rescan was a no-op because every card was already marked done.)
   • "✓ Human / ✗ AI" marks now persist visually across reloads, and a
     domain you marked Human is never auto-collapsed by the threshold.
   • MutationObserver batches added nodes into one rAF pass instead of
     scoring inside the mutation callback (Google mutates constantly).
   • Observer disconnects while the feature is off.
   • console.log spam gated behind DEBUG.
   ════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[AI Signal]", ...a); };

  const STORAGE_KEY = "hz";    // main settings — owned by the new tab page (read-only here)
  const AI_STORE_KEY = "hzAI"; // dismissals + user marks — owned by this script

  /* ──────────────────────────────────────────────────────────────────
     Selector library — verified working on Google, DDG, Brave SERPs
     (unchanged from v1.7.8)
     ────────────────────────────────────────────────────────────────── */
  const SELECTORS = {
    google: {
      // Each result is a direct child of #rso or nested in data-sokoban-container
      // We target the INNER result divs, not the container
      // EXCLUDE: "What people are saying" / trending discussions (g-blk)
      result: "#rso > div > div.g:not(.g-blk):not([data-hveid='']):not([data-sokoban-container] .g-blk), #rso .g:not(.g-blk), div[data-sokoban-container] .g:not(.g-blk), #search .g:not(.g-blk), [data-snf] .g:not(.g-blk), div.g[data-hveid]:not(.g-blk), div[jscontroller][data-hveid]:not(.g-blk)",
      anchor: "a[href]:not([role='button'])",
      title: "h3",
      snippet: ".VwiC3b, .yXK7lf, [data-content-feature], .st, .yXK7lf.MB230, span[data-st], div[data-sncf] > div > span, div.VwiC3b",
      url: "cite, .tjvcx, .dyjrff, div.TbwUpd, span.V6YFzc",
    },
    duckduckgo: {
      // Each organic web result is an <article> with
      // data-testid="result". The modern SPA also renders results
      // inside <li data-layout="organic"> wrappers (newer 2024+
      // markup). .result is the legacy HTML version selector.
      // We EXCLUDE knowledge panels, ads, and inline zero-click
      // answer boxes by filtering inside shouldSkipCard.
      result: "article[data-testid='result'], li[data-layout='organic'] article, .result, ol.react-results--main li article",
      anchor: "a[data-testid='result-title-a'], h2 a, a.result__a",
      title: "h2 a, h2, .result__title a, [data-testid='result-title-a']",
      snippet: "[data-result='snippet'], .result__snippet, [data-testid='result-snippet']",
      url: "[data-testid='result-extras-url-link'], .result__url, [data-testid='result-extras'] a",
    },
    brave: {
      result: ".snippet[data-type='web'], .snippet",
      anchor: "a.h, a.result-header, .title a",
      title: ".title, .snippet-title",
      snippet: ".snippet-description, .snippet-content",
      url: ".snippet-url, .url",
    },
  };

  function detectEngine() {
    const h = location.hostname || "";
    if (h.includes("google.")) return "google";
    if (h.includes("duckduckgo.")) return "duckduckgo";
    if (h.includes("search.brave.")) return "brave";
    return null;
  }

  const engine = detectEngine();
  log("engine:", engine, "on", location.hostname + location.pathname);
  if (!engine) return;

  const DEFAULT_PREFS = {
    aiSignal: false,
    aiSensitivity: "med",
    aiHideAbove: 0,
  };

  let prefs = { ...DEFAULT_PREFS };
  let aiStore = { aiDismissed: {}, aiUserMarks: {} };

  function readPrefs(s) {
    return {
      aiSignal: !!s.aiSignal,
      aiSensitivity: s.aiSensitivity || "med",
      aiHideAbove: parseInt(s.aiHideAbove, 10) || 0,
    };
  }

  function applyCalibration() {
    if (typeof AIScore !== "undefined") AIScore.setCalibration(prefs.aiSensitivity);
  }

  function loadPrefs() {
    try {
      chrome.storage.sync.get([STORAGE_KEY, AI_STORE_KEY], (data) => {
        const s = (data && data[STORAGE_KEY]) || {};
        prefs = readPrefs(s);
        const st = (data && data[AI_STORE_KEY]) || {};
        aiStore = { aiDismissed: st.aiDismissed || {}, aiUserMarks: st.aiUserMarks || {} };

        // One-time migration: dismissals used to live inside "hz".
        const legacyDismissed = s.aiDismissed && Object.keys(s.aiDismissed).length;
        const legacyMarks = s.aiUserMarks && Object.keys(s.aiUserMarks).length;
        if (legacyDismissed || legacyMarks) {
          aiStore = {
            aiDismissed: { ...(s.aiDismissed || {}), ...aiStore.aiDismissed },
            aiUserMarks: { ...(s.aiUserMarks || {}), ...aiStore.aiUserMarks },
          };
          try { chrome.storage.sync.set({ [AI_STORE_KEY]: aiStore }); } catch (e) { /* no-op */ }
          // We never rewrite "hz" from here — the new tab page owns it,
          // and its next save naturally drops the legacy keys.
        }

        log("prefs:", prefs, "store:", aiStore);
        applyCalibration();
        syncScanState();
      });
    } catch (e) {
      log("storage error:", e);
    }
  }

  /* Persist dismissals/marks with read-modify-write so two SERP tabs
     can't clobber each other's changes. */
  function persistAiStore() {
    try {
      chrome.storage.sync.get([AI_STORE_KEY], (data) => {
        const cur = (data && data[AI_STORE_KEY]) || {};
        aiStore = {
          aiDismissed: { ...(cur.aiDismissed || {}), ...aiStore.aiDismissed },
          aiUserMarks: { ...(cur.aiUserMarks || {}), ...aiStore.aiUserMarks },
        };
        try { chrome.storage.sync.set({ [AI_STORE_KEY]: aiStore }); } catch (e) { /* no-op */ }
      });
    } catch (e) { /* no-op */ }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes[STORAGE_KEY]) {
        const next = readPrefs(changes[STORAGE_KEY].newValue || {});
        if (next.aiSignal !== prefs.aiSignal ||
            next.aiSensitivity !== prefs.aiSensitivity ||
            next.aiHideAbove !== prefs.aiHideAbove) {
          prefs = next;
          applyCalibration();
          resetAndRescan(); // scores/thresholds changed → rescore everything
        }
      }
      if (changes[AI_STORE_KEY]) {
        const st = changes[AI_STORE_KEY].newValue || {};
        aiStore = { aiDismissed: st.aiDismissed || {}, aiUserMarks: st.aiUserMarks || {} };
        applyDismissals(); // cheap: just hide badges on dismissed domains
      }
    });
  } catch (e) { /* no-op */ }

  /* ──────────────────────────────────────────────────────────────────
     Helpers
     ────────────────────────────────────────────────────────────────── */
  function extractHostname(href) {
    try {
      const u = new URL(href);
      return u.hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  function bandFor(pct) {
    if (pct < 35) return "low";
    if (pct < 65) return "med";
    return "high";
  }

  function bandLabel(band) {
    return band === "low" ? "Human-like" : band === "med" ? "Mixed signals" : "Likely AI";
  }

  /* ──────────────────────────────────────────────────────────────────
     Extract data from a result card (unchanged)
     ────────────────────────────────────────────────────────────────── */
  function extractResultData(card, sel) {
    let url = "";
    let titleEl = null;

    const anchors = card.querySelectorAll(sel.anchor);
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (href && /^https?:\/\//i.test(href)) {
        url = href;
        titleEl = a;
        break;
      }
    }

    if (!url) {
      const allLinks = card.querySelectorAll("a[href^='http']");
      for (const a of allLinks) {
        url = a.getAttribute("href");
        titleEl = a;
        break;
      }
    }

    if (!url) return null;

    const title =
      (card.querySelector(sel.title) || {}).textContent?.trim() ||
      (titleEl && titleEl.textContent?.trim()) ||
      "";

    const snippetEls = card.querySelectorAll(sel.snippet);
    let snippet = "";
    for (const el of snippetEls) {
      const text = el.textContent.trim();
      if (text.length > snippet.length) snippet = text;
    }

    if (!title && !snippet) return null;

    return { url, hostname: extractHostname(url), title, snippet };
  }

  /* ──────────────────────────────────────────────────────────────────
     Skip AI Overview / "What people are saying" / discussion cards
     (unchanged, minus an unused innerHTML read)
     ────────────────────────────────────────────────────────────────── */
  function shouldSkipCard(card) {
    const text = card.textContent || "";

    // No meaningful <h3> link -> can't attribute the score to a URL
    const h3 = card.querySelector("h3");
    if (!h3) return true;
    const wrappingAnchor = h3.closest("a");
    if (!wrappingAnchor || !wrappingAnchor.href) return true;

    // AI Overview / generative-AI blobs
    if (text.includes("AI Overview") || text.includes("AI-generated")) return true;
    if (card.querySelector("g-generative-ai") || card.closest("g-generative-ai")) return true;
    if (card.closest("[data-attrid='wa:/description']")) return true;
    if (card.querySelector("[data-attrid='wa:/description']")) return true;

    // Discussion / forum blocks
    if (card.closest(".g-blk")) return true;
    if (card.querySelector("[data-attrid='kc:/discussion/forum']")) return true;
    if (text.includes("What people are saying") || text.includes("trending posts")) return true;

    // Top stories / videos / images / knowledge panels — widget
    // cards, not organic text results. Either they have a section
    // header in their ancestor, or their data-attrid starts with
    // a widget prefix.
    if (card.closest("g-section-with-header")) return true;
    if (card.closest("g-scrolling-carousel, g-section-with-header, [role='region']")) return true;
    if (card.closest("[data-hpmh], [data-hpfh]")) return true; // carousel wrappers
    const parentSection = card.closest("[data-attrid]");
    if (parentSection) {
      const a = parentSection.getAttribute("data-attrid") || "";
      if (a.startsWith("kc:/")) return true;                  // knowledge cards
      if (a.startsWith("videos:") || a.startsWith("images:")) return true;
    }
    if (card.closest("[aria-label*='more results'], [aria-label*='More results']")) return true;

    // People-also-ask FAQ excerpts (not full results)
    if (card.closest("[data-qaqa], [data-lpage], [data-pfidx]")) return true;
    if (card.querySelector("[data-qaqa]")) return true;

    // Wrappers that contain nested result cards (the card itself
    // is a container, not a leaf result)
    const nestedResults = card.querySelectorAll(".g, article");
    if (nestedResults.length > 2) return true;

    return false;
  }

  /* ───────────────────────────────────────────────────────────────────────
     Badge — compact pill with embedded panel (v2.0.9 UX)
     Insert OUTSIDE Google’s flipped title-row span.

     Google wraps each title’s anchor in <span class="V9tjod">
     which carries `transform: scaleY(-1)`. Anything injected
     inside that span renders flipped. We climb one more level
     and place the badge between the title row and the URL /
     snippet, in un-flipped territory, away from the kebab (⋮)
     menu which either lives inside that flipped span or adjacent
     to it. The badge itself uses `transform: scaleY(-1)` in
     badge.css as belt-and-suspenders for any other flipped
     ancestor higher up the tree.
     ─────────────────────────────────────────────────────────────────────── */
  function injectBadge(card, score, hostname) {
    // Wipe any prior badge anywhere in the card so re-scans never
    // produce duplicates (mutation observer fires for many events).
    card.querySelectorAll(".hz-ai-badge").forEach((b) => b.remove());

    const band = bandFor(score.overall);
    const badge = document.createElement("span");
    badge.className = "hz-ai-badge";
    badge.dataset.band = band;
    badge.dataset.hostname = hostname;

    badge.innerHTML = `
      <span class="hz-ai-head" aria-hidden="true">
        <span class="hz-ai-dot"></span>
        <span class="hz-ai-pct">${score.overall}%</span>
      </span>
      <button class="hz-ai-dismiss" type="button" aria-label="Dismiss" title="Hide for this domain">✕</button>
      <div class="hz-ai-panel">
        <div class="hz-panel-header">
          <span class="hz-panel-dot" data-band="${band}"></span>
          <strong>${score.overall}% · ${bandLabel(band)}</strong>
        </div>
        <div class="hz-panel-reasons">${escapeAttr((score.reasons && score.reasons.length ? score.reasons.slice(0, 3).join(" · ") : "No strong AI signals detected"))}</div>
        <div class="hz-panel-actions">
          <button class="hz-btn hz-btn-human">✓ Human</button>
          <button class="hz-btn hz-btn-ai">✗ AI</button>
        </div>
        <div class="hz-panel-foot">
          <span>Heuristic estimate — not a definitive verdict</span>
          <button type="button" class="hz-panel-method-link" data-action="methodology">How this works</button>
        </div>
      </div>
    `;

    // A previously saved "✓ Human / ✗ AI" mark persists across reloads.
    const savedMark = aiStore.aiUserMarks && aiStore.aiUserMarks[hostname];
    if (savedMark === "human" || savedMark === "ai") {
      applyMarkToBadge(badge, savedMark);
    }

    // Walk past the flipped title span.
    //   • Do NOT insert inside the title’s <a> (would trigger
    //     navigation if our click handler ever missed).
    //   • Do NOT insert inside SPAN.V9tjod — it carries
    //     `transform: scaleY(-1)` from Google and the badge
    //     would render upside down there.
    // Insert as the next sibling of SPAN.V9tjod, inside its
    // (un-flipped) grandparent — i.e. between the title row
    // and the URL/snippet. Clean, upright, kebab-free.
    const titleEl = card.querySelector("h3");
    let parent = null;
    let after = null;
    if (titleEl) {
      const wrappingAnchor = titleEl.closest("a");
      if (wrappingAnchor && wrappingAnchor.parentElement) {
        const flippedSpan = wrappingAnchor.parentElement; // V9tjod
        if (flippedSpan.parentElement) {
          parent = flippedSpan.parentElement; // un-flipped row
          after  = flippedSpan;
        } else {
          parent = flippedSpan;
          after  = wrappingAnchor;
        }
      } else if (titleEl.parentElement) {
        parent = titleEl.parentElement;
        after  = titleEl;
      }
    }
    if (!parent) {
      parent = card;
      after  = null;
    }
    parent.insertBefore(badge, (after && after.nextSibling) || null);

    // Click badge to expand panel.
    // Use pointerdown in CAPTURE phase so we beat any Google mousedown/
    // click handlers attached higher up the tree (Google Analytics,
    // instant-navigation, etc. all listen on document/window).
    badge.addEventListener("pointerdown", (e) => {
      // Bail if the click was on the dismiss button OR the
      // "How this works" methodology link. Both have their own
      // handlers; if we let the badge toggle here, those
      // handlers would never fire (and the pill would close
      // when the user clicks the methodology link).
      if (e.target.closest(".hz-ai-dismiss")) return;
      if (e.target.closest(".hz-panel-method-link")) return;
      if (e.target.closest(".hz-btn-human, .hz-btn-ai")) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Close any other expanded badge first
      document.querySelectorAll(".hz-ai-badge.hz-expanded").forEach((b) => {
        if (b !== badge) b.classList.remove("hz-expanded");
      });
      badge.classList.toggle("hz-expanded");
    }, true);

    // Dismiss button — same capture-phase treatment
    const dismissBtn = badge.querySelector(".hz-ai-dismiss");
    dismissBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      dismissForDomain(hostname);
    }, true);

    // Methodology link inside the expanded panel — opens a
    // self-contained modal in-page (no round-trip to the new tab
    // needed).
    const methodBtn = badge.querySelector('.hz-panel-method-link');
    if (methodBtn) {
      methodBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showMethodologyModal();
      }, true);
    }

    // Mark-as-human / Mark-as-AI buttons inside the panel
    badge.querySelector(".hz-btn-human").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      markDomain(hostname, "human");
    }, true);
    badge.querySelector(".hz-btn-ai").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      markDomain(hostname, "ai");
    }, true);
  }

  function applyMarkToBadge(badge, mark) {
    const foot = badge.querySelector(".hz-panel-foot");
    if (foot) {
      foot.textContent = `You marked this as ${mark === "human" ? "Human" : "AI"}`;
      foot.style.color = mark === "human" ? "#22c55e" : "#ef4444";
    }
  }

  function dismissForDomain(hostname) {
    aiStore.aiDismissed = aiStore.aiDismissed || {};
    aiStore.aiDismissed[hostname] = true;
    persistAiStore();

    document.querySelectorAll(`[data-hz-hostname="${cssEscape(hostname)}"]`).forEach((c) => {
      const b = c.querySelector(".hz-ai-badge");
      if (b) b.remove();
      c.classList.remove("hz-ai-collapsed");
    });
  }

  function markDomain(hostname, mark) {
    aiStore.aiUserMarks = aiStore.aiUserMarks || {};
    aiStore.aiUserMarks[hostname] = mark;
    persistAiStore();

    document.querySelectorAll(`[data-hz-hostname="${cssEscape(hostname)}"]`).forEach((c) => {
      const b = c.querySelector(".hz-ai-badge");
      if (b) applyMarkToBadge(b, mark);
      if (mark === "human") c.classList.remove("hz-ai-collapsed");
    });
  }

  function applyDismissals() {
    const dismissed = aiStore.aiDismissed || {};
    for (const hostname of Object.keys(dismissed)) {
      document.querySelectorAll(`[data-hz-hostname="${cssEscape(hostname)}"]`).forEach((c) => {
        const b = c.querySelector(".hz-ai-badge");
        if (b) b.remove();
        c.classList.remove("hz-ai-collapsed");
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     Process one card
     ────────────────────────────────────────────────────────────────── */
  function processCard(card) {
    if (!prefs.aiSignal) return;
    if (card.dataset.hzAIDone === "1") return;

    if (shouldSkipCard(card)) {
      card.dataset.hzAIDone = "1";
      return;
    }

    const sel = SELECTORS[engine];
    if (!sel) return;

    const data = extractResultData(card, sel);
    if (!data) {
      card.dataset.hzAIDone = "1";
      return;
    }

    card.dataset.hzHostname = data.hostname;
    card.dataset.hzAIDone = "1";

    if (aiStore.aiDismissed && aiStore.aiDismissed[data.hostname]) {
      return;
    }

    const text = [data.title, data.snippet].filter(Boolean).join(" — ");
    let score;
    try {
      score = AIScore.score(text, { url: data.url });
    } catch (e) {
      log("scoring error:", e);
      return;
    }

    log("scored:", data.hostname, score.overall + "%", bandLabel(bandFor(score.overall)));

    injectBadge(card, score, data.hostname);

    const markedHuman = aiStore.aiUserMarks && aiStore.aiUserMarks[data.hostname] === "human";
    if (!markedHuman && prefs.aiHideAbove > 0 && score.overall >= prefs.aiHideAbove) {
      card.classList.add("hz-ai-collapsed");
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     Scan / rescan
     ────────────────────────────────────────────────────────────────── */
  function rescanAll() {
    if (!prefs.aiSignal) {
      clearAllBadges();
      return;
    }
    const sel = SELECTORS[engine];
    if (!sel) return;

    let cards = document.querySelectorAll(sel.result);

    if (cards.length === 0 && engine === "google") {
      const candidates = document.querySelectorAll("#rso > div > div, [data-sokoban-container] > div");
      cards = Array.from(candidates).filter((el) => el.querySelector("h3") || el.querySelector("a[href^='http']"));
    }

    log("rescanning", cards.length, "cards on", engine);
    cards.forEach(processCard);
  }

  function clearAllBadges() {
    document.querySelectorAll(".hz-ai-badge").forEach((b) => b.remove());
    document.querySelectorAll(".hz-ai-collapsed").forEach((c) => c.classList.remove("hz-ai-collapsed"));
  }

  /* Settings changed → wipe done-flags and rescore from scratch. */
  function resetAndRescan() {
    document.querySelectorAll("[data-hz-ai-done]").forEach((c) => { delete c.dataset.hzAIDone; });
    clearAllBadges();
    syncScanState();
  }

  /* Turn scanning machinery on/off to match the pref. */
  function syncScanState() {
    if (prefs.aiSignal) {
      startObserver();
      rescanAll();
    } else {
      stopObserver();
      clearAllBadges();
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     Mutation observer — batch added nodes into one rAF pass.
     Google's SERP mutates constantly (prefetch, viewport tracking…);
     scoring inside the observer callback caused long tasks.
     ────────────────────────────────────────────────────────────────── */
  let observer = null;
  const pendingNodes = new Set();
  let flushScheduled = false;

  function flushPending() {
    flushScheduled = false;
    if (!prefs.aiSignal) { pendingNodes.clear(); return; }
    const sel = SELECTORS[engine];
    if (!sel) { pendingNodes.clear(); return; }
    const nodes = Array.from(pendingNodes);
    pendingNodes.clear();
    for (const n of nodes) {
      if (!n.isConnected) continue;
      if (n.matches && n.matches(sel.result)) processCard(n);
      if (n.querySelectorAll) n.querySelectorAll(sel.result).forEach(processCard);
    }
  }

  function startObserver() {
    if (observer) return;
    const root = document.body || document.documentElement;
    observer = new MutationObserver((mutations) => {
      if (!prefs.aiSignal) return;
      let queued = false;
      for (const m of mutations) {
        if (!m.addedNodes || !m.addedNodes.length) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          pendingNodes.add(n);
          queued = true;
        }
      }
      if (queued && !flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(flushPending);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    log("observer started");
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
      log("observer stopped");
    }
    pendingNodes.clear();
  }

  /* ──────────────────────────────────────────────────────────────────
     Click outside to close any expanded panel
     ────────────────────────────────────────────────────────────────── */
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".hz-ai-badge")) {
      document.querySelectorAll(".hz-ai-badge.hz-expanded").forEach((b) => {
        b.classList.remove("hz-expanded");
      });
    }
  }, true);

  /* ──────────────────────────────────────────────────────────────────
     Methodology modal (in-page, self-contained)
     ────────────────────────────────────────────────────────────────── */
  let _methodologyModal = null;
  function showMethodologyModal() {
    if (_methodologyModal) { _methodologyModal.remove(); _methodologyModal = null; }
    const root = document.createElement('div');
    root.className = 'hz-method-modal';
    root.innerHTML = `
      <div class="hz-method-card" role="dialog" aria-modal="true" aria-label="How AI Signal works">
        <button type="button" class="hz-method-close" aria-label="Close">✕</button>
        <h3>How AI Signal works</h3>
        <p class="hz-method-sub">A heuristic estimate of how likely a page is to be AI-generated text.</p>

        <h4>The honest reality</h4>
        <p>No client-side detector is reliable. Heuristics can be a useful first-pass “smell test”, but they should never be treated as a definitive verdict.</p>

        <h4>What we look at</h4>
        <ul>
          <li><strong>Weighted phrase lexicon.</strong> Phrases like <em>delve into</em>, <em>navigate the complexities</em>, <em>in today's digital landscape</em> are flag-weighted, each capped so repetition can't max the score.</li>
          <li><strong>Structure.</strong> Sentence-length uniformity, “Firstly… Secondly… Finally” scaffolding, repeated sentence starts, transition-word density, em-dash density.</li>
          <li><strong>Length normalization.</strong> Evidence is measured as a density per ~45 words, so long text doesn't inflate and short snippets don't starve.</li>
          <li><strong>Author / byline signal.</strong> A visible named byline is a human signal; self-disclosure (“AI-generated”) is a near-certain AI signal. A missing byline is <em>not</em> penalized.</li>
          <li><strong>Domain signal.</strong> URL shape (TLD, hyphen slug) plus a curated list of human-edited publications, matched on the parsed hostname.</li>
        </ul>

        <h4>What it can’t do</h4>
        <ul>
          <li>False positives on formal human prose (legal briefs, dense academic writing).</li>
          <li>Lightly-edited AI text will usually pass.</li>
          <li>No detection of AI images, AI audio, or AI video.</li>
        </ul>

        <p class="hz-method-foot">Score bands: Human-like &lt;35 · Mixed 35–64 · Likely AI ≥65. Sensitivity bends the curve — Low compresses mid scores so only extreme evidence flags; High stretches them upward.</p>
      </div>
    `;
    document.body.appendChild(root);
    _methodologyModal = root;

    const close = () => { root.remove(); _methodologyModal = null; };
    root.querySelector('.hz-method-close').addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      close();
    }, true);
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) {
        e.preventDefault(); e.stopPropagation();
        close();
      }
    }, true);
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && _methodologyModal) {
        _methodologyModal.remove(); _methodologyModal = null;
        document.removeEventListener('keydown', onEsc, true);
      }
    }, true);
  }

  /* ──────────────────────────────────────────────────────────────────
     Boot
     ────────────────────────────────────────────────────────────────── */
  loadPrefs();
  // Late-render safety nets: SERPs hydrate results after document_idle.
  setTimeout(rescanAll, 400);
  setTimeout(rescanAll, 1200);
})();
