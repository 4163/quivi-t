# Kmanga implementation plan

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md`. This is a plan, no code changed. It follows the urlLoader forefront goal: extractor work must reach users through the remote branch with zero QuiviT releases, except for one small generic backend addition.

## Goal

Let `mangadex.js` resolve K-Manga `externalUrl` chapters and let users import K-Manga episodes directly, without a desktop release per site change. Two mechanisms, in slice order:

1. Tile descramble as a declared extractor capability, backed by one small generic backend addition.
2. Branch files only: a `kmanga.js` entry, a `shared/kmanga.js` client, one manifest entry, and a MangaDex stub branch.

Non-goals: POST form fetch, title detail and title list APIs, genre API, login or ticket flows, paid chapter unlocking, ranking or search browsing, the `s.kmanga` short link host.

## Verified starting facts

Probed live on 2026-09-21 against title 10072 episode 311334. Vectors below are recorded, not guessed.

- Episode page HTML carries everything except page images. `__NUXT_DATA__` embeds `web_title` with title name, author text, synopsis, genre ids, banner and `title_grid_wide` cover URLs, plus the full `episode_id_list` in order. Each episode block carries `episode_name`, `start_time`, `page_count`, and `point`. Visible details add release date, `Book Length: 74 pages`, and `Price: Free Manga`. The extractor parses HTML the way `imgur.js` parses embedded JSON. No title detail API needed.
- Viewer API is one GET: `https://se-api.kmanga.kodansha.com/web/episode/viewer?episode_id=<id>`. Only `episode_id` sits in the query. The plain `api.` host answers identically, but the plan mirrors the browser and uses `se-api` for viewer calls.
- Auth is four headers with logged out values: `X-Kmanga-Platform: 3`, `x-kmanga-client-id: 0`, `x-kmanga-is-crawler: false`, `X-Kmanga-Hash: <sha512 hex>`. The hash construction from KManga.kt replays exactly in Node against the captured vector, params `{episode_id: 311334}`, birthday `1999-01`, expiry `1821414265`. A cookieless replay with the `2000-01` fallback returns 200 on both hosts. The backend never sends `Cookie`, and it does not need to. Hash code lives in `crypto.subtle`, no new capability needed for it.
- Viewer 200 for 311334 returns `scramble_seed: r7yw738iu3`, consistent with the even title alphabet, and 74 signed `web_titles` page URLs. The count matches the HTML page count. Signatures expire in about 20 days, matching `imageCdnSignedExpiresLimit`, so page URLs are never stored. `next_episode` points at 311335. Episode list POST went to the `api.` host, which the plan avoids using at all.
- Page images fetch with plain GET and no headers: 200 `image/jpeg`, 494KB, 1600 by 2182 for page one. Tile math for that size gives 400 by 544 tiles. One page is saved at `Temp/opencode/kmanga-page1.jpg` for the descramble check.
- Lock rule reads as free equals `point: 0` with `use_status: 3`. Paid episodes show `point: 69` with `use_status: 4`. Rental flags vary and are not trusted alone. Without episode list POST, series stubs cannot know lock state upfront, so locked episodes resolve lazily and fail at open time with the rent message. That matches the MANGA Plus precedent of reporting gaps instead of guessing.
- Title URL `/title/10072` renders the same episode content with canonical pointing at the episode, so the title route is handled as a series import from HTML, not as a redirect to chase.
- MangaDex research in `.agents/mangadex-external-providers.md` confirms the external shape `/title/<titleId>/episode/<episodeId>`, group K-Manga `7c5fb223`, and the placeholder page count quirk. Key off `externalUrl != null`, never off page count.
- Loader facts from the tree: `resolveUnresolvedGallery` at `src/js/urlLoader.js:2082` re-matches stub `sourceUrl` through the manifest, so K-Manga stubs route with no orchestrator change. `_validateImage` at `:85` needs the new descriptor key. Queue items at `:253`, attempt options at `:475`, and eager downloads with `dlOpts` already thread `headers` and `decryption`, so the new descriptor follows the same path. Unknown `quivit-needs` tokens fail fast at `:715`. Provider string must equal manifest `name` at `:776`.

## Design

### HTML first extraction

The episode page is the series API. For episode URLs the extractor reads series metadata, episode metadata, and cover URLs from the HTML, then calls viewer once for `scramble_seed` and `page_list`. For title URLs it reads `web_title` and `episode_id_list` from the HTML and emits index named stubs that resolve lazily. Per episode names and lock flags refine at resolve time through the same viewer call. Direct CDN URLs keep the full signed query and use a hashed fallback filename.

