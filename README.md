# SocialVault

> **Development status:** Milestone 11.1 is complete. SocialVault can inspect and import large Facebook JSON or HTML export sets with browser-scale source I/O, bounded memory handoffs, checkpointed normalized data and derived indexes, reconnectable local media sources, and opt-in local throughput diagnostics.

**Browse your social media history without giving your social media history to someone else.**

SocialVault is a local-first social archive browser that transforms your downloaded Facebook data archive into a familiar, searchable social media experience.

Instead of digging through thousands of JSON files, folders, photos, and Messenger exports, SocialVault reconstructs your archive into an interface designed to feel like browsing a social network again.

Your archive is processed on your device. SocialVault does not require your Facebook password, Facebook login, or your archive to be uploaded to a server.

> **Your archive stays on your device.**

Support for additional social media platforms is planned.

---

## Features

SocialVault aims to reconstruct as much of your downloaded social media history as possible from the data available in your archive.

### Milestone 10 capabilities

- Polished ZIP picker with drag and drop, validation, file details, and clear action
- Multi-file selection and multi-drop for Facebook exports split across many ZIPs; all selected parts are treated as one logical archive
- Lightweight part list with total count/size, per-part entry counts, duplicate-part warnings, and a bounded summary for large selections
- Aggregate Facebook detection across partial exports (profile, posts, messages, photos, friends, albums, comments, reactions, and activity may live in different parts)
- Deterministic order-independent archive-set fingerprint plus per-part manifest fingerprints for safe reconnects, including renamed matching ZIPs
- Sequential ZIP inspection/import so large part sets do not create dozens of concurrent decompression streams
- Browser Web Worker inspection using zip.js (the application does not call `file.arrayBuffer()`)
- Extensible archive detector with Facebook structure/category recognition
- Guardrails for malformed ZIPs, traversal paths, entry counts, and very large entries
- Incremental, tolerant Facebook adapters for common JSON and HTML profile, posts, Messenger, connections, and album paths
- Streaming HTML tokenizer with bounded record batches; large HTML pages are never materialized as one DOM or string
- Normalized comments and reactions with actor, kind, timestamp, post target, and source-file references
- Normalized friends, removed friends, followers/following, requests, and blocked connections with filtering
- Normalized albums and album-to-media membership with a simple album viewer
- Profile About facts for work, education, places lived, relationship, usernames, languages, and other exported fields
- Source-file references retained on normalized profile, post, conversation, and message records
- Every normalized source carries an archive-part identity; media metadata is routed to the part containing its ZIP path, including cross-part post/media references
- Rich person normalization with stable source-scoped identities, owner/participant distinction, identity confidence, first/last interaction dates, and source paths
- Paginated People repository with SQL-derived message, post, media, and conversation participation counts
- Read-only archive person pages with related posts, interaction counts, and safe exact-profile/search links to Facebook when evidence exists
- Section-level import progress and non-fatal malformed/unsupported JSON warnings
- Facebook HTML-only exports are identified during inspection and parsed locally through the same normalized model as JSON; unsupported HTML pages become warnings rather than fatal errors
- SQLite WebAssembly storage in a dedicated worker with schema migrations and indexed queries
- Persistent OPFS database where supported; durable IndexedDB snapshot plus an in-memory SQLite query layer as fallback
- Read-only Profile/About, Posts/comments, Friends, Albums, Conversations, and individual Conversation views
- SQLite FTS5 global search for posts, messages, conversation titles, participant names, and profile names, with a LIKE fallback when FTS5 is unavailable
- Debounced grouped search results with links into posts, conversations, profiles, and matching message threads
- Cursor-based pagination for posts, conversations, messages, media metadata, and search results
- Newest/oldest post ordering and year filtering
- Efficient conversation previews with latest message, timestamp, participant summary, group indicator, and message count
- Archive statistics calculated through SQLite aggregates
- Metadata-only media indexing for supported post attachments and Messenger photos/files/videos; original bytes are decompressed only when a preview is requested
- Media path/MIME allowlists, bounded object-URL cache, missing-reference warnings, responsive Photos grid, filters, and accessible image/video viewer
- Timeline and Messenger attachment previews with lazy retrieval and reconnect messaging when the ZIP is unavailable
- Runtime archive-part → File registry for lazy media extraction; original ZIP bytes are never copied into SQLite/OPFS
- Batch reconnect for all or a subset of parts, with missing/unexpected/duplicate diagnostics and text/search remaining available while media parts are absent
- Virtualized long post/message lists using dynamic row measurement
- FTS5 snippets with local highlighting and a safe SQL `LIKE` fallback
- Deterministic local archive signatures for safe ZIP reconnection without re-importing matching text data
- Import diagnostics for candidate, malformed, unsupported, missing-media, and incomplete-identity files
- Archive overview with local import controls, summary, storage mode, and warnings
- Archive Home feed with local archive context, Memories preview, post authors, and deep links to individual posts
- Individual post pages with multi-media layouts, lazy previews, reaction breakdowns, progressive comment threads, and source metadata
- Profile experience with cover/avatar placeholders, About facts, friend/photo/album previews, and archive-owner post links
- On This Day Memories with UTC-safe date navigation, date picker, year grouping, and SQLite calendar indexes
- Paginated Activity history with local search, type/year filters, source references, and links to related records
- Shared PersonDisplay identity rendering with initials fallback and internal person links
- Responsive mobile navigation and layouts designed to avoid horizontal overflow on narrow screens
- Migrations 8–9 record archive/part format metadata, source/derived status, resumable checkpoints, and automatic v5 single-ZIP backfill as part 1
- Framework-neutral normalized model types; UI pages never read raw Facebook JSON
- Synthetic-only Vitest and Playwright coverage

