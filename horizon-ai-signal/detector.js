/* ════════════════════════════════════════════════════════════════════
   Horizon AI Signal — In-Page Detector
   Analyzes article content on a webpage for AI-generated text.

   v2.1 changes:
   • OPT-IN. The detector used to default ON for every website with no
     settings toggle at all. It now defaults OFF, is controlled by the
     "Page detector" toggle in settings, and (via background.js) the
     script isn't even injected outside search pages unless the user
     enables it and grants the optional <all_urls> permission.
   • Never runs in iframes, on non-http(s) schemes, or on non-HTML
     documents (PDF viewer, XML, …).
   • Skips thin pages (< 400 chars / < 80 words) instead of scoring
     navigation chrome.
   • Respects the user's AI Signal sensitivity setting.
   • "Perplexity" replaced with MATTR (moving-average type-token
     ratio). The old proxy divided total words by unique words, which
     mechanically penalizes longer articles (vocabulary always repeats
     as length grows). MATTR uses a sliding 50-word window, so it's
     length-invariant.
   • Burstiness polarity fixed: high burstiness (varied sentence
     lengths) is a HUMAN signal, but v1 ADDED it to the AI score —
     the most human-sounding pages were penalized ~25 points.
   • Reacts live to settings changes (panel removed / re-scored).
   ════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[AI Detector]", ...a); };

  // ── Hard guards ────────────────────────────────────────────────────
  if (window.top !== window) return;                       // never in iframes
  if (!/^https?:$/.test(location.protocol)) return;        // http(s) only
  if (document.contentType && document.contentType !== "text/html") return;
  if (location.hostname.includes("google.") ||
      location.hostname.includes("duckduckgo.") ||
      location.hostname.includes("search.brave.")) {
    return; // SERPs are handled by content.js
  }

  const STORAGE_KEY = "aisignal";
  const MIN_CHARS = 400;
  const MIN_WORDS = 80;

  let prefs = { aiPageDetector: false, aiSensitivity: "med" };
  let detectorPanel = null;
  let analyzed = false;

  function readPrefs(s) {
    return {
      aiPageDetector: !!s.aiPageDetector,
      aiSensitivity: s.aiSensitivity || "med",
    };
  }

  function applyCalibration() {
    if (typeof AIScore !== "undefined") AIScore.setCalibration(prefs.aiSensitivity);
  }

  // Load preferences, then run only if the user opted in.
  try {
    chrome.storage.sync.get([STORAGE_KEY], (data) => {
      prefs = readPrefs((data && data[STORAGE_KEY]) || {});
      applyCalibration();
      if (prefs.aiPageDetector) initDetector();
    });
  } catch (e) {
    log("storage error:", e);
  }

  // React live: disabling removes the panel; sensitivity changes rescore.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[STORAGE_KEY]) return;
      const next = readPrefs(changes[STORAGE_KEY].newValue || {});
      const sensChanged = next.aiSensitivity !== prefs.aiSensitivity;
      const toggled = next.aiPageDetector !== prefs.aiPageDetector;
      prefs = next;
      applyCalibration();
      if (!prefs.aiPageDetector) {
        removePanel();
        return;
      }
      if (toggled || (sensChanged && analyzed)) {
        analyzed = false;
        initDetector();
      }
    });
  } catch (e) { /* no-op */ }

  function initDetector() {
    if (analyzed) return;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => setTimeout(analyzePage, 1000), { once: true });
    } else {
      // Small delay to let dynamic content load
      setTimeout(analyzePage, 1000);
    }
  }

  function removePanel() {
    if (detectorPanel) {
      detectorPanel.remove();
      detectorPanel = null;
    }
  }

  // ── Content extraction ─────────────────────────────────────────────
  function extractArticleText() {
    const selectors = [
      "article",
      "[role='main']",
      "main",
      ".article-content",
      ".post-content",
      ".entry-content",
      "#article-content",
      ".content",
      ".story",
      ".post",
    ];

    let contentEl = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.innerText.trim();
        if (text.length > 500) {
          contentEl = el;
          break;
        }
      }
    }

    // Fallback: find the element with the most text
    if (!contentEl) {
      const paragraphs = document.querySelectorAll("p");
      let bestEl = null;
      let bestScore = 0;

      paragraphs.forEach((p) => {
        const parent = p.parentElement;
        if (!parent) return;
        const text = parent.innerText.trim();
        const score = text.length;
        const tag = parent.tagName.toLowerCase();
        if (!["nav", "header", "footer", "aside"].includes(tag) && score > bestScore) {
          bestScore = score;
          bestEl = parent;
        }
      });

      contentEl = bestEl || document.body;
    }

    return contentEl.innerText.trim();
  }

  function splitIntoSections(text) {
    const sections = [];
    const chunks = text.split(/\n\n+/);

    let currentSection = "";
    chunks.forEach((chunk) => {
      const trimmed = chunk.trim();
      if (trimmed.length < 20) return;

      if (trimmed.length > 200) {
        if (currentSection.length > 100) {
          sections.push(currentSection.trim());
          currentSection = trimmed;
        } else {
          currentSection += "\n\n" + trimmed;
        }
      } else {
        currentSection += "\n\n" + trimmed;
      }
    });

    if (currentSection.length > 50) {
      sections.push(currentSection.trim());
    }

    return sections.slice(0, 5);
  }

  // ── Statistical measures ───────────────────────────────────────────

  /* MATTR — moving-average type-token ratio over 50-word windows.
     Length-invariant vocabulary-variety measure:
       fluent human prose ≈ 0.72–0.86, formulaic/templated ≈ 0.55–0.70.
     Returned as 0–100 where HIGHER = more varied = more human-like. */
  function vocabVariety(text) {
    const words = text.toLowerCase().match(/[a-z][a-z'’-]*/g) || [];
    const W = 50, STEP = 25;
    if (words.length < W) return 50; // not enough signal → neutral
    let sum = 0, n = 0;
    for (let i = 0; i + W <= words.length; i += STEP) {
      const win = words.slice(i, i + W);
      sum += new Set(win).size / W;
      n++;
    }
    const mattr = sum / n;
    // Map 0.55 → 0 and 0.86 → 100, clamp.
    return Math.round(Math.max(0, Math.min(100, ((mattr - 0.55) / 0.31) * 100)));
  }

  /* Burstiness — coefficient of variation of sentence lengths.
     HIGHER = more varied = more human-like. */
  function calculateBurstiness(text) {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
    if (sentences.length < 3) return 50;

    const lengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    const cv = Math.sqrt(variance) / Math.max(mean, 1);

    return Math.round(Math.min(100, Math.max(0, cv * 200)));
  }

  // ── Analysis ───────────────────────────────────────────────────────
  function analyzePage() {
    if (analyzed || !prefs.aiPageDetector) return;

    const text = extractArticleText();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (text.length < MIN_CHARS || wordCount < MIN_WORDS) {
      log("not enough content to analyze", text.length, "chars /", wordCount, "words");
      return;
    }
    analyzed = true;

    log("analyzing:", location.hostname, text.length, "chars");

    const pageScore = AIScore.score(text, { url: location.href });
    const vocab = vocabVariety(text);
    const burstiness = calculateBurstiness(text);

    // Combine — heuristic 50%, vocabulary 25%, burstiness 25%.
    // Both statistical measures are "higher = human", so both are
    // inverted here. (v1 ADDED burstiness, penalizing human prose.)
    const combinedScore = Math.round(
      pageScore.overall * 0.5 +
      (100 - vocab) * 0.25 +
      (100 - burstiness) * 0.25
    );

    const sections = splitIntoSections(text);
    const sectionScores = sections.map((section, i) => {
      const score = AIScore.score(section, { url: location.href });
      return {
        index: i + 1,
        preview: section.substring(0, 60) + "...",
        score: score.overall,
      };
    });

    showDetectorPanel({
      overall: Math.max(0, Math.min(100, combinedScore)),
      heuristic: pageScore.overall,
      vocab,
      burstiness,
      sections: sectionScores,
      wordCount,
    });
  }

  // ── Position, dragging, anchor ─────────────────────────────────────
  /* Position is stored as INSETS from the two edges the pill is pinned to
     — {ax:"left"|"right", ay:"top"|"bottom", ix, iy} in px.

     v1.12 stored ratios of the AVAILABLE space instead, and available
     space is (viewport − element size). Expanding the pill changes its
     size, so the very same ratio resolved to a different pixel position
     and the card visibly drifted on every open/close. It only held
     still at ratio 0 or 1 — i.e. hard against an edge — which is why
     the corners looked fine and everywhere else wandered.

     Insets are immune to that: pinned 24px from the right, the box
     grows leftward and that 24px is unchanged, so expanding moves
     nothing. The stored value is never rewritten by expand/collapse —
     only by an actual drag. */
  const POS_KEY = "hzDetectorPos";
  const MARGIN = 16;
  const DEFAULT_POS = { ax: "right", ay: "bottom", ix: 24, iy: 24 };
  let pos = null;

  function loadPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if ((p.ax === "left" || p.ax === "right") && (p.ay === "top" || p.ay === "bottom") &&
            typeof p.ix === "number" && typeof p.iy === "number") return p;
      }
    } catch (e) { /* no-op */ }
    return { ...DEFAULT_POS };       // bottom-right, as before
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* no-op */ }
  }

  /* Pin the pill by whichever EDGES it sits nearest, then let the card
     grow away from them.
     v1.11 set only top/left, so the box always grew down-and-right no
     matter where you docked it — park it top-right and the expanded
     card ran off the screen. Anchoring `right` instead of `left` (and
     `bottom` instead of `top`) keeps the pinned edge put and expands
     the card inward, which is what you'd expect from every corner. */
  function anchorFor(x, y, w, h) {
    return ((x + w / 2) > window.innerWidth / 2 ? "right" : "left") + "-" +
           ((y + h / 2) > window.innerHeight / 2 ? "bottom" : "top");
  }

  /* A box at (x,y) sized (w,h) → the inset pair for its nearest edges. */
  function insetsFor(x, y, w, h) {
    const a = anchorFor(x, y, w, h);
    const ax = a.startsWith("right") ? "right" : "left";
    const ay = a.endsWith("bottom") ? "bottom" : "top";
    return {
      ax, ay,
      ix: ax === "right" ? window.innerWidth - x - w : x,
      iy: ay === "bottom" ? window.innerHeight - y - h : y,
    };
  }

  /* Write the insets. Clamping only bites when the box genuinely can't
     fit (tiny window, or the expanded card is wider than the space left
     beside it) — and because `pos` itself is never modified here,
     collapsing restores the exact original spot. */
  function applyInsets(p, w, h) {
    const s = detectorPanel.style;
    const ix = Math.min(Math.max(MARGIN, p.ix), Math.max(MARGIN, window.innerWidth - w - MARGIN));
    const iy = Math.min(Math.max(MARGIN, p.iy), Math.max(MARGIN, window.innerHeight - h - MARGIN));
    if (p.ax === "right") { s.right = ix + "px"; s.left = "auto"; }
    else { s.left = ix + "px"; s.right = "auto"; }
    if (p.ay === "bottom") { s.bottom = iy + "px"; s.top = "auto"; }
    else { s.top = iy + "px"; s.bottom = "auto"; }
    detectorPanel.dataset.anchor = p.ax + "-" + p.ay;
  }

  function applyPos() {
    if (!detectorPanel) return;
    const r = detectorPanel.getBoundingClientRect();
    applyInsets(pos, r.width || 80, r.height || 30);
  }

  /* Drag + tap in ONE handler.
     The v1.11 bug: expansion was wired to `pointerdown` on the badge —
     the first event of any drag — so grabbing the pill instantly blew
     it open, and the "swallow the click" guard never fired because the
     toggle wasn't on click at all. Expansion now happens on pointer-UP
     and only when the pointer never travelled past the threshold, so a
     drag can never expand it.
     Grab rules: collapsed, the whole pill drags and a tap expands.
     Expanded, the panel header is the drag handle (body text stays
     selectable) and ✕ collapses. */
  const DRAG_THRESHOLD = 5;

  function bindDrag(root) {
    let dragging = false, moved = false;
    let sx = 0, sy = 0, ox = 0, oy = 0, w = 0, h = 0;
    let pendingX = 0, pendingY = 0, frame = 0, dragPos = null;

    const flush = () => {
      frame = 0;
      if (!dragging || !moved) return;
      dragPos = insetsFor(pendingX, pendingY, w, h);
      applyInsets(dragPos, w, h);
    };

    root.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest(".hz-detector-close")) return;
      if (root.classList.contains("hz-expanded") && !e.target.closest(".hz-detector-panel-header")) return;
      const r = root.getBoundingClientRect();
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      ox = r.left; oy = r.top; w = r.width; h = r.height;
      try { root.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
    }, true);

    root.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) { moved = true; root.classList.add("hz-dragging"); }
      e.preventDefault();
      // Write once per frame: pointermove fires well above 60 Hz on
      // high-refresh displays, and every write forced a style recalc.
      pendingX = Math.min(window.innerWidth - w - MARGIN, Math.max(MARGIN, ox + dx));
      pendingY = Math.min(window.innerHeight - h - MARGIN, Math.max(MARGIN, oy + dy));
      if (!frame) frame = requestAnimationFrame(flush);
    }, true);

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      try { root.releasePointerCapture(e.pointerId); } catch (err) { /* no-op */ }

      if (!moved) {
        // A tap. Expand only from the collapsed state; when expanded,
        // ✕ is the way back, so panel text stays selectable.
        if (!root.classList.contains("hz-expanded")) toggleExpanded(true);
        return;
      }

      root.classList.remove("hz-dragging");
      // Commit exactly what the last frame applied — no round-trip
      // through a size-dependent ratio.
      if (dragPos) { pos = dragPos; dragPos = null; savePos(); }
    };
    root.addEventListener("pointerup", endDrag, true);
    root.addEventListener("pointercancel", endDrag, true);
  }

  /* Expand/collapse, re-anchoring after: the card is far bigger than
     the pill, so pinned edges must be recomputed or it can overhang
     the side it was docked against. */
  let settleTimer = null;
  function toggleExpanded(expand) {
    if (!detectorPanel) return;
    const want = expand === undefined ? !detectorPanel.classList.contains("hz-expanded") : expand;
    detectorPanel.classList.toggle("hz-expanded", want);
    /* The pinned edges hold the card in place on their own, so there is
       nothing to reposition here — applyPos is re-run only so the fit
       clamp can react to the new size. It reads the unchanged `pos`, so
       it is idempotent and cannot itself cause drift. Re-run as the
       card animates to its final size. */
    applyPos();
    requestAnimationFrame(applyPos);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { if (detectorPanel) applyPos(); }, 640);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!detectorPanel) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyPos, 120);
  });

  // ── Panel UI ───────────────────────────────────────────────────────
  let outsideCloseBound = false;

  function showDetectorPanel(data) {
    removePanel();

    const band = data.overall < 35 ? "low" : data.overall < 65 ? "med" : "high";
    const bandColor = band === "low" ? "#22c55e" : band === "med" ? "#f59e0b" : "#ef4444";
    const bandLabel = data.overall < 35 ? "Human-like" : data.overall < 65 ? "Mixed" : "Likely AI";

    detectorPanel = document.createElement("div");
    detectorPanel.className = "hz-page-detector";
    // Panel content lives INSIDE the badge div so the pill expands
    // inline (matching the SERP pill UX).
    detectorPanel.innerHTML = `
      <div class="hz-page-detector-badge">
        <div class="hz-detector-header-row">
          <span class="hz-detector-dot" style="--dot-c:${bandColor}"></span>
          <span class="hz-detector-score">${data.overall}%</span>
        </div>
        <button class="hz-detector-close" type="button" aria-label="Close">✕</button>
        <div class="hz-detector-panel">
          <div class="hz-detector-panel-header">
            <span class="hz-detector-dot" style="--dot-c:${bandColor}"></span>
            <strong>AI Signal: ${data.overall}% · ${bandLabel}</strong>
          </div>
          <div class="hz-detector-bar">
            <div class="hz-detector-bar-fill" style="width:${data.overall}%;background:${bandColor}"></div>
          </div>
          <div class="hz-detector-stats">
            <div class="hz-detector-stat">
              <span class="hz-detector-stat-value" style="color:${data.heuristic < 35 ? "#22c55e" : data.heuristic < 65 ? "#f59e0b" : "#ef4444"}">${data.heuristic}%</span>
              <span class="hz-detector-stat-label">Pattern Match</span>
            </div>
            <div class="hz-detector-stat">
              <span class="hz-detector-stat-value" style="color:${data.vocab > 50 ? "#22c55e" : "#f59e0b"}">${data.vocab}</span>
              <span class="hz-detector-stat-label">Vocab Variety</span>
            </div>
            <div class="hz-detector-stat">
              <span class="hz-detector-stat-value" style="color:${data.burstiness > 50 ? "#22c55e" : "#f59e0b"}">${data.burstiness}</span>
              <span class="hz-detector-stat-label">Burstiness</span>
            </div>
            <div class="hz-detector-stat">
              <span class="hz-detector-stat-value">${data.wordCount}</span>
              <span class="hz-detector-stat-label">Words</span>
            </div>
          </div>
          ${data.sections.length > 0 ? `
          <div class="hz-detector-section-breakdown-title">Section breakdown</div>
          <div class="hz-detector-sections">
            ${data.sections.map((s) => `
              <div class="hz-detector-section">
                <span class="hz-detector-section-score" style="color:${s.score < 35 ? "#22c55e" : s.score < 65 ? "#f59e0b" : "#ef4444"}">${s.score}%</span>
                <span class="hz-detector-section-preview">${escapeHtml(s.preview)}</span>
              </div>
            `).join("")}
          </div>
          ` : ""}
          <div class="hz-detector-foot">
            Heuristic estimate — not definitive. Vocab variety &amp; burstiness are statistical approximations.<br>Drag the pill anywhere; it remembers where you put it.
          </div>
        </div>
      </div>
    `;

    const closeBtn = detectorPanel.querySelector(".hz-detector-close");
    if (closeBtn) {
      closeBtn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleExpanded(false);  // back to the pill (hide it entirely from settings)
      }, true);
    }

    // Close-on-outside-click — bound once per page, not once per panel.
    if (!outsideCloseBound) {
      outsideCloseBound = true;
      document.addEventListener("pointerdown", (e) => {
        if (detectorPanel && !detectorPanel.contains(e.target) &&
            detectorPanel.classList.contains("hz-expanded")) {
          toggleExpanded(false);
        }
      }, true);
    }

    document.body.appendChild(detectorPanel);
    pos = pos || loadPos();
    applyPos();
    bindDrag(detectorPanel);
    // Keep the pill on-screen as it grows/shrinks around a drag position.
    requestAnimationFrame(applyPos);
    log("panel shown:", data.overall + "%", bandLabel);
    checkSafeBrowsing();
  }

  /* Ask the background worker to run the (optional, user-keyed) Google
     Safe Browsing check for this hostname. No key configured → the
     worker skips silently and nothing is shown. */
  function checkSafeBrowsing() {
    try {
      chrome.runtime.sendMessage(
        { action: "checkSafeBrowsing", hostname: location.hostname },
        (resp) => {
          if (chrome.runtime.lastError) return; // worker asleep/unavailable — fine
          const result = resp && resp.ok && resp.result;
          if (!result || !result.checked || !result.threats || !result.threats.length) return;
          if (!detectorPanel) return;
          const panel = detectorPanel.querySelector(".hz-detector-panel");
          if (!panel || panel.querySelector(".hz-detector-sb-warning")) return;
          const types = [...new Set(result.threats.map((t) => String(t.threatType || "THREAT").replace(/_/g, " ").toLowerCase()))].join(", ");
          const warn = document.createElement("div");
          warn.className = "hz-detector-sb-warning";
          warn.textContent = `⚠ Google Safe Browsing flags this site (${types})`;
          panel.insertBefore(warn, panel.firstChild);
          log("safe browsing threats:", result.threats);
        }
      );
    } catch (e) { /* no-op */ }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
})();
