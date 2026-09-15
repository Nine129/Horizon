# Contributing

Horizon is open source and meant to be built on. You don't need permission to fork it, change it, or ship your own version — that's the point of releasing it.

## Ways to contribute

- **Add a search source.** `tab.js` has plain-object tables for web engines (`SE`), AI providers (`AI`), stores (`SHOP`), and bangs (`BANGS`). Adding one is usually a one-line change.
- **Fix a bug or improve the UI.** Open an issue or a PR.
- **Port it.** Firefox support is already declared in the manifest; other Chromium forks should work as-is.
- **Build on the pieces.** The AI Signal scorer (`aiscan/score.js`) is a self-contained module — take it and use it somewhere else.

## Structure

- `horizon-tab/` — the full build (load unpacked). The real product.
- `horizon-tab-store/` — the Chrome Web Store build ("Horizon Tab").
- `horizon-ai-signal/` — the Chrome Web Store build ("Horizon AI Signal").
- `dist/` — prebuilt zips.

## Conventions

- **No build step.** Everything is plain HTML/CSS/JS — load the folder and go.
- **Keep the privacy promise.** Local-first, no trackers, no accounts, nothing uploaded.
- **Comment the *why*.** The codebase already documents its non-obvious decisions; follow that habit.

## Submitting changes

1. Fork, branch, change.
2. Open a PR with a clear description of what and why.
3. **Never commit secrets.** API keys are always user-provided — for example, the Safe Browsing key is entered in settings and stored in the browser, never in source.
