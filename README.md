# SocialVault

> **Development status:** Milestone 8 is complete. SocialVault can import a large Facebook export set incrementally, checkpoint each ZIP part, resume after cancellation or reload, and browse the normalized archive locally.

**Browse your social media history without giving your social media history to someone else.**

SocialVault is a local-first social archive browser that transforms your downloaded Facebook data archive into a familiar, searchable social media experience.

Instead of digging through thousands of JSON files, folders, photos, and Messenger exports, SocialVault reconstructs your archive into an interface designed to feel like browsing a social network again.

Your archive is processed on your device. SocialVault does not require your Facebook password, Facebook login, or your archive to be uploaded to a server.

> **Your archive stays on your device.**

Support for additional social media platforms is planned.

---

## Features

SocialVault aims to reconstruct as much of your downloaded social media history as possible from the data available in your archive.

### Milestone 8 capabilities

- Polished ZIP picker with drag and drop, validation, file details, and clear action
- Multi-file selection and multi-drop for Facebook exports split across many ZIPs; all selected parts are treated as one logical archive
- Lightweight part list with total count/size, per-part entry counts, duplicate-part warnings, and a bounded summary for large selections
- Aggregate Facebook detection across partial exports (profile, posts, messages, photos, friends, albums, comments, reactions, and activity may live in different parts)
- Deterministic order-independent archive-set fingerprint plus per-part manifest fingerprints for safe reconnects, including renamed matching ZIPs
- Sequential ZIP inspection/import so large part sets do not create dozens of concurrent decompression streams
- Browser Web Worker inspection using zip.js (the application does not call `file.arrayBuffer()`)
- Extensible archive detector with Facebook structure/category recognition
- Guardrails for malformed ZIPs, traversal paths, entry counts, and very large entries
- Incremental, tolerant Facebook adapter for common profile, posts, and Messenger paths
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
- Version 7 archive-set/import-session migration with archive/part metadata, resumable checkpoints, source-part columns, and automatic v5 single-ZIP backfill as part 1
- Framework-neutral normalized model types; UI pages never read raw Facebook JSON
- Synthetic-only Vitest and Playwright coverage

### Resumable import and compatibility hardening

- Persisted import state machine (`new`, `importing`, `indexing`, `complete`, `cancelled`, `interrupted`, and `failed`) with a session ID, parser/schema versions, counts, warnings, and timestamps
- Schema migration 7 for import sessions, per-part checkpoints, section status, rebuild jobs, and aggregated diagnostic warning groups; v6 archives are upgraded as completed legacy sessions
- Transactional part checkpoints: a ZIP part becomes complete only after its normalized records and derived activity rows commit successfully
- Cancel/resume workflow that retains completed parts and safely leaves the current part pending; reloads show an explicit incomplete-import state instead of claiming completion
- Fingerprint-based source reconnection for all or only a subset of remaining ZIP parts; renamed files can reconnect, mismatches never auto-bind, and completed parts are not reparsed
- Explicit retry and skip actions for failed or unavailable parts, with incomplete coverage retained until the set is complete
- Optional **Select archive folder** / **Reconnect archive folder** using the File System Access API where available, with a bounded `webkitdirectory` fallback and recursive ZIP discovery that ignores non-ZIP files
- No arbitrary ZIP-part count limit; safety bounds apply to entry counts, decompressed entry size, path traversal, recursion depth, and discovered file counts
- Facebook parser version 8 with profile, posts, Messenger, comments, reactions, connections, albums, attachment, timestamp, chunk-order, Unicode, and media-path compatibility fixtures
- Detected-but-unsupported section reporting (for example Saved items, Search history, Groups, Events, Ads, Security, and Payments) plus section-level imported/partial/malformed status
- Privacy-safe JSON diagnostics export with sanitized file extensions, structural shape signatures, warning categories, counts, checkpoints, coverage, and local performance timings—never archive text, names, raw JSON, or media bytes
- Explicit transactional FTS5 and activity-index rebuild actions from normalized local tables; BM25 relevance ranking, deterministic cursors, entity filters, year/date filters, and a SQL `LIKE` fallback
- Bounded worker handoff: one normalized ZIP-part result is acknowledged by the database worker before parsing proceeds; SQLite writes use bounded multi-row batches

### Not implemented yet

Complete Facebook format coverage, automatic media extraction, bulk thumbnail generation, FTS5 search across every future section, comments/reaction editing, archive merging, incremental newer-export synchronization, and multi-archive management are not implemented. The current views remain intentionally lightweight and read-only.

### Supported path assumptions