### Milestone 11 browser-scale hardening

- Compact runtime source registry: React state keeps names, sizes, and source keys while `File` objects and folder handles stay outside the UI store
- File System Access folder discovery enumerates ZIP handles without eagerly calling `getFile()`; ZIP bytes are materialized only for the part currently being inspected or imported
- One-part-at-a-time worker orchestration; each import worker receives one `File`, acknowledges bounded batches, and is terminated before the next part is opened
- JSON and HTML normalized handoffs are bounded by both record count and an estimated byte budget; maximum batch observations are retained in local import metrics
- Source manifests are retained as compact path sets for cross-part media ownership and safe reconnects; ZIP reader/entry objects do not cross the worker boundary
- Large imports release ordinary `File` references after checkpointing; browser handles remain reconnectable, while detached files report an explicit reconnect requirement for media
- Media extraction remains demand-driven: the media worker opens only the requested connected ZIP and never registers or scans the whole archive set
- Browser storage selection is capability-driven: OPFS is used when it initializes and remains writable; IndexedDB snapshots are activated only after an unavailable/failed OPFS path, with the reason included in diagnostics
- Storage diagnostics include the active backend, fallback reason when applicable, and the current normalized SQLite page size (source ZIP bytes are not used as a database-size proxy)
- Archive Overview shows the active storage path and source-part status while preserving local-only text browsing when media parts are detached
- Chromium selection profiling covers 1, 5, 10, and 40 ZIP selections without growing the DOM or JavaScript heap with the selected source bytes

### Milestone 11.1 browser import throughput diagnostics

