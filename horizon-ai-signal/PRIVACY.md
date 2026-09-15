# Privacy Policy — Horizon AI Signal

**Last updated:** September 2026

Horizon AI Signal is a local-first browser extension. It does **not** collect, store, or transmit any personal data to the developer, and it has no accounts, no analytics, and no advertising or tracking SDKs.

## What the extension stores

Your settings — sensitivity, auto-hide threshold, dismissed domains, and user marks — are stored **locally in your browser** via Chrome's `chrome.storage` API (and sync between your own devices through Chrome Sync, if enabled). None of it is sent to any server, because there is no server.

## What the extension reads

AI Signal reads only the **title and snippet already shown on a search results page** (or the article text, if you opt into the Page Detector). The analysis runs entirely on-device; no page content is uploaded anywhere.

## Network requests the extension makes

| Feature | Destination | What is sent |
|---|---|---|
| Safe Browsing (optional) | `safebrowsing.googleapis.com` | The hostname of a page you visit — **only** if you have explicitly added your own Google Safe Browsing API key. Without a key, no request is made. |

## AI Signal is a heuristic, not a verdict

AI Signal is a statistical "smell test." It can and will produce false positives (formal human writing flagged as AI) and false negatives (lightly-edited AI text that passes). Treat it as a first-pass hint, never as proof.

## Contact

For privacy questions, open an issue on the project's repository or contact the developer.
