# Horizon AI Signal

Detect AI-generated text on search results and web pages — a private, on-device heuristic.

AI Signal is a "smell test" for AI-flavored writing. On Google, DuckDuckGo, and Brave it shows a badge on each search result with an estimated AI score, and can auto-hide high-scoring results. An optional Page Detector adds a floating score to article pages you visit.

## Features

- **SERP badges** — each search result gets an "AI: NN%" pill with a breakdown of why it scored that way.
- **Sensitivity** — Low / Medium / High bend the score curve; the default is conservative on purpose.
- **Auto-hide** — results scoring at or above a threshold collapse to a hover-to-expand line.
- **Per-domain dismissal** — dismiss any domain once and it never shows a badge again.
- **Page detector (optional)** — a floating score on article pages, opt-in and off by default.
- **Safe Browsing (optional)** — if you add your own Google Safe Browsing API key, the page detector warns on flagged sites.

## How it works

Every score is a **heuristic estimate, not a verdict**. AI Signal weighs:

- **Text patterns** — a curated lexicon of ~80 AI-isms ("delve into", "navigate the complexities", "in today's digital landscape"…), each capped so repetition can't max the score, plus sentence-length uniformity, "Firstly…Secondly…Finally" scaffolding, transition-word and em-dash density.
- **Author / byline** — named humans pull the score down; self-disclosed "AI-generated" pulls it up.
- **Domain signals** — URL shape and a curated list of human-edited publications.

All analysis runs entirely on-device on the title and snippet already shown on the page. It never fetches article bodies, and nothing is uploaded anywhere.

## Honest limitations

- False positives: formal human prose (legal briefs, dense academic writing) can be flagged.
- False negatives: lightly-edited AI text usually passes.
- No detection of AI images, audio, or video.

Treat it as a first-pass hint, never as proof.

## Privacy

Local-first. No accounts, no analytics, no tracking. Settings and dismissed domains live in `chrome.storage.sync`. The only network call is the optional Safe Browsing check, and only if you add your own API key.

## Install (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Permissions

- `storage` — save your settings and dismissed domains.
- `scripting` — register the optional page detector only when you turn it on.
- Optional host permission `<all_urls>` — only if you enable the page detector.
- `safebrowsing.googleapis.com` — only if you add your own Safe Browsing API key.

## License

[MIT](LICENSE)
