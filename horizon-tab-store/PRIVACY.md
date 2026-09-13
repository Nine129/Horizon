# Horizon Tab — Privacy

Horizon Tab is a new tab page. It is built to collect as little as possible.

## What the extension does

- Replaces the new tab page with a minimal dashboard: clock, greeting, weather, shortcut tiles, and quick links.
- Searches you run from the page go through your browser's own default search engine via the Chrome Search API. Horizon never chooses a search engine for you and never reads or stores your queries.
- Settings (theme, background image, quick links, weather coordinates) are stored locally in your browser profile via chrome.storage. Nothing is uploaded.

## Network requests

- Weather: the page asks api.weather.gov for the forecast at the configured coordinates (default: a fixed US location, or the coordinates you set in Settings). The response is cached locally for 10 minutes. If you set custom coordinates, those coordinates are what get sent to the National Weather Service. Nothing else is sent.
- Quick-link icons: if you leave the icon field blank, the page fetches a favicon via Google's favicon service (google.com/s2/favicons) for that domain. This is a standard browser convenience; no query data is involved.
- Tile links and quick links are plain links. Clicking one navigates your browser normally — the same as typing the URL.

## What Horizon does NOT do

- No analytics, no tracking pixels, no telemetry.
- No ads, no affiliate links, no injected content on other websites.
- No remote code. Everything runs from the files inside the extension.
- No reading of your browsing history, bookmarks, or open tabs.

## Data stored on your device

- chrome.storage.sync: your settings (theme, links, toggles) so they follow your Chrome profile.
- chrome.storage.local: your background image and the cached weather response.

All of it is deleted if you remove the extension.

Questions: open an issue on the GitHub repository.
