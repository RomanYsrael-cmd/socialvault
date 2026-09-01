# SocialVault

> **Development status:** Milestone 2 is complete. SocialVault can inspect a Facebook Download Your Information ZIP, locally parse a supported subset of profile, post, and Messenger JSON, normalize it, persist it in browser storage, and show basic read-only archive views.

**Browse your social media history without giving your social media history to someone else.**

SocialVault is a local-first social archive browser that transforms your downloaded Facebook data archive into a familiar, searchable social media experience.

Instead of digging through thousands of JSON files, folders, photos, and Messenger exports, SocialVault reconstructs your archive into an interface designed to feel like browsing a social network again.

Your archive is processed on your device. SocialVault does not require your Facebook password, Facebook login, or your archive to be uploaded to a server.

> **Your archive stays on your device.**

Support for additional social media platforms is planned.

---

## Features

SocialVault aims to reconstruct as much of your downloaded social media history as possible from the data available in your archive.

### Milestone 2 capabilities

- Polished ZIP picker with drag and drop, validation, file details, and clear action
- Browser Web Worker inspection using zip.js (the application does not call `file.arrayBuffer()`)
- Extensible archive detector with Facebook structure/category recognition
- Guardrails for malformed ZIPs, traversal paths, entry counts, and very large entries
- Incremental, tolerant Facebook adapter for common profile, posts, and Messenger paths
- Source-file references retained on normalized profile, post, conversation, and message records
- Section-level import progress and non-fatal malformed/unsupported JSON warnings
- SQLite WebAssembly storage in a dedicated worker with schema migrations and indexed queries
- Persistent OPFS database where supported; durable IndexedDB snapshot plus an in-memory SQLite query layer as fallback
- Read-only Profile, Posts, Conversations, and individual Conversation views
- Archive overview with local import controls, summary, storage mode, and warnings
- Framework-neutral normalized model types; UI pages never read raw Facebook JSON
- Synthetic-only Vitest and Playwright coverage

### Not implemented yet

Photos and media extraction, comments/reactions, friend browsing, archive search/FTS5, complete Facebook format coverage, pagination/virtualization, and a polished timeline or Messenger reconstruction are not implemented. The current text views are intentionally basic.

### Supported path assumptions

The adapter currently recognizes profile files containing `profile_information` or `profile_v2`; post files below a `posts` directory or named `your_posts*.json`; and Messenger thread files matching `messages/inbox/*/message_*.json` or `messages/archived_threads/*/message_*.json`. Facebook changes its export format over time, so unrecognized files are skipped and malformed candidate JSON is reported as a warning.

### Browser storage

On browsers with compatible worker OPFS support, SQLite stores `socialvault.sqlite3` in the browser's Origin Private File System. When OPFS cannot be initialized, SocialVault uses an in-memory SQLite database for queries and mirrors normalized records to IndexedDB so they remain available across sessions. Both stores are origin-private and device-local; clearing site data removes them.

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
6. Browse the basic normalized Profile, Posts, and Messages views.

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

The SocialVault server serves the application itself.

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

The current persistence layer stores normalized profile, post, conversation, and message records in SQLite WASM. A versioned migration table provides the foundation for later schema evolution. Full-text search is not connected yet.

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

SQLite FTS5 provides local full-text search for content such as messages, posts, comments, and people.

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