- Parser, worker handoff, SQLite transaction, commit, derived-index, snapshot, and finalization timings are recorded as bounded structural counters; no record values or archive paths are retained in diagnostics.
- Import Details shows the current parser/database stage, normalized-row and byte counters, batch latency, rolling throughput, and a non-blocking possible-stall warning when no measured stage advances for 60 seconds. Healthy work is never cancelled by the warning.
- JSON and HTML handoffs are limited to 5,000 normalized records or approximately 8 MiB per acknowledged batch. Completed HTML source paths are checkpointed so cancellation, reload, or reconnect can resume without replaying already committed files.
- Facebook media-only ZIP parts are accepted as metadata-only companions when every file is a media asset under a strict Facebook export root; unrelated media collections and suspicious ZIP paths remain rejected.
- SQLite uses the direct OPFS driver only as a compatibility fallback; compatible workers prefer SQLite's OPFS SAH pool VFS to avoid a proxy round trip for every page operation. If OPFS cannot initialize or remain writable, a chunked IndexedDB snapshot hydrates an in-memory SQLite query layer.
- `scripts/profile-real.mjs` runs a sanitized real-archive browser profile for `heavy`, `5`, `10`, or `full` selections. `scripts/profile-node.mjs` measures the equivalent ZIP/parse stage in Node, `scripts/profile-database.mjs` measures synthetic 10k/100k/625k SQLite writes with memory, direct OPFS, or SAH-pool backends, and `scripts/profile-clone.mjs` probes structured-clone latency for 1/2/4/8 MiB worker payloads across practical row counts. Set `SOCIALVAULT_ARCHIVE` and optionally `SOCIALVAULT_BASE_URL`; scripts print counts and timings only.
- The profile run samples rendered DOM size, page heap (when Chromium exposes it), console/page errors, storage mode/VFS, normalized rows, database size, batch latency, and sanitized final diagnostics. It does not impose a ten-minute success cutoff.

### Resumable import and compatibility hardening

- Persisted import state machine (`new`, `importing`, `indexing`, `complete`, `cancelled`, `interrupted`, and `failed`) with a session ID, parser/schema versions, counts, warnings, and timestamps
- Schema migration 7 for import sessions, per-part checkpoints, section status, rebuild jobs, and aggregated diagnostic warning groups; v6 archives are upgraded as completed legacy sessions
- Transactional part checkpoints: a ZIP part becomes complete only after its normalized source records commit successfully; derived search/activity rows are built and checkpointed in a separate resumable stage
- Cancel/resume workflow that retains completed parts and safely leaves the current part pending; reloads show an explicit incomplete-import state instead of claiming completion
- Fingerprint-based source reconnection for all or only a subset of remaining ZIP parts; renamed files can reconnect, mismatches never auto-bind, and completed parts are not reparsed
- Explicit retry and skip actions for failed or unavailable parts, with incomplete coverage retained until the set is complete
- Optional **Select archive folder** / **Reconnect archive folder** using the File System Access API where available, with a bounded `webkitdirectory` fallback and recursive ZIP discovery that ignores non-ZIP files
- No arbitrary ZIP-part count limit; safety bounds apply to entry counts, decompressed entry size, path traversal, recursion depth, and discovered file counts
- Facebook parser version 9 with JSON/HTML profile, posts, Messenger, comments, reactions, connections, albums, attachment, timestamp, chunk-order, Unicode, and media-path compatibility fixtures
- Detected-but-unsupported section reporting (for example Saved items, Search history, Groups, Events, Ads, Security, and Payments) plus section-level imported/partial/malformed status
- Privacy-safe JSON diagnostics export with sanitized file extensions, structural shape signatures, warning categories, counts, checkpoints, coverage, and local performance timings—never archive text, names, raw JSON, or media bytes
- Explicit checkpointed FTS5 and activity-index jobs from normalized local tables; BM25 relevance ranking, deterministic cursors, entity filters, year/date filters, and a SQL `LIKE` fallback
- Bounded worker handoff: normalized HTML batches are acknowledged by the database worker before parsing proceeds; SQLite writes use bounded multi-row batches and ZIP-part checkpoints complete only after the final batch
- Five-thousand-record producer/consumer batches keep HTML parsing and SQLite writes bounded; the parser waits for each database acknowledgement before continuing
- Base-source completion is tracked separately from derived search/activity readiness, so imported records remain browseable while a long index build is paused
- Checkpointed search and activity jobs record phase, row cursor, batch size, elapsed rows, errors, and completion timestamps in SQLite; resuming continues from the last committed batch
- Derived indexing uses set-based `INSERT … SELECT` statements, bounded rowid windows, and yielding worker turns instead of materializing the archive in JavaScript
- Import and derived-stage progress includes stage timings, stage counts, batch counts, and (on the fallback path) the persisted SQLite snapshot size
- IndexedDB fallback stores a chunked SQLite WASM snapshot rather than duplicating all normalized messages/media as JavaScript objects; bounded chunks keep quota writes recoverable, and legacy object snapshots are still accepted for migration
- An opt-in synthetic scale probe exercises the observed archive magnitudes (6k+ people, 12k+ posts, 6k+ conversations, 625k+ messages, and 60k+ media) without adding a large fixture to the routine test run; set `RUN_SOCIALVAULT_SCALE=1` when measuring it locally

