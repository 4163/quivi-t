# QuiviT website extractors

Orphan branch hosting the runtime extractor registry for QuiviT web imports. Extractors are fetched, cached, and loaded as dynamic ES modules at runtime, so site support ships without a desktop release.

## Runtime flow

1. User pastes a URL via Open URL (`Ctrl+I`).
2. `urlLoader.js` fetches `manifest.json` from this branch, matches the URL against `patterns`.
3. The matched extractor script is downloaded, cached under `%LOCALAPPDATA%/QuiviT/extractor-cache/`, and loaded as an ES module.
4. The extractor returns image URLs and gallery metadata. QuiviT downloads images to the user's Library under `libraryPath`.

## Branch layout

```
manifest.json          Registry: id, patterns, version, source path
imgur.js               Imgur albums, galleries, direct CDN images
mangadex.js            MangaDex chapters, titles, covers, @home network images
mangaplus.js           MANGA Plus viewer chapters, title series, signed CDN images
kmanga.js              K MANGA episodes, title series, signed CDN images
direct.js              Host-agnostic direct raster images (catch-all, matched last)
shared/
  sanitize.js          Path segment sanitization
  mangaplus.js         MANGA Plus protobuf viewer client (shared by mangadex.js and mangaplus.js)
  kmanga.js            K MANGA viewer client, auth hash, tile order (shared by mangadex.js and kmanga.js)
  proto.js             Minimal protobuf varint/length-delimited decoder
README.md              This contract
```

## Manifest schema

Each entry in `manifest.json` registers one extractor. The file itself is the source of truth for live entries and patterns. The shape:

