/* ════════════════════════════════════════════════════════════════════
   Horizon AI Signal — heuristic scorer (v2)
   ════════════════════════════════════════════════════════════════════

   WHAT THIS IS
   ────────────
   A client-side "smell test" for AI-flavored text. It runs entirely on
   the snippet, title, and URL of a search result — no fetch, no API,
   no model. Three independent signals are scored 0–100 (higher = more
   AI-like) and combined.

   WHAT THIS IS NOT
   ────────────────
   NOT a definitive detector. No client-side heuristic can reliably
   tell AI from human writing — formal human prose will get flagged,
   lightly-edited AI text will pass. Every score is an estimate.

   v2 CHANGES (vs v1)
   ──────────────────
   • Lexicon rebuilt: removed ~60 noise patterns that matched ordinary
     human words ("people", "family", "like", "honestly", slang…) and
     deduplicated repeated entries that double-counted.
   • Per-pattern hit cap (2) so one repeated phrase can't max the score.
   • Length normalization: raw points are converted to a density per
     ~45 words, then squashed through a logistic curve — long text no
     longer inflates, short text no longer starves.
   • Author byline regex fixed (case-insensitive flag made "by using
     these tips" count as a human byline).
   • Reputable-publication list rebuilt: the old list had accidentally
     absorbed a block of known misinformation domains (which were then
     scored HIGH-trust). New list is curated + deduped, and matching is
     done on the parsed hostname, not substring-anywhere.
   • Trust score is deterministic (v1 mixed in Math.random()).
   • Sensitivity now scales scores around a pivot instead of
     multiplying them — at "low" the Likely-AI band is still reachable
     for extreme cases (v1 capped low-sensitivity scores at 55, so
     nothing could ever be flagged).
*/