### Not implemented yet

Complete Facebook format coverage beyond the documented HTML structures, automatic media extraction, bulk thumbnail generation, FTS5 search across every future section, comments/reaction editing, archive merging, incremental newer-export synchronization, and multi-archive management are not implemented. The current views remain intentionally lightweight and read-only.

### Supported path assumptions

The adapter recognizes profile files containing `profile_information`, `profile_v2`, `personal_information`, account/profile directories, or a profile JSON basename; post files below a `posts` directory or named `your_posts*.json`/`your_posts*.html`; comments/reactions files containing `comments`, `reactions`, `likes`, or nested interaction arrays; connection files containing `friends`, `followers`, `following`, `friend_requests`, or `connections`; album files containing `albums`, `album`, `your_photos`, or `your_videos`; and Messenger thread files under `messages/inbox`, `messages/archived_threads`, `messages/filtered_threads`, `messages/filtered_messages`, `messages/message_requests`, or marketplace-like message directories with `message_*.json`, `message-*.json`, or matching HTML files. JSON parsing retains the existing tolerant field-variant behavior. HTML parsing targets Facebook's exported `_a6-g` cards (`_a6-i` headings, `_a6-p` content, `_a72d` dates), profile tables, local media links, and explicit interaction attributes when present. It resolves only safe archive-relative media references and never renders raw HTML. Facebook changes its export format over time, so unrecognized files and unsupported shapes are skipped with aggregated structural diagnostics, malformed candidate JSON/HTML is reported as a warning, and coverage is shown in the archive overview.

### Browser storage

On browsers with compatible worker OPFS support, SQLite stores `socialvault.sqlite3` in the browser's Origin Private File System. SocialVault does not switch away from OPFS merely because the source ZIP set is large: it prefers SQLite's OPFS SAH pool VFS when it initializes and remains writable, with the direct OPFS driver retained for compatibility. When OPFS cannot be initialized—or a recoverable OPFS write/quota failure occurs—SocialVault uses an in-memory SQLite database for queries and stores a chunked SQLite WASM snapshot plus import-session state in IndexedDB so normalized rows and resumable checkpoints remain available across sessions. The selected backend, VFS, and fallback reason are included in the Archive Overview and privacy-safe diagnostics. Snapshot chunks are written under a private generation and published only after all chunks commit; a quota failure leaves the previous readable snapshot intact. Migration 5 adds the activity ledger, migration 6 adds the logical archive/part catalog, migration 7 adds sessions/checkpoints/section status/rebuild jobs/warning groups, migration 8 records JSON/HTML format on archive sets and parts, migration 9 records source/derived status plus checkpointed derived-index jobs, and migration 10 records completed source-file checkpoints for resumable HTML parsing; older databases are upgraded without a destructive re-import. Both stores are origin-private and device-local; clearing site data removes them.