### Hash helper

`shared/kmanga.js` exports a pure hash function taking params, birthday, and expiry, using `crypto.subtle` sha256 and sha512. Default birthday is `2000-01` with expiry ten years out, matching the KManga.kt logged out path. The recorded vector for episode 311334 is the unit test, hardcoded as the expected digest.

### Descramble descriptor

Image items gain an optional descriptor next to `headers` and `decryption`:

```js
descramble: { algorithm: 'kmanga-tiles', seed: 'r7yw738iu3', titleId: 10072, episodeId: 311334 }
```

The loader validates the shape and forwards it untouched. The backend decodes the temp file, unshuffles the 4 by 4 grid per the ripper tile math, and re-encodes before the atomic rename. Unknown algorithms error. The capability token is `tileDescramble`, declared in `quivit-needs` only after the backend ships, since the loader fails fast on unknown names.

### Branch layout

```text
extractors/
  manifest.json            # new kmanga entry plus mangadex version bump
  imgur.js                 # untouched
  mangadex.js              # header plus K-Manga externalUrl branch
  kmanga.js                # thin entry shell over shared client
  shared/
    sanitize.js            # unchanged
    proto.js               # unchanged
    mangaplus.js           # unchanged
    kmanga.js              # hash helper, episode id parse, viewer call
```

Suggested manifest entry:

```json
{
  "id": "kmanga",
  "name": "K-Manga",
  "libraryPath": "KManga",
  "version": 1,
  "source": "kmanga.js",
  "patterns": [
    "^https?://kmanga\\.kodansha\\.com/title/\\d+/episode/\\d+",
    "^https?://kmanga\\.kodansha\\.com/title/\\d+",
    "^https?://cdn\\.kmanga\\.kodansha\\.com/.+\\.(jpg|jpeg|png|webp)(\\?.*)?$"
  ]
}
```

### MangaDex wiring

A K-Manga branch sits parallel to the MANGA Plus branch in the feed loop. Clean the `externalUrl`, strip tracking query, dedupe by cleaned URL, suffix folders and titles with ` (K-Manga)`, set scanlator to `K-Manga`. Single chapter opens route K-Manga externals to stubs instead of the generic external service error.

## Slices

### Slice 1: tile descramble capability. Rust plus loader.

Backend: `descramble` param on `download_to_file`, applied to the temp file before rename, key cycled per the xor precedent, registration unchanged. Loader: `tileDescramble` in the capability set, descriptor validation in `_validateImage`, threading through queue items, attempts, eager downloads, sidecar round trip, and resume.

Accept: `cargo check --tests`, `cargo test network::tests` with a tile round trip test, `npm test`, plus one descrambled page from the saved fixture opening unshuffled. The fixture URLs expire, so re-fetch the viewer response first if the saved page fails.

### Slice 2: branch extractor. No app code.

`shared/kmanga.js`, `kmanga.js`, manifest entry at version 1. Episode, title, and direct CDN routes with the recorded 311334 vector as the contract test.

Accept: `node --check` on new files, new mocha cases for match, direct parse with signed query preserved, gallery and series validation, hash digest equality, and xorshift order for the recorded seed triple. Live import of episode 311334 from a residential IP.

### Slice 3: MangaDex stub wiring. Branch only.

External branch, shared import, `mangadex` version bump, README verified table rows. Both files ship in one commit on the extractors branch through a worktree.

Accept: mocha suites green, one MangaDex series with K-Manga externals showing suffixed stubs that resolve on open, locked episodes erroring with the rent message instead of silent drops.

## Open risks

- Hash rotation. If viewer calls start returning 400 for correct code, re-pull the `_nuxt` chunk and diff the join order. The recorded vector pins the current form.
- Signed URL lifetime. Page URLs live about 20 days. Never persist them. Re-resolve on every open.
- Region variance. A PH exit returned 200 for this title, but blocks may be title specific. Keep the readable region error.
- Paid coverage. Series imports list paid episodes as stubs without lock marks in v1. Opening one explains the paywall instead of pretending it is free.
- Cache capacity counts graphs now. The new shared file adds one node per load, no tuning needed.
- Stale local checkouts shadow the remote branch through the local first dev path. Re-check dep behavior against remote fetch before shipping.