The adapter currently recognizes profile files containing `profile_information`, `profile_v2`, `personal_information`, account/profile directories, or a profile JSON basename; post files below a `posts` directory or named `your_posts.json`, `your_posts__1.json`, or `your_posts_1.json`; comments/reactions files containing `comments`, `reactions`, `likes`, or nested interaction arrays; connection files containing `friends`, `followers`, `following`, `friend_requests`, or `connections`; album files containing `albums`; and Messenger thread files under `messages/inbox`, `messages/archived_threads`, `messages/filtered_messages`, `messages/message_requests`, or marketplace-like message directories with `message_*.json`, `message-*.json`, or chunked names. It accepts common casing and field variants for names, IDs, timestamps, content, participants, relationship status, About facts, album media, and attachment references. Facebook changes its export format over time, so unrecognized files and unsupported shapes are skipped with aggregated structural diagnostics, malformed candidate JSON is reported as a warning, and coverage is shown in the archive overview.

### Browser storage

On browsers with compatible worker OPFS support, SQLite stores `socialvault.sqlite3` in the browser's Origin Private File System. When OPFS cannot be initialized, SocialVault uses an in-memory SQLite database for queries and mirrors the normalized snapshot plus import-session state to IndexedDB so they remain available across sessions. Migration 5 adds the activity ledger, migration 6 adds the logical archive/part catalog, and migration 7 adds sessions, checkpoints, section status, rebuild jobs, and warning groups; an existing v6 archive is upgraded as a completed legacy session without a destructive re-import. Both stores are origin-private and device-local; clearing site data removes them.

The imported text, people, search index, statistics, media metadata, archive-set fingerprint, and per-part checkpoints remain usable after a reload even when none of the original ZIPs are selected. An incomplete import is clearly labeled and keeps safely committed records available. Reconnect all available parts—or only a subset—in one file or folder action; matching uses the deterministic manifest fingerprint, with filename/size/entry count retained as diagnostics. A renamed but otherwise matching ZIP is accepted when its manifest identity matches; a mismatch never auto-binds or re-imports. File handles are runtime-only and are not serialized into SQLite or IndexedDB. A folder handle may require permission again after reload, so **Reconnect archive folder** is always available as a user-initiated action.

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

1. Download your information from Facebook in JSON format.
2. Open SocialVault.
3. Select or drag one or all ZIP parts into the application. If Facebook gave you 40 ZIP files, select all 40 together; or choose **Select archive folder** to discover ZIPs recursively in a user-selected directory where the browser permits it.
4. SocialVault validates and inspects each part locally, one at a time, before showing the archive set for review.
5. Choose **Start local import** to parse supported JSON in a worker. Each completed part is committed and checkpointed before the next part is parsed.
6. If the import is cancelled or interrupted, reload the app, choose **Reconnect archive files** or **Reconnect archive folder**, and select **Resume import**. Only remaining parts are parsed.
7. Browse the normalized Profile/About, People/Friends, Posts, Albums, Messages, Search, and Photos views; rebuild derived indexes or export privacy-safe diagnostics from Archive Overview when needed.

```text
Facebook ZIP part(s)
     ↓
Local archive-set parser (bounded, sequential)
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

The current persistence layer stores normalized profile, people, posts, comments, reactions, connections, albums, conversations, messages, profile facts, and media metadata records in SQLite WASM. Migration 2 adds media, import metadata, search documents, and the optional FTS5 virtual table; migration 3 adds people/source mappings, archive identity, media-cache metadata, participant IDs, and sender IDs; migration 4 adds social graph tables and profile facts; migration 5 adds the activity ledger; migration 6 adds archive sets, archive parts, and source-part references; migration 7 adds import sessions, per-part checkpoints, section status, rebuild jobs, and warning groups while preserving earlier schemas. Query APIs expose explicit cursor pages so React never loads full record sets.

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

Large media files remain associated with their original archive instead of unnecessarily being copied into the database. Part writes and derived-index writes use bounded multi-row batches (40 rows per statement), and the import worker waits for an acknowledgement from SQLite before parsing the next part. This keeps the in-flight normalized queue bounded while preserving a transaction boundary per ZIP part.

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

The project should eventually be capable of handling archives containing millions of Messenger messages and tens of thousands of media files.

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

## Recommended Milestone 9

Add richer social-history reconstruction on top of the reliable archive set: interaction summaries on Person pages, relationship timelines, memories/activity UX, broader section adapters, and incremental performance tuning for very large normalized datasets. Keep all archive processing, search, diagnostics, and storage local. Multi-archive workspaces and export merging should remain out of scope until this single logical archive experience is mature.

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