The imported text, people, statistics, media metadata, archive-set fingerprint, and per-part checkpoints remain usable after a reload even when none of the original ZIPs are selected. Search and activity become available as their derived jobs finish; if either job is interrupted, the base source import remains clearly labeled and can resume from its last checkpoint. Reconnect all available parts—or only a subset—in one file or folder action; matching uses the deterministic manifest fingerprint, with filename/size/entry count retained as diagnostics. A renamed but otherwise matching ZIP is accepted when its manifest identity matches; a mismatch never auto-binds or re-imports. File handles are runtime-only and are not serialized into SQLite or IndexedDB. A folder handle may require permission again after reload, so **Reconnect archive folder** is always available as a user-initiated action.

### Planned Facebook archive support

Planned and supported functionality includes:

- Home / timeline
- Personal profile
- Posts
- Comments and reactions
- Photos and albums
- Videos
- Friends and connections
- Messenger conversations
- Message search
- Global archive search
- Memories / On This Day
- Activity history
- Archive statistics
- People and interaction history
- Links back to real Facebook profiles when profile information is available

The exact information available depends on what Facebook includes in your downloaded archive.

---

## How It Works

SocialVault does **not** ask you to sign in to Facebook.

Instead:

1. Download your information from Facebook in JSON or HTML format.
2. Open SocialVault.
3. Select or drag one or all ZIP parts into the application. If Facebook gave you 40 ZIP files, select all 40 together; or choose **Select archive folder** to discover ZIPs recursively in a user-selected directory where the browser permits it.
   For very large multipart exports, the folder picker is recommended because it keeps file handles lazy until each part is processed.
4. SocialVault validates and inspects each part locally, one at a time, before showing the archive set for review. Folder selection keeps directory handles until a part is needed; it does not read every ZIP into memory up front.
5. Choose **Start local import** to parse supported JSON or HTML in a worker. HTML pages and JSON chunks are tokenized/normalized incrementally, bounded records are acknowledged in byte- and count-limited batches, and each completed part is committed and checkpointed before the next part is parsed.
6. If the import is cancelled or interrupted, reload the app, choose **Reconnect archive files** or **Reconnect archive folder**, and select **Resume import**. Only remaining parts are parsed.
7. Browse the normalized Profile/About, People/Friends, Posts, Albums, Messages, Search, and Photos views; rebuild derived indexes or export privacy-safe diagnostics from Archive Overview when needed.

```text
Facebook ZIP part(s)
     ↓
Local archive-set parser (bounded, sequential JSON/HTML adapters)
     ↓
Normalization
     ↓
Local SQLite database
     ↓
SocialVault interface
```

The application shell may be served by a web server, but archive contents are not sent to it.

Your Facebook archive, Messenger conversations, photos, posts, and generated archive database are not intended to be uploaded to the SocialVault server.

---

## Privacy First

Facebook data exports can contain extremely sensitive personal information.

They may include:

- Private Messenger conversations
- Photos and videos
- Friend information
- Search history
- Location information
- Account activity
- Comments and reactions
- Personal profile information

Because of this, SocialVault is designed around a **local-first architecture**.

Archive processing should occur inside the user's browser or device.

### SocialVault should never require

- Your Facebook password
- Your Facebook login credentials
- Facebook OAuth
- A Facebook access token
- Uploading your archive to SocialVault

External Facebook links may require an internet connection, but browsing the processed archive itself is designed to work locally.

---

## Facebook Profile Links

People referenced inside an archive may have an internal SocialVault profile containing information found in that archive.

When sufficient information is available, SocialVault may provide a:

**View on Facebook**

action.

Profile resolution should follow this order:

1. Exact Facebook profile URL
2. Facebook user ID
3. Facebook username
4. Facebook search by name

SocialVault must not guess that an unrelated Facebook profile belongs to someone when an exact identity cannot be determined.

---

## Local Archive Database