```json
{
  "version": 1,
  "extractors": [
    {
      "id": "imgur",
      "name": "Imgur",
      "libraryPath": "Imgur",
      "version": 2,
      "source": "imgur.js",
      "patterns": ["^https?://..."]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Lower-case letters, numbers, hyphens. Unique. |
| `name` | Human-readable label shown in status UI. |
| `libraryPath` | Top-level directory name under the user's Library. |
| `version` | Positive integer. Bump on every script change to bust the client module cache. |
| `source` | Relative `.js` filename. Path traversal rejected. |
| `patterns` | Regex strings tested against user URLs. First match wins across all entries. |

## Supported provider layers

Reference URLs for manual testing. Each entry covers a distinct URL route or extraction behavior. Library destination entries illustrate the resulting folder structure rather than literal extractor code returns.

| Provider | Test target | Import type | Library destination (braces not code accurate) | Verified behaviour |
|:---|:---|:---|:---|:---|
| Misc | [BAKEMONOGATARI c013 p002.jpg](https://raw.githubusercontent.com/4163/quivi-t/refs/heads/refactor/backend-cl-prep/test-files/BAKEMONOGATARI%20-%20c013%20(v03)%20-%20p002%20%5BKodansha%20Comics%5D%20%5BDigital%5D%20%5B1r0n%5D%20%7BHQ%7D.jpg) | Direct media | `Misc/{filename}.jpg` | Host-agnostic raster catch-all, matched last, document pages rejected, root sidecar recording |
| Misc | [koi.svg](https://x9000.6te.net/secret/koi.svg) | Direct media | `Misc/{filename}.svg` | Illustrator export with entity prolog, sanitized text path. Art by [stresseR](https://www.pixiv.net/en/artworks/119373929) |
| Imgur | [Azuma - Seihantai](https://imgur.com/a/azuma-seihantai-17vF37d) | Gallery | `Imgur/{Title}/` | Album `/a/` route (41 PNGs), multi-image manga set, description sanitization |
| Imgur | [Anime Reaction Gifs](https://imgur.com/gallery/anime-reaction-gifs-ADdqF) | Gallery | `Imgur/{Title}/` | Large animation batch (50 GIFs), download concurrency, prefetch threshold |
| Imgur | [Just some Witch Watch OP clips](https://imgur.com/gallery/just-some-witch-watch-op-clips-2Bi48Dm#/t/anime) | Gallery | `Imgur/{Title}/` | Video extraction (8 MP4s), audio stream detection, hashtag route (`#/t/anime`) |
| Imgur | [4Q6rSDi.png](https://i.imgur.com/4Q6rSDi.png) | Direct media | `Imgur/{filename}.png` | Direct CDN URL (`i.imgur.com`), gallery match lookup, root sidecar recording |
| MangaDex | [Akebi-chan no Sailor Fuku](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=chapters) | Series | `MangaDex/{Title}/{Language}/{Volume}/{Chapter}/` | Series `/title/{id}` route with `?tab=chapters`, feed pagination, volume hierarchy, 5-tier folder metadata |
| MangaDex | [【Oshi no Ko】](https://mangadex.org/title/296cbc31-af1a-4b5b-a34b-fee2b4cad542/-oshi-no-ko?tab=chapters) | Series | `MangaDex/{Title}/{Language}/{Volume}/{Chapter} (MANGA Plus)/` | Hosted + external feed merge, MANGA Plus stubs with ` (MANGA Plus)` suffix, lazy resolution |
| MangaDex | [Bakemonogatari](https://mangadex.org/title/4265c437-7d57-4d31-9b1d-0e574a07b7b7/bakemonogatari?tab=chapters) | Series | `MangaDex/{Title}/{Language}/{Volume}/{Chapter} (K MANGA)/` | Hosted + external feed merge, K MANGA stubs with ` (K MANGA)` suffix, lazy resolution through kmanga.js |
| MangaDex | [Akebi-chan no Sailor Fuku Ch. 1](https://mangadex.org/chapter/0c4369d6-f0e6-49d7-acb5-99a8d1ea8f8d) | Chapter | `MangaDex/{Title} - {Volume} {Chapter}/` | Chapter `/chapter/{id}` route (33 JPGs), `@home` delivery, ComicInfo sidecar |
| MangaDex | [Akebi-chan no Sailor Fuku](https://mangadex.org/title/770c61b9-0ef2-460b-8c25-c10ab23349ce/akebi-chan-no-sailor-fuku?tab=art) | Art collection | `MangaDex/{Title} (Covers)/` | Art `/title/{id}?tab=art`, multi-locale pagination, root cover, volume filenames |
| MangaDex | [Akebi-chan no Sailor Fuku Vol. 16 Cover](https://mangadex.org/covers/770c61b9-0ef2-460b-8c25-c10ab23349ce/47df7fb5-dc37-492f-98bc-affe54b74960.jpg) | Direct media | `MangaDex/{Title} - {Volume} Cover.jpg` | Direct cover URL `/covers/{id}/{file}`, API title resolution, root `gallery.json` dedup |
| MangaDex | [Reader blob:https:// URL](blob:https://mangadex.org/a357d5db-d810-4566-b0aa-cba411aa9460) | Unsupported |--- | Blob URL detection, descriptive rejection guiding user to chapter link |
| MANGA Plus | [SPY x FAMILY](https://mangaplus.shueisha.co.jp/titles/100056) | Series | `MangaPlus/{Title} ({Language})/{Chapter}/` | Series `titles/{id}` route via `title_detailV3`, language root, cover, lazy chapter stubs |
| MANGA Plus | [SPY x FAMILY Ch. 1](https://mangaplus.shueisha.co.jp/viewer/1001834) | Chapter | `MangaPlus/{Title} - {Chapter} ({Language})/` | Chapter `viewer/{id}` via `manga_viewer_v3`, XOR decrypt, `Plus-Vw-Token` headers |
| MANGA Plus | [SPY x FAMILY Cover](https://jumpg-assets.tokyo-cdn.com/secure/title/100056/title_thumbnail_portrait_list/313744.jpg?hash=ktoQqLjO4TO9hZz8kWFCvQ&expires=2145884400) | Direct media | `MangaPlus/{Title} - Cover ({Language}).jpg` | Signed CDN URL preserved, friendly filename via title detail with hashed fallback |
| MANGA Plus | [SPY x FAMILY Ch. 1 Thumbnail](https://jumpg-assets.tokyo-cdn.com/secure/title/100056/chapter/1001834/chapter_thumbnail/19585.jpg?hash=gVDGhzX3CkbecAwAwCx-HQ&expires=1790074800) | Direct media | `MangaPlus/{Title} - {Chapter} Thumbnail ({Language}).jpg` | Chapter thumbnail CDN URL, chapter number from title detail, friendly filename |
| K MANGA | [Imperfect Girl](https://kmanga.kodansha.com/title/10207/) | Series | `KManga/{Title}/{Chapter}/` | Series `title/{id}` route, Nuxt HTML metadata, free episode detection, lazy stubs |
| K MANGA | [Imperfect Girl Ch. 1](https://kmanga.kodansha.com/title/10207/episode/306448) | Chapter | `KManga/{Title} - {Chapter}/` | Episode `title/{id}/episode/{id}` route, tile-grid descramble, auth hash, thumbnail prepend |
| K MANGA | [Imperfect Girl Cover](https://cdn.kmanga.kodansha.com/static/titles/10207/title_grid_wide_20230411154524221380412b91d393067ceef5bb2a4252.png) | Direct media | `KManga/{Title} Cover.png` | Title-level CDN URL, HTML title resolution, hashed fallback |
| K MANGA | [Imperfect Girl Ch. 1 Thumbnail](https://cdn.kmanga.kodansha.com/static/titles/10207/episodes/306448/thumbnail_2023041414075269dd38c43f51fecfcf08eeb452f74b09.png) | Direct media | `KManga/{Title} - {Chapter} Thumbnail.png` | Episode thumbnail CDN URL, chapter number from HTML metadata |

## Module contract

An extractor is an ES module. Two exports are required, two are optional.

### Exports

| Export | Required | Signature | Purpose |
|---|---|---|---|
| `match` | yes | `(url) => bool` | Returns `true` if this extractor handles the URL. |
| `extract` | yes | `(html, url, context) => result` | Parses a page and returns a gallery or series result. |
| `isDirectUrl` | no | `(url) => bool` | Returns `true` for direct media URLs (CDN images, covers). The app skips the HTML fetch and routes through `parseDirectUrl`. |
| `parseDirectUrl` | no | `(url, context) => { provider, hash, filename, url } \| null` | Resolves a direct media URL. `hash` deduplicates against Library sidecars. Returning `null` falls through to `extract`. Resized variants (such as MangaDex `file.jpg.512.jpg` covers) normalize to the canonical file so they link their gallery copies, while the download still uses the pasted address. |

`context` provides `fetchText(url)`, and when declared, `fetchBytes(url)` (resolves to a `Uint8Array`) and `requestHeaders`.

### Header directives

Extractors declare dependencies and capabilities in their first two lines:

```js
// quivit-deps: shared/sanitize.js, shared/mangaplus.js
// quivit-needs: fetchBytes, requestHeaders, xorDecrypt
```

**Dependencies** (`quivit-deps`): The loader fetches listed files from this branch, follows their sub-dependencies, and rewrites imports at load time. Every relative import must appear in the header. `shared/mangaplus.js` transitively pulls `shared/proto.js` without the entry needing to list it.

**Capabilities** (`quivit-needs`): If the running QuiviT build does not support a named capability, loading fails fast with an update message.

| Capability | What it provides |
|---|---|
| `fetchBytes` | Binary fetch returning bytes (protobuf, binary payloads). |
| `requestHeaders` | Custom headers on fetch and download (session tokens, view tokens). |
| `xorDecrypt` | Per-image `{ algorithm: 'xor', key }` descriptors, decrypted before save. |
| `tileDescramble` | Per-image `{ algorithm: 'tile-grid', cols, rows, order }` descriptors. The backend decodes the image, rearranges tiles per the permutation, and re-encodes before save. |

### Safety rules

- Pure data parsers only. No external packages, no `window` globals, no DOM.
- Path segments and filenames must not contain `/`, `\`, `..`, or Windows reserved device names.
- File extensions must be supported formats: `jpg`, `jpeg`, `png`, `gif`, `webp`, `apng`, `avif`, `svg`, `bmp`, `ico`, `mp4`.
- Duplicate filenames within one gallery are rejected.
- Shared files must not export `match` or `extract`, and are never added to the manifest.

## Return shapes

`extract` returns one of two shapes: a single gallery or a series.

### Single gallery

```js
{
  provider: 'Example',         // must match manifest name
  title: 'Gallery Title',
  gallery: {
    id: 'gallery-123',         // stable site-unique id
    relativePath: ['Category', 'Gallery Title']  // path segments under libraryPath, max depth 8
  },
  images: [
    { url: 'https://cdn.example.com/001.jpg', filename: '001.jpg' }
  ],
  metadata: {                  // optional, written as comicinfo.json
    ComicInfo: { Series: 'Name', Title: 'Gallery Title', Summary: '...' }
  },
  targetFilename: '005.jpg',   // optional: eager-download this image, open viewer on it
  nextPageUrl: null             // next page URL or null; consecutive pages share gallery.id and relativePath
}
```

An image may name prior standalone files it absorbs:

```js
{ url: 'https://cdn.example.com/00.png', filename: '00.png', supersedes: ['https://cdn.example.com/thumb.png'] }
```

When the gallery imports, each absorbed standalone is deleted, file plus its Library records. Use this when the gallery renames a previously imported direct URL, such as a thumbnail arriving as page zero. List addresses or stems; matching tries exact address first, then stems.

`metadata` serialization: an object writes `comicinfo.json`. A string starting with `<` writes `comicinfo.xml`. An object with `{ filename, content }` writes a custom file.

### Series

Series results index multi-chapter manga. Chapters are stubs resolved lazily when opened.

```js
{
  provider: 'Example',
  isSeries: true,
  title: 'Series Title',
  rootRelativePath: ['Series Title'],     // series root under libraryPath
  metadata: { ComicInfo: { ... } },       // optional, written to the root folder
  cover: { url: '...', filename: 'Cover.jpg' },  // optional, downloaded into root
  folders: [                              // optional intermediate folders with metadata
    { relativePath: ['Series Title', 'English'], metadata: { ... } }
  ],
  chapters: [
    {
      id: 'ch-1',                         // stable chapter id
      title: 'Ch. 1 - Intro',
      sourceUrl: 'https://example.com/chapter/1',  // resolved via extract() when opened
      relativePath: ['Series Title', 'English', 'Vol. 01', 'Ch. 01 - Intro'],
      cover: { url: '...', filename: 'Ch. 1 Cover.png' },  // optional, downloaded next to the stub
      metadata: { ComicInfo: { ... } }    // optional, written to the chapter folder
    }
  ]
}
```

Opening an unresolved chapter calls `extract()` on its `sourceUrl` and refreshes its metadata on resolution.

### Cross-provider chapters

A chapter stub can point at another provider's URL. The app resolves it through whichever manifest entry matches that URL. The stub author never reimplements the other site's extractor. MangaDex uses this for MANGA Plus pointers (suffixed ` (MANGA Plus)`) and K MANGA pointers (suffixed ` (K MANGA)`). Stubs pointing at unmatched hosts are skipped.

When a site exposes hosted and external chapters through separate feeds, merge them and dedupe by chapter id. MangaDex needs this because its hosted feed and external-link feed return disjoint sets.

### Clearing and jumping

These rules are the same for every site. The extractor declares facts, the app decides.

Clearing means deleted: the file plus its Library records. A series import removes standalone chapter folders it absorbs. A gallery import removes absorbed standalone files named in `supersedes`. Finished chapters and covers are never touched by a re-import. There is no file relocation.

Jumping picks where an import lands. A gallery copy beats a loose standalone, which beats a series cover. Inside each tier, an exact address match beats a stem match. `targetFilename` names the open target and wins over everything. Otherwise the open-first-image setting governs.

## Folder metadata model

QuiviT reads metadata per folder with no parent inheritance. Extractors supply tailored metadata across each tier. This matrix outlines the baseline convention rather than a rigid schema, allowing extractors to accommodate provider-specific metadata when needed (such as K MANGA attaching publication and translation credits to `Notes`).

| Field | Series root | Language | Volume | Chapter | Standalone / Art |
|:---|:---|:---|:---|:---|:---|
| `Series` | Yes | Yes | Yes | Yes | Yes |
| `Title` | Omitted | `"{Series} ({Lang})"` | `"Volume {X}"` | `"Ch. {Y} - {Title}"` | `"{Series} (Covers)"` |
| `Volume` | Omitted | Omitted | `"{X}"` | `"{X}"` | Omitted |
| `Number` | Omitted | Omitted | Omitted | `"{Y}"` | Omitted |
| `LanguageISO` | Omitted | `"{code}"` | `"{code}"` | `"{code}"` | Omitted |
| `Translator` | Omitted | Omitted | Omitted | `"{Scanlator}"` | Omitted |
| `Notes` | Omitted | Omitted | Omitted | `"Scanlation: ..."` | Omitted |
| `PageCount` | Omitted | Omitted | Omitted | `"{count}"` | Omitted |
| `Web` | Series URL | Series URL | Series URL | Chapter URL | Source URL |
| `Summary` | Synopsis | Synopsis | Synopsis | Synopsis | Collection synopsis |
| `Tags` | Series tags | Series tags | Series tags | Series tags | `"Cover Gallery, Artbook"` |
| `Genre` | Yes | Yes | Yes | Yes | Yes |
| `Demographic` | Yes | Yes | Yes | Yes | Yes |
| `Writer` | Yes | Yes | Yes | Yes | Yes |
| `Penciller` | Yes | Yes | Yes | Yes | Yes |
| `Year` | Yes | Yes | Yes | Yes | Yes |
| `Status` | Yes | Yes | Yes | Yes | Yes |
| `Manga` | Yes | Yes | Yes | Yes | Yes |

## Authoring workflow

Work on this branch through a Git worktree:

```bash
git worktree add ../quivi-t-extractors extractors
```

When changing an extractor:
1. Update or create the `<site>.js` script.
2. Bump the extractor's `version` integer in `manifest.json`. If you touched `shared/`, bump every entry that depends on it.
3. Commit both files together in a single commit on this branch.
4. Push the branch to `origin extractors`.
