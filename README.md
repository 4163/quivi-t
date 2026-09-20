# QuiviT website extractors

This orphan branch hosts the runtime registry and site extractors for QuiviT web imports.

QuiviT fetches `manifest.json` and matching extractor scripts directly from this branch at runtime. Maintainers can add or update individual website extractors here without rebuilding or releasing the main desktop application.

## How it works

1. A user triggers Open URL (`Ctrl+I`) in QuiviT and pastes a link.
2. QuiviT checks `manifest.json` on this branch to find a matching pattern.
3. The app downloads the matching extractor script, caches it under `%LOCALAPPDATA%/QuiviT/extractor-cache/`, and loads it as a dynamic ES module.
4. The extractor returns image URLs and gallery metadata. QuiviT then downloads the images to the user's Library.

## Repository layout

All files in this branch live at the root:

- `manifest.json`: Registry listing available extractors, URL patterns, versions, and source paths.
- `<site>.js`: Self-contained extractor scripts (for example, `imgur.js`).
- `README.md`: Authoring contract and contribution guidelines.

## Manifest schema

`manifest.json` uses version 1:

```json
{
  "version": 1,
  "extractors": [
    {
      "id": "imgur",
      "name": "Imgur",
      "libraryPath": "Imgur",
      "version": 1,
      "source": "imgur.js",
      "patterns": [
        "^https?:\\/\\/(?:[a-zA-Z0-9-]+\\.)?imgur\\.com\\/(?:a|gallery)\\/[a-zA-Z0-9]+",
        "^https?:\\/\\/(?:i\\.)?imgur\\.com\\/[a-zA-Z0-9]+(\\.[a-zA-Z0-9]+)?$"
      ]
    }
  ]
}
```

### Manifest fields

- `id`: Unique identifier using lower-case letters, numbers, and hyphens.
- `name`: Human-readable name used in status labels.
- `libraryPath`: Directory name where downloaded galleries land under the user Library.
- `version`: Positive integer. Bump this number whenever you update an extractor script so running clients invalidate their module cache.
- `source`: Relative filename for the extractor script. Must end in `.js`. Path traversal is rejected.
- `patterns`: Array of regular expression strings tested against user URLs.

## Extractor module contract

An extractor must be an ES module exporting two functions: `match(url)` and `extract(html, url, context)`.

```js
export function match(url) {
  return /^https?:\/\/(?:[a-zA-Z0-9-]+\.)?example\.com\/gallery\/\d+/i.test(url);
}

export async function extract(html, url, context) {
  // Use context.fetchText(pageUrl) for extra pages or API calls.
  return {
    provider: 'Example',
    title: 'Gallery Title',
    gallery: {
      id: 'gallery-123',
      relativePath: ['Category', 'Gallery Title']
    },
    images: [
      {
        url: 'https://cdn.example.com/images/001.jpg',
        filename: '001.jpg',
        description: 'Page 1'
      }
    ],
    nextPageUrl: null
  };
}
```

### Return object fields

- `provider`: String matching the `name` defined in `manifest.json`.
- `title`: String gallery name.
- `gallery.id`: Stable unique identifier for the gallery on that site.
- `gallery.relativePath`: Array of safe directory names under `libraryPath`. Maximum depth is 8.
- `images`: Array of media entries with direct HTTP or HTTPS download URLs and safe filenames.
- `targetFilename`: Optional string filename of a target image within `images`. When specified, QuiviT eagerly downloads this image first, opens the viewer centered on it, and prefetches remaining images around it.
- `nextPageUrl`: Next page URL for multi-page galleries, or `null` when complete. Consecutive pages must preserve identical `gallery.id` and `gallery.relativePath`.

### Safety rules

- Extractors must be pure data parsers. Do not import external packages, touch window globals, or mutate DOM.
- Path segments and filenames must not contain path separators (`/` or `\`), traversal segments (`..`), or Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
- File extensions must be supported media formats: `jpg`, `jpeg`, `png`, `gif`, `webp`, `apng`, `avif`, `svg`, `bmp`, `ico`, or `mp4`.
- Duplicate filenames within one gallery are rejected.

## Verified test galleries

The following sample galleries are verified working in QuiviT and serve as reference test suites to track provider features, format support, and URL routing edge cases:

| Provider | Title | Format | Items | Status | Edge Cases Covered | Source URL |
| :--- | :--- | :--- | :---: | :--- | :--- | :---: |
| Imgur | Anime Reaction Gifs | `.gif` | 50 | Working | Large animation batch (50 items), download concurrency | [Link](https://imgur.com/gallery/anime-reaction-gifs-ADdqF) |
| Imgur | Azuma - Seihantai | `.png` | 41 | Working | Album `/a/` route, multi-image manga set, description parsing | [Link](https://imgur.com/a/azuma-seihantai-17vF37d) |
| Imgur | Just some Witch Watch OP clips | `.mp4` | 8 | Working | Video extraction, hashtag route (`#/t/anime`) | [Link](https://imgur.com/gallery/just-some-witch-watch-op-clips-2Bi48Dm#/t/anime) |
| Imgur | Direct image sample | `.png` | 1 | Working | Direct CDN image URL (`i.imgur.com`), gallery match lookup or root download | [Link](https://i.imgur.com/4Q6rSDi.png) |
| MangaDex | Akebi-chan no Sailor Fuku, Ch. 1 | `.jpg` | 33 | Working | Chapter `/chapter/{id}` route, REST API payload, chapter folder formatting, `@home` delivery | [Link](https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d) |
| MangaDex | Akebi-chan no Sailor Fuku (Chapters) | `.jpg` | Series | Working | Series `/title/{id}` route with `?tab=chapters`, feed pagination, volume and group folder hierarchy, series sidecar | [Link](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=chapters) |
| MangaDex | Akebi-chan no Sailor Fuku (Covers) | `.jpg` | Covers | Working | Art gallery `/title/{id}?tab=art`, multi-locale pagination, zero-padded volume filenames, bracketed descriptions, root loose cover cleanup | [Link](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=art) |
| MangaDex | Akebi-chan no Sailor Fuku - Vol. 16 Cover | `.jpg` | 1 | Working | Direct cover URL `/covers/{mangaId}/{fileName}`, friendly name resolution via API, root `gallery.json` recording and deduplication | [Link](https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg) |
| MangaDex | Reader blob URL | N/A | 0 | Rejected | Browser ephemeral blob URL detection, rejected with descriptive guidance to use chapter URL | [Link](blob:https://mangadex.org/a357d5db-d810-4566-b0aa-cba411aa9460) |

## Authoring and testing workflow

Maintainers work on this branch through a Git worktree:

```bash
git worktree add ../quivi-t-extractors extractors
```

When changing an extractor:
1. Update or create the `<site>.js` script.
2. Bump the extractor's `version` integer in `manifest.json`.
3. Commit both files together in a single commit on this branch.
4. Push the branch to `origin extractors`.