The current persistence layer stores normalized profile, people, posts, comments, reactions, connections, albums, conversations, messages, profile facts, and media metadata records in SQLite WASM. Migration 2 adds media, import metadata, search documents, and the optional FTS5 virtual table; migration 3 adds people/source mappings, archive identity, media-cache metadata, participant IDs, and sender IDs; migration 4 adds social graph tables and profile facts; migration 5 adds the activity ledger; migration 6 adds archive sets, archive parts, and source-part references; migration 7 adds import sessions, per-part checkpoints, section status, rebuild jobs, and warning groups; migration 8 records each logical set/part's source format; migration 9 separates source/derived status, adds checkpointed derived-index jobs and large-archive query indexes; migration 10 adds completed source-file checkpoints for resumable HTML parsing while preserving earlier schemas. Query APIs expose explicit cursor pages so React never loads full record sets.

During import, supported data is normalized and indexed into a local SQLite database.

Examples of indexed information include:

- People
- Posts
- Comments
- Reactions
- Conversations
- Messages
- Attachments
- Albums
- Media metadata
- Activities

SQLite FTS5 provides local full-text search for posts, messages, conversation titles, participants, and profiles. When a browser build cannot create FTS5, the same database worker falls back to a bounded SQL `LIKE` search over mirrored documents.

Large media files remain associated with their original archive instead of unnecessarily being copied into the database. HTML is tokenized with parse5 from zip.js byte streams. The tokenizer pauses at 5,000 normalized records; the import worker coalesces JSON/HTML records into a bounded handoff of up to 5,000 records or approximately 8 MiB of estimated normalized text before waiting for SQLite, and SQLite writes use 2,000-row statement batches. Checkpoints are committed per ZIP part, while batch acknowledgements keep the in-flight normalized queue bounded. Search and activity indexes use the same 5,000-row checkpoint window and persist their row cursor for safe resume.

---

## Tech Stack

### Application

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- React Router
- Zustand
- Lucide

### Archive Engine

- zip.js
- Web Workers
- Zod
- DOMPurify

### Local Data

- SQLite WebAssembly
- SQLite FTS5
- Origin Private File System (OPFS)

### Offline

- Progressive Web App
- Service Worker
- Workbox

### Testing

- Vitest
- React Testing Library
- Playwright

### Future Desktop Application

- Tauri 2
- Native SQLite
- Native filesystem access

---

## Architecture

```text
┌─────────────────────────────────────────────┐
│                 SocialVault                 │
│                                             │
│  React UI                                   │
│      │                                      │
│      ▼                                      │
│  Archive / Database Workers                 │
│      │                                      │
│      ├──── zip.js ───── Facebook ZIP        │
│      │                                      │
│      ▼                                      │
│  Normalized Archive Model                   │
│      │                                      │
│      ▼                                      │
│  SQLite WASM + FTS5                         │
│      │                                      │
│      ▼                                      │
│  OPFS / Local Device Storage                │
└─────────────────────────────────────────────┘

             Archive data stays local
```

The React interface should never perform expensive archive parsing directly on the main browser thread.

Archive processing, indexing, and database operations should be delegated to Web Workers.

---

## Supported Platforms

The initial release is intended to support modern desktop browsers.

Priority:

- Chromium-based browsers
- Microsoft Edge
- Google Chrome
- Brave

Firefox and Safari compatibility should be maintained where the required filesystem and WebAssembly capabilities are available.

A Tauri desktop application may be introduced later for users with extremely large archives or users who want unrestricted native filesystem access.

---

## Large Archives

SocialVault is designed with large archives in mind.

Facebook may provide a download as dozens or hundreds of ZIP files. Select all of those files—or a containing folder—in one operation; SocialVault records one logical archive with many parts, inspects/imports them sequentially, and never concatenates or copies the source ZIPs into browser storage. Part metadata is kept compact and the UI summarizes long lists without rendering every entry. There is no arbitrary archive-part ceiling; practical ZIP/resource safety limits still apply.

The application architecture should avoid loading an entire ZIP archive into memory.

