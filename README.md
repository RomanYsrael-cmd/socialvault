# SocialVault

> **Development status:** Milestone 4 is complete. SocialVault can inspect a Facebook Download Your Information ZIP, normalize people, profile, post, Messenger, and media metadata locally, persist it in browser storage, and browse/search the imported records with SQL-backed pagination and on-demand media previews.

**Browse your social media history without giving your social media history to someone else.**

SocialVault is a local-first social archive browser that transforms your downloaded Facebook data archive into a familiar, searchable social media experience.

Instead of digging through thousands of JSON files, folders, photos, and Messenger exports, SocialVault reconstructs your archive into an interface designed to feel like browsing a social network again.

Your archive is processed on your device. SocialVault does not require your Facebook password, Facebook login, or your archive to be uploaded to a server.

> **Your archive stays on your device.**

Support for additional social media platforms is planned.

---

## Features

SocialVault aims to reconstruct as much of your downloaded social media history as possible from the data available in your archive.

### Milestone 4 capabilities

- Polished ZIP picker with drag and drop, validation, file details, and clear action
- Browser Web Worker inspection using zip.js (the application does not call `file.arrayBuffer()`)
- Extensible archive detector with Facebook structure/category recognition
- Guardrails for malformed ZIPs, traversal paths, entry counts, and very large entries
- Incremental, tolerant Facebook adapter for common profile, posts, and Messenger paths
- Source-file references retained on normalized profile, post, conversation, and message records
- Rich person normalization with stable source-scoped identities, owner/participant distinction, identity confidence, first/last interaction dates, and source paths
- Paginated People repository with SQL-derived message, post, media, and conversation participation counts
- Read-only archive person pages with related posts and safe exact-profile/search links to Facebook when evidence exists
- Section-level import progress and non-fatal malformed/unsupported JSON warnings
- SQLite WebAssembly storage in a dedicated worker with schema migrations and indexed queries
- Persistent OPFS database where supported; durable IndexedDB snapshot plus an in-memory SQLite query layer as fallback
- Read-only Profile, Posts, Conversations, and individual Conversation views
- SQLite FTS5 global search for posts, messages, conversation titles, participant names, and profile names, with a LIKE fallback when FTS5 is unavailable
- Debounced grouped search results with links into posts, conversations, profiles, and matching message threads
- Cursor-based pagination for posts, conversations, messages, media metadata, and search results
- Newest/oldest post ordering and year filtering
- Efficient conversation previews with latest message, timestamp, participant summary, group indicator, and message count
- Archive statistics calculated through SQLite aggregates
- Metadata-only media indexing for supported post attachments and Messenger photos/files/videos; original bytes are decompressed only when a preview is requested
- Media path/MIME allowlists, bounded object-URL cache, missing-reference warnings, responsive Photos grid, filters, and accessible image/video viewer
- Timeline and Messenger attachment previews with lazy retrieval and reconnect messaging when the ZIP is unavailable
- Virtualized long post/message lists using dynamic row measurement
- FTS5 snippets with local highlighting and a safe SQL `LIKE` fallback
- Deterministic local archive signatures for safe ZIP reconnection without re-importing matching text data
- Import diagnostics for candidate, malformed, unsupported, missing-media, and incomplete-identity files
- Archive overview with local import controls, summary, storage mode, and warnings
- Framework-neutral normalized model types; UI pages never read raw Facebook JSON
- Synthetic-only Vitest and Playwright coverage

### Not implemented yet

Comments/reactions, friend relationship detail, albums, bulk thumbnail generation, pagination-aware search ranking, complete Facebook format coverage, and extraction of unsupported media types are not implemented. The current views remain intentionally lightweight and read-only.

### Supported path assumptions

The adapter currently recognizes profile files containing `profile_information`, `profile_v2`, or a profile JSON basename; post files below a `posts` directory or named `your_posts*.json`; and Messenger thread files under `messages/inbox`, `messages/archived_threads`, or `messages/filtered_messages` with `message_*.json`/`message-*.json` names. It accepts common casing and field variants for names, IDs, timestamps, content, participants, and attachment references. Facebook changes its export format over time, so unrecognized files are skipped, malformed candidate JSON is reported as a warning, and diagnostics are shown in the archive overview.

### Browser storage

On browsers with compatible worker OPFS support, SQLite stores `socialvault.sqlite3` in the browser's Origin Private File System. When OPFS cannot be initialized, SocialVault uses an in-memory SQLite database for queries and mirrors normalized records to IndexedDB so they remain available across sessions. Both stores are origin-private and device-local; clearing site data removes them.

The imported text, people, search index, statistics, media metadata, and archive signature remain usable after a reload even when the original ZIP is not selected. Media previews then show a reconnect prompt. Selecting a ZIP only re-binds media when its filename, size, entry count, and deterministic local manifest fingerprint match the stored signature; a mismatch never auto-binds or re-imports.

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
3. Select or drag your Facebook ZIP archive into the application.
4. SocialVault validates and processes the archive locally.
5. Choose **Start local import** to parse supported JSON in a worker.
6. Browse the normalized Profile, People, Posts, Messages, Search, and Photos views.

```text
Facebook ZIP
     ↓
Local archive parser
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

The current persistence layer stores normalized profile, people, post, conversation, message, and media metadata records in SQLite WASM. Migration 2 adds media, import metadata, search documents, and the optional FTS5 virtual table; migration 3 adds people/source mappings, archive identity, media-cache metadata, participant IDs, and sender IDs while preserving earlier schemas. Query APIs expose explicit cursor pages so React never loads full record sets.

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

Large media files remain associated with their original archive instead of unnecessarily being copied into the database.

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

The application architecture should avoid loading an entire ZIP archive into memory.

Instead, it should:

- Read ZIP entries as needed
- Process data incrementally
- Use Web Workers
- Use indexed database queries
- Virtualize large lists
- Lazy-load photos and videos
- Generate optional thumbnails
- Paginate expensive queries

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

## Recommended Milestone 5

Add scalable archive management: multi-archive workspaces, richer relationship and interaction records, comments/reactions, media thumbnail generation with cancellation, ranked search pagination, and an import diagnostics export. Keep all archive processing and storage local.

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