(function (root) {
  "use strict";

  /* ──────────────────────────────────────────────────────────────────
     Lexicon — phrases AI writing statistically over-uses.
     w    = points per occurrence
     cap  = max counted occurrences (default 2)
     Kept deliberately high-precision: a pattern earns its place only
     if it's rare in casual human writing.
     ────────────────────────────────────────────────────────────────── */
  const PHRASES = [
    // ── Near-certain tells (self-disclosure / assistant leakage) ──
    { re: /\bas an ai(?: language)? model\b/gi, w: 20, name: "as an AI model" },
    { re: /\bas of my (?:last|latest) (?:knowledge )?update\b/gi, w: 18, name: "as of my last update" },
    { re: /\bi (?:cannot|can't) (?:fulfill|assist with) (?:that|this) request\b/gi, w: 18, name: "cannot fulfill request" },
    { re: /\bcertainly! here(?:'s| is)\b/gi, w: 12, name: "Certainly! Here's" },

    // ── Strong tells ──
    { re: /\bin today'?s?\s+(?:digital|fast-paced|modern|ever-changing|ever-evolving|rapidly evolving)?\s*(?:landscape|world|era|age)\b/gi, w: 8, name: "in today's landscape/world" },
    { re: /\bnavigat(?:e|ing|es|ed)\s+the\s+(?:complexities|nuances|intricacies|challenges)\b/gi, w: 7, name: "navigate the complexities" },
    { re: /\bin this (?:article|post|guide|piece|blog),?\s+we(?:'ll| will| shall)?\s*(?:explore|discuss|delve|examine|uncover|cover)\b/gi, w: 7, name: "in this article, we explore" },
    { re: /\bever-?evolving\s+(?:\w+\s+)?(?:landscape|world|industry|field|challenges|market)\b/gi, w: 6, name: "ever-evolving landscape" },
    { re: /\bit'?s?\s+(?:important|essential|crucial|vital|imperative)\s+to\s+(?:note|remember|understand|recognize|acknowledge)\b/gi, w: 6, name: "it's important to note" },
    { re: /\bseamless(?:ly)?\s+(?:integrat\w+|blend\w*|experience|transition|workflow)\b/gi, w: 6, name: "seamless integration" },
    { re: /\bunparalleled\s+(?:efficiency|performance|results|quality|precision|access|scalability|accuracy|insights?)\b/gi, w: 6, name: "unparalleled efficiency" },
    { re: /\brevolutioniz(?:e|ed|es|ing)\b/gi, w: 4, name: "revolutionize" },
    { re: /\bunlock(?:ing|s|ed)?\s+(?:the |your )?(?:potential|power|full|true|secrets)\b/gi, w: 6, name: "unlock the potential" },
    { re: /\b(?:vibrant|rich)\s+tapestry\b/gi, w: 7, name: "vibrant tapestry" },
    { re: /\bunderscor(?:es|ing|ed)\s+the\s+(?:importance|need|significance)\b/gi, w: 6, name: "underscores the importance" },
    { re: /\bplays?\s+a\s+(?:crucial|pivotal|vital|key)\s+role\b/gi, w: 5, name: "plays a crucial role" },
    { re: /\bembark(?:ing|ed|s)?\s+on\s+a\s+journey\b/gi, w: 6, name: "embark on a journey" },
    { re: /\b(?:delve|delves|delved|delving)\b/gi, w: 5, name: "delve" },
    { re: /\bfoster(?:ing|s)?\s+a\s+(?:sense|culture|spirit|environment)\s+of\b/gi, w: 5, name: "fostering a sense of" },
    { re: /\bharness(?:ing|es|ed)?\s+(?:the |your )?(?:power|potential|benefits)\b/gi, w: 5, name: "harness the power" },
    { re: /\bleverag(?:e|ing|es|ed)\s+(?:the\s+)?(?:power|potential|capabilit\w+|strengths?)\s+of\b/gi, w: 5, name: "leverage the power of" },
    { re: /\btransformative\s+(?:impact|power|potential|effect|change)\b/gi, w: 5, name: "transformative impact" },
    { re: /\bholistic\s+(?:approach|solution|view|perspective|framework)\b/gi, w: 5, name: "holistic approach" },
    { re: /\btestament\s+to\s+(?:the |our |its )?(?:power|skill|commitment|ingenuity|durability|dedication)\b/gi, w: 5, name: "testament to" },
    { re: /\b(?:paradigm|seismic)\s+shift\b/gi, w: 5, name: "paradigm shift" },
    { re: /\bgame-?changer\b/gi, w: 5, name: "game-changer" },
    { re: /\bstate-?of-?the-?art\b/gi, w: 5, name: "state-of-the-art" },
    { re: /\bactionable\s+(?:insights|strategies|steps|takeaways|advice|tips)\b/gi, w: 5, name: "actionable insights" },
    { re: /\bmultifaceted\s+(?:approach|solution|benefits|nature|challenge)\b/gi, w: 5, name: "multifaceted" },
    { re: /\bit\s+is\s+universally\s+acknowledged\b/gi, w: 5, name: "universally acknowledged" },
    { re: /\bwhether\s+you'?re\s+a\s+(?:beginner|novice|seasoned|first-time)\b/gi, w: 5, name: "whether you're a beginner" },
    { re: /\bmyriad\s+of\b/gi, w: 4, name: "myriad of" },
    { re: /\bcutting-?edge\b/gi, w: 4, name: "cutting-edge" },
    { re: /\bin\s+conclusion\b/gi, w: 4, name: "in conclusion" },
    { re: /\bmeaningful\s+impact\b/gi, w: 4, name: "meaningful impact" },
    { re: /\belevate\s+your\b/gi, w: 4, name: "elevate your" },
    { re: /\blook\s+no\s+further\b/gi, w: 5, name: "look no further" },
    { re: /\bhidden\s+gems?\b/gi, w: 4, name: "hidden gem" },
    { re: /\bmust-?visit\b/gi, w: 4, name: "must-visit" },
    { re: /\bnestled\s+(?:in|along|among|between)\b/gi, w: 4, name: "nestled in" },
    { re: /\bboasts?\s+(?:a|an|the|its|stunning|breathtaking|impressive)\b/gi, w: 4, name: "boasts a" },
    { re: /\bbreathtaking\s+(?:views?|vistas?|scenery|landscapes?)\b/gi, w: 4, name: "breathtaking views" },
    { re: /\btruly\s+unforgettable\b/gi, w: 4, name: "truly unforgettable" },
    { re: /\bsomething\s+for\s+everyone\b/gi, w: 4, name: "something for everyone" },
    { re: /\bdiscover\s+the\s+(?:power|potential|benefits|magic|secret)s?\b/gi, w: 4, name: "discover the power" },
    { re: /\bdisrupt(?:ive|ing|ion)?\s+the\s+(?:industry|market|space|status quo)\b/gi, w: 4, name: "disrupt the industry" },
    { re: /\bempower(?:ing|s)?\s+(?:you|users?|individuals?|businesses?|teams?)\s+to\b/gi, w: 4, name: "empowers you to" },
    { re: /\bdue\s+to\s+the\s+fact\s+that\b/gi, w: 4, name: "due to the fact that" },
    { re: /\bit\s+goes\s+without\s+saying\b/gi, w: 4, name: "it goes without saying" },
    { re: /\b(?:now|never)\s+more\s+(?:important|relevant|critical)\s+than\s+ever\b/gi, w: 4, name: "more important than ever" },
    { re: /\bnow\s+more\s+than\s+ever\b/gi, w: 4, name: "now more than ever" },
    { re: /\bin\s+an\s+(?:increasingly|ever|rapidly)\s+(?:digital|connected|global|complex|competitive)\b/gi, w: 4, name: "in an increasingly digital" },
    { re: /\bat\s+the\s+end\s+of\s+the\s+day\b/gi, w: 3, name: "at the end of the day" },
    { re: /\bdaunting\s+task\b/gi, w: 4, name: "daunting task" },
    { re: /\bthat'?s\s+where\s+[\w\s'-]{2,30}\s+comes?\s+in\b/gi, w: 5, name: "that's where X comes in" },
    { re: /\bgone\s+are\s+the\s+days\b/gi, w: 5, name: "gone are the days" },
    { re: /\bthe\s+possibilities\s+are\s+endless\b/gi, w: 5, name: "possibilities are endless" },
    { re: /\btake\s+your\s+[\w\s'-]{2,26}\s+to\s+the\s+next\s+level\b/gi, w: 5, name: "to the next level" },
    { re: /\bsay\s+goodbye\s+to\b/gi, w: 4, name: "say goodbye to" },
    { re: /\bin\s+a\s+world\s+where\b/gi, w: 4, name: "in a world where" },
    { re: /\b(?:dive|delve|step)\s+into\s+the\s+world\s+of\b/gi, w: 4, name: "into the world of" },
    { re: /\b(?:isn'?t|is\s+not)\s+just\s+[\w\s'-]{2,30}[,;—-]+\s*it'?s\b/gi, w: 4, name: "isn't just X, it's Y" },
    { re: /\bhere'?s\s+the\s+(?:thing|kicker|secret)\b/gi, w: 3, name: "here's the thing" },

    // ── Moderate tells ──
    { re: /\bcomprehensive\s+(?:guide|overview|analysis|resource|solution|suite|range)\b/gi, w: 3, name: "comprehensive guide" },
    { re: /\bultimate\s+guide\b/gi, w: 3, name: "ultimate guide" },
    { re: /\bstep-?by-?step\s+(?:guide|tutorial|instructions?)\b/gi, w: 3, name: "step-by-step guide" },
    { re: /\bkey\s+takeaways?\b/gi, w: 3, name: "key takeaways" },
    { re: /\bfinal\s+thoughts\b/gi, w: 3, name: "final thoughts" },
    { re: /\bin\s+summary\b/gi, w: 3, name: "in summary" },
    { re: /\bto\s+sum\s+up\b/gi, w: 3, name: "to sum up" },
    { re: /\bfirst\s+and\s+foremost\b/gi, w: 3, name: "first and foremost" },
    { re: /\blast\s+but\s+not\s+least\b/gi, w: 3, name: "last but not least" },
    { re: /\bthat\s+being\s+said\b/gi, w: 3, name: "that being said" },
    { re: /\bin\s+the\s+realm\s+of\b/gi, w: 3, name: "in the realm of" },
    { re: /\bat\s+the\s+forefront\s+of\b/gi, w: 3, name: "at the forefront of" },
    { re: /\bdive\s+deep(?:er)?\s+into\b/gi, w: 3, name: "dive deeper into" },
    { re: /\b(?:let'?s|let us)\s+(?:explore|dive|delve|unpack|break down)\b/gi, w: 3, name: "let's dive in" },
    { re: /\bit\s+is\s+worth\s+noting\b/gi, w: 3, name: "worth noting" },
    { re: /\bit\s+should\s+be\s+noted\b/gi, w: 3, name: "it should be noted" },
    { re: /\brobust\s+(?:solution|performance|infrastructure|framework|platform|security)\b/gi, w: 3, name: "robust solution" },
    { re: /\bscalable\s+(?:solution|architecture|infrastructure|platform)\b/gi, w: 3, name: "scalable solution" },
    { re: /\bdata-?driven\s+(?:insights|decisions|approach|strategy|strategies)\b/gi, w: 3, name: "data-driven insights" },
    { re: /\bstreamlin(?:e|ing|es|ed)\s+(?:your\s+)?(?:workflow|process|operations)\b/gi, w: 3, name: "streamline workflow" },
    { re: /\bplethora\s+of\b/gi, w: 3, name: "plethora of" },
    { re: /\bin\s+a\s+nutshell\b/gi, w: 3, name: "in a nutshell" },
    { re: /\bwithout\s+further\s+ado\b/gi, w: 3, name: "without further ado" },
    { re: /\bthe\s+bottom\s+line\s+is\b/gi, w: 3, name: "the bottom line is" },
    { re: /\bsuffice\s+it\s+to\s+say\b/gi, w: 3, name: "suffice it to say" },
    { re: /\bserves?\s+as\s+a\s+(?:testament|beacon|reminder|bridge)\b/gi, w: 3, name: "serves as a testament" },
  ];

  /* Precompiled structural regexes (built once, not per call) */
  const TRANSITIONS_RE = /\b(?:furthermore|moreover|additionally|consequently|therefore|however|nevertheless|nonetheless|meanwhile|subsequently|conversely|alternatively|similarly|likewise|in contrast|for example|for instance|specifically|particularly|notably|in fact|indeed|firstly|secondly|thirdly|finally|lastly|in addition|as a result|in conclusion|to summarize|overall)\b/gi;
  const ORDINAL_SEQ_RE = /\bfirst(?:ly)?\b[\s\S]{0,220}\bsecond(?:ly)?\b[\s\S]{0,220}\b(?:third(?:ly)?|finally|lastly|additionally)\b/i;
  const QUOTED_RE = /(?:"|“)[^"”]{8,80}(?:"|”)/g;

  /* ──────────────────────────────────────────────────────────────────
     Text-patterns signal
     ──────────────────────────────────────────────────────────────────
     1. Sum weighted lexicon hits (each pattern capped, default ×2).
     2. Add structural signals (uniform sentences, repeated starts,
        transition density, ordinal sequences, em-dash density,
        bullet spam).
     3. Normalize to a density per BASE_WORDS words so long text
        doesn't inflate and short text doesn't starve.
     4. Squash density through a logistic curve → 0–100.
  */
  const BASE_WORDS = 45;   // a typical title + snippet
  const MIN_WORDS = 25;    // shorter texts are treated as this long
  const DENSITY_MID = 20;  // density that maps to score 50
  const DENSITY_K = 7;     // curve steepness

  function scoreText(text) {
    if (!text || text.length < 40) return { score: 0, hits: [], markers: 0 };
    const t = String(text);
    const words = t.split(/\s+/).filter(Boolean).length;

    let raw = 0;
    const hits = [];
    const markers = (t.match(QUOTED_RE) || []).length; // quoted "facts"

    for (const p of PHRASES) {
      const matches = t.match(p.re);
      if (!matches) continue;
      const n = Math.min(matches.length, p.cap || 2);
      raw += n * p.w;
      hits.push(`${p.name} ×${n}`);
    }

    // Sentence-length uniformity (needs enough sentences to mean anything)
    const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
    if (sentences.length >= 4) {
      const lens = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      if (mean >= 6) {
        const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
        const cv = Math.sqrt(variance) / Math.max(mean, 1);
        if (cv < 0.22) { raw += 7; hits.push(`very uniform sentences (cv=${cv.toFixed(2)})`); }
        else if (cv < 0.32) { raw += 3; hits.push(`fairly uniform sentences (cv=${cv.toFixed(2)})`); }
      }

      // Repeated sentence starts ("It is… It is… It is…")
      let repeatedStarts = 0;
      for (let i = 1; i < sentences.length; i++) {
        const a = sentences[i - 1].trim().split(/\s+/)[0]?.toLowerCase();
        const b = sentences[i].trim().split(/\s+/)[0]?.toLowerCase();
        if (a && b && a === b && a.length > 2) repeatedStarts++;
      }
      if (repeatedStarts >= 2) { raw += repeatedStarts * 3; hits.push(`${repeatedStarts} repeated sentence starts`); }
    }

    // Transition-word density (min 3 occurrences AND elevated density)
    const transitionCount = (t.match(TRANSITIONS_RE) || []).length;
    const transitionDensity = words > 0 ? transitionCount / words : 0;
    if (transitionCount >= 4 && transitionDensity > 0.06) { raw += 7; hits.push(`high transition density (${transitionCount})`); }
    else if (transitionCount >= 3 && transitionDensity > 0.04) { raw += 4; hits.push(`elevated transitions (${transitionCount})`); }

    // "Firstly … Secondly … Finally" scaffolding
    const hasScaffold = ORDINAL_SEQ_RE.test(t);
    if (hasScaffold) { raw += 6; hits.push("firstly/secondly/finally scaffold"); }

    /* Co-occurrence bonus. An enumerated scaffold OR a formulaic wrap-up
       is individually weak — plenty of human how-to writing has one.
       Both inside one short passage is the shape of a generated
       template, and it's the signature that "lightly edited AI" (where
       the surface vocabulary has been cleaned up but the skeleton
       survives) most reliably keeps. */
    const hasWrapUp = /\b(?:in\s+conclusion|to\s+sum\s+up|in\s+summary|final\s+thoughts|key\s+takeaways?|the\s+bottom\s+line)\b/i.test(t);
    const hasOpener = /\b(?:can\s+(?:feel|seem|be)\s+(?:like\s+)?(?:a\s+)?(?:daunting|overwhelming|challenging|intimidating)|doesn'?t\s+have\s+to\s+be)\b/i.test(t);
    if (hasScaffold && hasWrapUp) { raw += 7; hits.push("scaffold + formulaic conclusion"); }
    if (hasOpener && (hasScaffold || hasWrapUp)) { raw += 5; hits.push("difficulty-opener + template structure"); }

    // Em-dash density — only well above the human baseline
    const dashCount = (t.match(/—/g) || []).length;
    if (words > 0 && dashCount >= 3 && dashCount / words > 0.04) {
      raw += 5; hits.push(`high em-dash density (${dashCount} in ${words}w)`);
    }

    // Bullet spam
    const bulletLines = (t.match(/^\s*[•\-\*]\s+/gm) || []).length;
    if (bulletLines >= 4) { raw += 4; hits.push(`${bulletLines} bullet lines`); }

    // Length-normalized density → logistic squash
    const density = raw * (BASE_WORDS / Math.max(words, MIN_WORDS));
    const score = Math.round(100 / (1 + Math.exp(-(density - DENSITY_MID) / DENSITY_K)));
    // Zero-evidence floor: no hits at all should read as 0, not the
    // logistic's ~6% asymptote.
    return { score: raw === 0 ? 0 : Math.min(100, score), hits, markers };
  }

  /* ──────────────────────────────────────────────────────────────────
     Author / byline signal
     ──────────────────────────────────────────────────────────────────
     Snippet-only (privacy: we never fetch the page). A visible named
     human byline is a strong human signal; AI self-disclosure is a
     near-certain AI signal. Missing byline is NOT penalized — SERPs
     truncate them all the time.
     NOTE: the name-shape regexes are intentionally case-SENSITIVE.
     v1 used /i here, which made "by using these tips" match as a
     human name.
  */
  const NAME_SHAPE = /\b[Bb]y\s+([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+)/;
  const NOT_A_NAME = /staff|ai\b|bot|admin|editor|team|guest|contributor/i;

  function scoreAuthor({ byline, text }) {
    const t = String(text || "");
    let raw = 25; // neutral baseline — slightly human-leaning

    if (byline) {
      const m = String(byline).match(NAME_SHAPE) || String(byline).match(/^([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+)$/);
      if (m && !NOT_A_NAME.test(m[1])) raw -= 22;
      else if (/staff writer|editor|admin/i.test(byline)) raw += 12;
    }

    const inline = t.match(NAME_SHAPE);
    if (inline && !NOT_A_NAME.test(inline[1])) raw -= 15;

    // Self-disclosed AI — highest-confidence tell we have
    if (/\b(?:ai[- ]generated|written by ai|created with ai|generated by ai|powered by ai)\b/i.test(t)) raw += 45;
    if (/\bposted by (?:admin|moderator|team|staff)\b/i.test(t)) raw += 10;

    return Math.max(0, Math.min(100, raw));
  }

  /* ──────────────────────────────────────────────────────────────────
     Domain signal
     ──────────────────────────────────────────────────────────────────
     URL-shape only. Matching is done on the parsed hostname
     (v1 used substring-matching on the whole URL, so
     "evil.example/nytimes.com" matched the whitelist).
  */

  /* Established human-edited outlets. This is about editorial process
     (human writers + editors), NOT endorsement of any outlet's views.
     Deliberately excluded: open platforms (Medium, Substack, Quora,
     Forbes /sites/ contributors) where AI content is common. */
  const REPUTABLE_DOMAINS = [
    // Wire services & national/international news
    "reuters.com", "apnews.com", "afp.com", "bbc.com", "bbc.co.uk",
    "nytimes.com", "wsj.com", "washingtonpost.com", "theguardian.com",
    "ft.com", "economist.com", "bloomberg.com", "npr.org", "pbs.org",
    "latimes.com", "chicagotribune.com", "bostonglobe.com",
    "seattletimes.com", "usatoday.com", "cbsnews.com", "nbcnews.com",
    "abcnews.go.com", "cnn.com", "time.com", "axios.com", "politico.com",
    "propublica.org", "theatlantic.com", "newyorker.com", "vox.com",
    "slate.com", "motherjones.com", "theintercept.com",
    // Science & reference
    "nature.com", "science.org", "scientificamerican.com",
    "nationalgeographic.com", "smithsonianmag.com", "arxiv.org",
    "pubmed.ncbi.nlm.nih.gov", "wikipedia.org", "britannica.com",
    "jstor.org", "ieee.org", "acm.org", "plos.org",
    // Tech press
    "arstechnica.com", "theverge.com", "wired.com", "techcrunch.com",
    "engadget.com", "cnet.com", "zdnet.com", "404media.co", "hbr.org",
    // Developer / community (human-authored Q&A and code)
    "github.com", "stackoverflow.com", "stackexchange.com", "reddit.com",
    "news.ycombinator.com", "lwn.net",
  ];

  const LOW_TRUST_TLD = [".click", ".xyz", ".buzz", ".top", ".loan", ".work", ".kim", ".icu", ".cfd", ".sbs", ".lol"];
  const AI_TLD_SKEW = [".ai", ".io"];

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
    catch (e) {
      try { return new URL("https://" + url).hostname.toLowerCase().replace(/^www\./, ""); }
      catch (e2) { return ""; }
    }
  }
  function pathOf(url) {
    try { return new URL(url).pathname.toLowerCase(); }
    catch (e) { return String(url || "").toLowerCase().replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0]; }
  }
  function matchesDomain(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }
  function isReputable(host) {
    if (!host) return false;
    for (const d of REPUTABLE_DOMAINS) if (matchesDomain(host, d)) return true;
    return false;
  }
  function hostEndsWith(host, suffixes) {
    for (const s of suffixes) if (host.endsWith(s)) return s;
    return null;
  }

  function scoreDomain(url) {
    if (!url) return 0;
    const host = hostOf(url);
    const path = pathOf(url);
    let raw = 0;
    const hits = [];

    const low = hostEndsWith(host, LOW_TRUST_TLD);
    if (low) { raw += 12; hits.push(`low-trust TLD ${low}`); }
    else {
      const skew = hostEndsWith(host, AI_TLD_SKEW);
      if (skew) { raw += 5; hits.push(`TLD ${skew}`); }
    }

    if (isReputable(host)) { raw -= 30; hits.push(`known publication: ${host}`); }

    // SEO-bait slug: long hyphen chains, numbered listicles
    const lastSlug = path.split("/").filter(Boolean).pop() || "";
    const hyphenCount = (lastSlug.match(/-/g) || []).length;
    if (hyphenCount >= 6) { raw += 14; hits.push(`${hyphenCount}-hyphen slug`); }
    else if (hyphenCount >= 4) { raw += 7; hits.push(`${hyphenCount}-hyphen slug`); }
    if (/\d/.test(lastSlug) && hyphenCount >= 3) { raw += 4; hits.push("numbered listicle slug"); }

    // Explicitly machine-labeled paths
    if (/\/(?:ai-generated|auto-generated|llm-generated)\//.test(path)) { raw += 15; hits.push("AI-generated path"); }
    if (/^(?:ai|auto|bot|generated)\./.test(host)) { raw += 8; hits.push("AI subdomain"); }

    return Math.max(0, Math.min(100, raw + 25)); // re-baseline: neutral domains read ~25
  }

  /* ──────────────────────────────────────────────────────────────────
     Trust score — deterministic domain reputation, 0–100
     (v1 mixed Math.random() into every band.)
  */
  const TECH_DOCS_DOMAINS = [
    "google.com", "developers.google.com", "microsoft.com", "learn.microsoft.com",
    "apple.com", "developer.apple.com", "mozilla.org", "developer.mozilla.org",
    "amazon.com", "docs.aws.amazon.com", "cloudflare.com", "vercel.com",
    "netlify.com", "gitlab.com", "bitbucket.org", "npmjs.com", "python.org",
    "rust-lang.org", "go.dev", "kubernetes.io", "docker.com",
  ];

  function scoreTrust(url) {
    if (!url) return 50;
    const host = hostOf(url);
    if (!host) return 50;

    if (isReputable(host)) return 90;
    if (/\.(edu|gov|mil)$/.test(host) || /\.(edu|gov)\.[a-z]{2}$/.test(host)) return 85;
    for (const d of TECH_DOCS_DOMAINS) if (matchesDomain(host, d)) return 78;
    if (hostEndsWith(host, LOW_TRUST_TLD)) return 20;
    if (/\.(blogspot|wordpress|weebly|wixsite|squarespace|tumblr)\./.test(host) ||
        matchesDomain(host, "medium.com") || host.endsWith(".substack.com")) return 45;
    if (hostEndsWith(host, AI_TLD_SKEW)) return 42;
    return 50;
  }

  /* ──────────────────────────────────────────────────────────────────
     Calibration — user-controlled sensitivity.
     Scales around a pivot so "low" compresses toward the pivot but
     extreme evidence can still cross the Likely-AI line, and "high"
     spreads scores outward.
  */
  let CAL = "med";
  const CAL_GAMMA = { low: 1.45, med: 1.0, high: 0.78 };

  function setCalibration(level) { if (CAL_GAMMA[level]) CAL = level; }
  function getCalibration() { return CAL; }

  /* ──────────────────────────────────────────────────────────────────
     Combine — text 65%, author 15%, domain 20%, then gamma-scale.
     Gamma keeps the curve anchored at 0 and 100:
       low  (γ 1.45) compresses mid scores — only extreme evidence
            still crosses the Likely-AI line;
       high (γ 0.78) stretches mid scores upward — more sensitive.
     (v1 multiplied the whole score, which capped "low" at 55 and made
     the Likely-AI band unreachable at that setting.)
  */
  function combine(textScore, authorScore, domainScore) {
    const weighted = textScore * 0.65 + authorScore * 0.15 + domainScore * 0.20;
    const g = CAL_GAMMA[CAL] || 1.0;
    const scaled = 100 * Math.pow(Math.max(0, Math.min(100, weighted)) / 100, g);
    return Math.max(0, Math.min(100, Math.round(scaled)));
  }

  /* ──────────────────────────────────────────────────────────────────
     Public API (unchanged shape)
     ────────────────────────────────────────────────────────────────── */
  function score(input, opts = {}) {
    const text = String(input || "");
    const url = opts.url || "";
    const byline = opts.byline || "";

    const t = scoreText(text);
    const a = scoreAuthor({ byline, text });
    const d = scoreDomain(url);
    const overall = combine(t.score, a, d);
    const trust = scoreTrust(url);

    const reasons = [...t.hits.slice(0, 4)];
    if (byline) reasons.push(`byline: "${byline}"`);
    if (d > 60) reasons.push("URL flagged");
    if (d < 20) reasons.push("URL looks normal");

    return { text: t.score, author: a, domain: d, overall, trust, reasons };
  }

  const api = { score, scoreText, scoreAuthor, scoreDomain, scoreTrust, combine, setCalibration, getCalibration };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AIScore = api;
})(typeof window !== "undefined" ? window : globalThis);