Instead, it should:

- Read ZIP entries as needed
- Process each ZIP part incrementally and checkpoint it after a successful transaction
- Keep one normalized part result in flight while SQLite acknowledges the previous write
- Batch SQLite inserts instead of issuing one persistence request per message
- Use Web Workers
- Use indexed database queries
- Virtualize large lists
- Lazy-load photos and videos
- Generate optional thumbnails
- Paginate expensive queries

If the browser is reopened later, normalized text and search remain available without the source files. Reconnect all available ZIPs—or only a subset—to resume the next incomplete checkpoint and restore lazy media previews. Media tied to a missing part remains visible as metadata and reports `Archive part not connected` rather than disabling the archive. A failed part can be retried, or explicitly skipped with the archive remaining visibly incomplete.

The project should eventually be capable of handling archives containing millions of Messenger messages and tens of thousands of media files. Browser memory and storage quotas still vary by browser and device; for the largest exports, a Chromium profile run is recommended before leaving a long import unattended.

---

## Archive Compatibility

Facebook's Download Your Information format can change over time.

SocialVault therefore uses an archive adapter and normalization layer rather than directly coupling UI components to Meta's current JSON schema.

```text
Meta Export
    ↓
Archive Detector
    ↓
Facebook Adapter
    ↓
Normalized SocialVault Model
    ↓
Database
    ↓
UI
```

Older and newer archive structures can therefore be supported through additional adapters without redesigning the interface.

---

## Future Platform Support

SocialVault is being designed as a general social archive browser.

Future adapters may support exports from:

- Instagram
- Threads
- X / Twitter
- TikTok
- Reddit
- Other platforms that provide downloadable user archives

Each platform remains responsible for determining what information is included in its exports.

SocialVault can only reconstruct information available in the archive supplied by the user.

## Recommended Milestone 12

Extend the single-archive experience with broader relationship reconstruction: richer interaction aggregation on person pages, more Facebook HTML variants, and scalable graph-oriented browsing. Keep archive processing, search, diagnostics, and storage local. Multi-archive workspaces and export merging should remain out of scope until this single logical archive experience is mature.

---

## Development

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/socialvault.git
cd socialvault
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Run end-to-end tests:

```bash
npm run test:e2e
```

Build for production:

```bash
npm run build
```

---

## Test Data

Do **not** commit real Facebook archives to this repository.

Development and automated testing should use synthetic archive fixtures containing fictional people, messages, posts, and media.

Real archives may contain passwords, contact information, private conversations, location history, photos, and other highly sensitive information.

---

## Security

Imported archive content must always be treated as untrusted input.

SocialVault should protect against:

- Cross-site scripting
- Malicious HTML
- ZIP path traversal
- ZIP bombs
- Malformed JSON
- Excessive decompression
- Invalid MIME types
- Dangerous URLs
- Executable archive contents
- Resource exhaustion

Files contained inside an archive must never be executed.

---

## Contributing

Contributions are welcome.

When contributing:

- Never include real personal Facebook data.
- Use synthetic fixtures for testing.
- Maintain the local-first privacy model.
- Avoid introducing unnecessary server-side processing of archive contents.
- Preserve compatibility with existing archive adapters where practical.
- Add tests for archive parsing and schema changes.

Bug reports for unsupported Facebook archive structures are particularly valuable, but examples should be sanitized before being shared publicly.

---

## Disclaimer

SocialVault is an independent open-source project.

It is **not affiliated with, endorsed by, sponsored by, or associated with Meta Platforms, Inc., Facebook, Instagram, Threads, or their respective owners**.

Facebook, Instagram, Meta, Messenger, Threads, and related names and trademarks belong to their respective owners.

SocialVault does not provide access to Facebook accounts and does not bypass Facebook authentication. It only processes archive data voluntarily supplied by the user.

---

## License

SocialVault is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

See [`LICENSE`](LICENSE) for details.
