# Horizon

A minimal, beautiful, customizable new tab page. Your horizon, your way.

Clock, greeting, weather, shortcut tiles, quick links, five themes, custom backgrounds, glass intensity, and more. No accounts, no ads, no tracking.

## Two builds, one project

Horizon ships in two flavors because the Chrome Web Store's single-purpose policy treats a new tab page and a search-engine switcher as two separate products.

| Build | Where it lives | What's inside |
| --- | --- | --- |
| `horizon-tab` | Load unpacked (any Chromium browser, Firefox) | The full build: multi-engine search drawer (8 web engines, 6 AI chats, 14 store searches), bangs, filters, refiners, AI Signal, prompt bridge. |
| `horizon-tab-store` | Chrome Web Store listing | The compliant store build: same dashboard, but the search box always uses *your* default search engine (Chrome Search API), and AI chats / stores appear as plain shortcut tiles. |

The store build exists so Horizon can be installed with one click. The full build exists because it is the real product. Both share the same theme engine, settings, and design language — and the same `hz` storage keys, so switching between them keeps your settings.

## Install

### Chrome Web Store (one click)

Horizon Tab is available on the Chrome Web Store (store build).

### Load unpacked — full build

1. Download `dist/horizon-tab-full-<version>.zip` (or clone the repo).
2. Unzip anywhere permanent.
3. Chrome / Edge / Brave: open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, select the `horizon-tab/` folder.
4. Firefox: open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, select `manifest.json` inside `horizon-tab/`.

### Load unpacked — store build

Same steps, pointing at `horizon-tab-store/`. This is also the build whose code matches the Web Store listing exactly.

## Features (full build)

- **Search drawer** — one box, three tabs: web search (8 engines), AI chat (6 providers), and store search (14 retailers). Pick your default per tab; switch with one click.
- **Bangs** — `!yt kittens`, `!gh syncthing`, `!a usb cable`. One-off redirects that never touch your saved settings.
- **Filters** — verticals (All / News / Images / Video) plus combinable refiners (Reddit, Academic, PDF, Exact, Recent) and per-engine AI-Free mode.
- **AI Signal** — an optional, fully on-device heuristic that flags AI-flavored writing on search results.
- **Dashboard** — live clock and greeting, National Weather Service forecast, quick links, custom background with auto dim/blur, five themes (Slate, Ivory, Navy, Modern, Custom), glass intensity, text color override.
- **Prompt bridge** — optional auto-fill for AI chats that ignore prefilled links (Gemini, DeepSeek).

## Why the split exists

Google's single-purpose policy (violation "Red Argon") requires that a new tab page which includes a search experience respects the user's selected search settings by using the Chrome Search API. That rule is designed to stop new-tab hijacks, and it applies to everyone — including extensions like this one. Rather than ship one neutered product, Horizon ships two builds: the compliant one on the store, the full one here.

## Privacy

See [PRIVACY.md](horizon-tab-store/PRIVACY.md). Short version: settings live in your browser profile, weather comes from api.weather.gov, nothing is uploaded, there are no ads or analytics.

## License

MIT — see [LICENSE](horizon-tab/LICENSE).
