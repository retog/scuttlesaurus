# Architecture

Scuttlesaurus is one program that is, at the same time,

- a **Nostr relay** that proactively replicates the events of its owner's social
  neighbourhood, the way a Scuttlebutt peer replicates the feeds within a few
  hops,
- a **Nostr client** for short notes (kind 1) and long-form articles (kind
  30023), served as a web application, and
- a **Blossom server** for the media those notes and articles use.

All three share one store: a monotonically growing RDF graph.

```
                       ┌──────────────────────────── one port ───────────────────────────┐
other Nostr clients ──▶│  WebSocket /        NIP-01 relay  ─┐                              │
browser (web client) ─▶│  GET /…             web client     │                              │
                       │  /sparql            SPARQL 1.1     ├─▶ EventStore ─▶ TripleStore  │
                       │  /api/…             node API       │      ▲           (RDF graph, │
                       │  /<sha256>, /upload Blossom       ─┘      │            insert-only)│
                       └───────────────────────────────────────────┼──────────────────────┘
                                                                    │
     relays of the people in range ◀── outgoing WebSockets ── Replicator ◀── SocialGraph
```

## Decisions

| Decision            | Choice                                                                                             | Why                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Runtime             | Deno 2, dependencies from JSR and npm, no build step for the server                                | One tool to install                                                         |
| Nostr primitives    | `@nostr/tools` (JSR)                                                                               | Signatures, NIP-19, filters and relay connections in one audited library    |
| Storage             | One RDF graph, insert-only; see [DATA-MODEL.md](DATA-MODEL.md)                                     | Queryable with SPARQL, trivially persisted and replicated                   |
| Default store       | Oxigraph (WebAssembly) inside the process, in a worker, persisted as an append-only N-Triples log  | Installation needs no database                                              |
| Larger stores       | Any SPARQL 1.1 endpoint through `SPARQL_ENDPOINT_QUERY` / `SPARQL_ENDPOINT_UPDATE`                 | The embedded store keeps the graph in memory                                |
| QLever store        | QLever through qlever-dir (`QLEVER_DIR_URL`): the node writes N-Triples files                      | No update endpoint to run; the graph is a directory of plain files          |
| What is replicated  | Authors within `hops` follow hops of the owner, capped at `maxAuthors` by proximity                | Scuttlebutt's social-distance replication                                   |
| Where it is fetched | Each author's NIP-65 write relays (outbox model), chosen to cover all authors with few connections | Nostr's replacement for Scuttlebutt pubs                                    |
| Who may write       | Authors within range; everybody may read                                                           | The social graph is the spam filter                                         |
| Client reads        | SPARQL over `/sparql`                                                                              | Joins (profile + note + counts) in one request                              |
| Client writes       | Signed events over WebSocket to the node's own relay                                               | The node is a normal relay; nothing client-specific                         |
| Signing             | NIP-07 extension, a NIP-46 signer app (Amber and others), or a key held in the browser             | The server never sees a private key; with a signer app the browser has none |
| Web client          | Preact + TypeScript, bundled with `deno bundle`, no external requests                              | No third-party CDN, works offline on a LAN                                  |

## Source layout

```
main.ts                 entry point: wires the modules together
src/types.ts            the interfaces between modules
src/vocab.ts            RDF vocabulary and IRI helpers (shared with the web client)
src/config.ts           configuration
src/store/              TripleStore implementations, event ⇄ triples, filter → SPARQL, EventStore
src/social/             SocialGraph
src/replication/        Replicator: relay selection, backfill, live subscriptions, publishing
src/relay/              RelayServer: NIP-01 over WebSocket, NIP-11
src/blossom/            BlossomServer
src/http/               routing, /sparql, /api, NIP-98, static files
web/src/                the web client (Preact)
web/static/             index.html, styles, icons (copied to web/dist by the build)
scripts/                build.ts, dev.ts, seed.ts
vocab/nostr.ttl         the vocabulary as RDF
docs/                   this documentation
```

Modules depend on the interfaces in [`src/types.ts`](../src/types.ts), never on
each other's implementations. Each module directory exports its factory from
`mod.ts`; tests live next to the code as `*.test.ts`.

## Storage (`src/store/`)

`TripleStore` is the insert-only graph. Three implementations:

- **Embedded** (default). Oxigraph's WebAssembly build runs in a dedicated
  worker so that a slow query never blocks the relay. Every inserted batch is
  appended to `<dataDir>/graph.nt` before the insert resolves; on start the log
  is read back in chunks. A truncated last line (crash during a write) is
  dropped.
- **SPARQL endpoint**. `insert` sends `INSERT DATA`; queries use the SPARQL 1.1
  Protocol. Nothing else is ever sent to the update URL.
- **QLever through qlever-dir** (`QLEVER_DIR_URL`). `insert` writes the batch as
  a new file, `<QLEVER_DIR_GRAPH_DIR>/YYYY/MM/DD/<unix ms>-<sequence>.nt`, and
  resolves once qlever-dir's endpoint shows the file's named graph, which is
  `QLEVER_DIR_BASE_URI` followed by the file's path. Queries go to qlever-dir's
  read-only endpoint. At start and every six hours, the day directories older
  than yesterday (UTC) are merged into one file per day, `YYYY/MM/DD.nt`; a
  day's directory is removed only after the merged graph is visible. At start,
  once the endpoint answers, the store waits until the files that may not be
  indexed yet are visible: files under the graph directory whose inode change
  time is later than `confirmedAt`, a time at which all files were last known to
  be visible, minus two minutes. `confirmedAt` is kept in
  `<dataDir>/qlever-dir-state.json` and advanced as inserts become visible and
  on close; when it is unknown, every file is checked. An insert whose file is
  not visible within two minutes fails, and the file stays in the directory.
  Nothing is ever sent to an update URL. See
  [INSTALL.md](INSTALL.md#use-qlever-through-qlever-dir).

`EventStore` implements Nostr semantics on top:

- `add` validates (structure, id, signature unless `verified`, `created_at` not
  more than 15 minutes in the future), ignores duplicates, refuses retracted
  events, writes the event's triples and the `supersededBy` / `deletedBy`
  bookkeeping, then notifies subscribers.
- Adds are committed in groups, on every backend. Adds issued in the same turn
  form one group, of at most 500 events and an estimated 4 MiB of N-Triples;
  adds that arrive while a group is being stored wait for the next one. A group
  reads its bookkeeping in a few queries and inserts its triples in one
  `insert`, with the same results as adding the events one by one. Each `add`
  resolves once its group is stored and its subscribers are told.
- `query` translates NIP-01 filters to SPARQL and reconstructs events from their
  triples. Superseded and retracted events are never returned. Filters that are
  not selective (no `ids`, `authors` or tag condition) are evaluated over a
  widening window of `nostr:date` values instead of sorting everything. The
  NIP-50 `search` field is supported as a case-insensitive substring match.
- `has` answers from an in-memory set of event ids, loaded at start.

Rough capacity of the embedded store: about 0.5 GB of memory per million
triples, and an event is around ten triples. With the default limits a node
stays well below a million triples. Beyond a few million, use an endpoint or the
QLever store, which keeps the graph out of the node's memory. The QLever store
has been run only on graphs of up to about ten thousand triples.

## Social graph (`src/social/`)

Distances are computed breadth-first from the owner over _current_ follow lists
(kind 3 events without `nostr:supersededBy`):

1. The owner is at distance 0.
2. For each hop up to `replication.hops`: the candidates are everybody followed
   by an author of the previous hop who has no distance yet and is not on the
   owner's public mute list (kind 10000).
3. If the candidates would exceed `replication.maxAuthors`, those followed by
   the most authors of the previous hop are kept.

The graph recomputes, debounced by two seconds, whenever a follow list of an
author closer than `hops`, or the owner's mute list, is stored, and when the
configuration changes. Without an owner the graph is empty.

## Replication (`src/replication/`)

The replicator keeps the store supplied with the events of everybody in the
social graph. It is a loop of planning and executing that restarts, debounced,
when the graph changes.

**Planning.** For each author the candidate relays are the write relays of their
current relay list (NIP-65), or the bootstrap relays if they have none. Relays
are chosen greedily so that every author is covered by up to two relays with at
most `maxRelays` connections; among equally useful relays the one that has
delivered more of the authors' events before (`nostr:seenOn`, the heir of
Scuttlesaurus' peer ranking table) is preferred. Bootstrap relays are always
asked for everybody's profile, follow list and relay list, because that is how
the graph is discovered in the first place.

**What is fetched** depends on the distance:

| Distance      | Kinds                                                   | History                    |
| ------------- | ------------------------------------------------------- | -------------------------- |
| 0 (owner)     | everything                                              | everything                 |
| 1             | 0, 3, 10000, 10002, 10063, 30023 · 1, 5, 6, 7, 16, 1111 | `horizonDays[1]` (90 days) |
| 2 and further | 0, 3, 10002, 10063, 30023 · 1, 5, 6, 16, 1111           | `horizonDays[n]` (14 days) |

Replaceable and addressable kinds (before the `·`) are fetched without a time
limit, since there is only one current version of each.

**Executing.** Per relay, authors are asked for in batches. An author who has
not been fetched from before is backfilled by paging backwards with `until`
until the horizon is reached; afterwards a live subscription stays open. The
time up to which each author is covered is kept in `<dataDir>/sync-state.json`,
so a restart only fetches what was missed. Connections reconnect with backoff; a
relay that keeps failing is dropped from the plan for a while. Events already in
the store are skipped before their signature is verified. Relay lists are data
from strangers: relays they name must be public `wss://` hosts unless
`replication.allowPrivateRelays` is on (bootstrap relays are always allowed).

**Publishing.** Events that clients publish to this node's relay are forwarded
to the author's write relays, or to the bootstrap relays when the author has no
relay list (`replication.forward`: `all`, `owner` or `none`).

## Relay (`src/relay/`)

A NIP-01 relay on the WebSocket endpoint `/`.

- `EVENT`: accepted when the author is in the social graph, otherwise answered
  with `["OK", id, false, "blocked: …"]`. Ephemeral events are relayed to
  matching subscriptions without being stored. One exception to the rule on
  authors: a kind 24133 event (NIP-46 Nostr Connect) is accepted from any author
  when it has at least one `p` tag with a valid pubkey and is at most 64 KiB. A
  signer app's key and a client's connection key are outside the graph, so
  without the exception remote signing could not use this relay. The event is
  ephemeral, so it is relayed and never stored, and it is accepted even before
  the node has an owner (so the first-run setup can use a signer app). Any other
  event, and a 24133 event that does not meet the condition and whose author is
  outside the graph, is refused as before. `NOSTR_CONNECT=off` removes the
  exception and the NIP-11 entry.
- `REQ`: stored events, `EOSE`, then live events matching the filters.
- `CLOSE`, and `COUNT` (NIP-45).
- Limits: number of subscriptions and filters per connection, `limit` capped at
  `maxLimit`, message size. Exceeding one is answered with `CLOSED` or `NOTICE`.
- NIP-11: `GET /` with `Accept: application/nostr+json`.

Supported NIPs: 01, 02, 09, 10, 11, 18, 22, 23, 25, 45, 46 (unless
`NOSTR_CONNECT` is off), 50, 65.

## Blossom (`src/blossom/`)

| Endpoint               | BUD | Behaviour                                                        |
| ---------------------- | --- | ---------------------------------------------------------------- |
| `GET /<sha256>[.ext]`  | 01  | The blob, with range requests and immutable caching              |
| `HEAD /<sha256>[.ext]` | 01  | Existence, size and type                                         |
| `PUT /upload`          | 02  | Store a blob; uploader must be in the social graph               |
| `HEAD /upload`         | 06  | Whether an upload would be accepted                              |
| `GET /list/<pubkey>`   | 02  | Blob descriptors uploaded by a pubkey                            |
| `DELETE /<sha256>`     | 02  | Remove the caller's ownership; the file goes when nobody owns it |

Uploads and deletions are authorized with a kind 24242 event in the
`Authorization: Nostr <base64>` header. Blobs are files in `<dataDir>/blobs/`;
their descriptions are triples (see [DATA-MODEL.md](DATA-MODEL.md)).

## HTTP surface (`src/http/`)

One port, evaluated in this order:

| Request                                       | Handler                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `GET /` with `Upgrade: websocket`             | Relay                                                  |
| `GET /` with `Accept: application/nostr+json` | NIP-11 document                                        |
| `GET`, `POST /sparql`                         | SPARQL 1.1 Protocol, queries only                      |
| `/api/…`                                      | Node API, below                                        |
| `GET /.well-known/nostr.json`                 | NIP-05 for the owner (`_`)                             |
| Blossom paths                                 | Blossom                                                |
| any other `GET`                               | Web client: a file from `web/dist/`, else `index.html` |

Every response carries `Access-Control-Allow-Origin: *`; `OPTIONS` requests are
answered for CORS preflight.

### Node API

| Endpoint          | Auth          | Purpose                                                                                                                                                 |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/status` | none          | `{ name, description, version, owner, setupRequired, relayUrl, publicUrl, hops, publicSparql, blossom, stats, authorsByHop, replication, connections }` |
| `GET /api/graph`  | none          | `{ owner, hops, distances: { <pubkey>: <hops> } }`                                                                                                      |
| `POST /api/setup` | none, once    | `{ owner: <npub or hex> }`; only while the node has no owner                                                                                            |
| `GET /api/config` | owner, NIP-98 | The changeable settings and which are locked by environment variables                                                                                   |
| `PUT /api/config` | owner, NIP-98 | A `ConfigPatch`                                                                                                                                         |

`owner` is the hex public key, or `null`. NIP-98 authorization is a kind 27235
event in the `Authorization: Nostr <base64>` header, signed by the owner.

### SPARQL endpoint

`GET /sparql?query=…`, `POST` with `application/sparql-query`, or `POST` with
`application/x-www-form-urlencoded` and a `query` field. SELECT and ASK return
`application/sparql-results+json`; CONSTRUCT and DESCRIBE return
`application/n-triples`. Updates are refused: the graph is written only through
events. When `publicSparql` is false the endpoint requires the owner's NIP-98
authorization.

## Configuration (`src/config.ts`)

Defaults, overlaid by `<dataDir>/config.json` (written by the setup screen and
the settings page), overlaid by environment variables. A setting given through
the environment is locked: the settings page shows it but cannot change it.

| Environment variable          | Setting                                         | Default                                                                                     |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `OWNER`                       | `owner` (npub or hex)                           | none: the web client asks on first run                                                      |
| `PORT`                        | `port`                                          | `7777`                                                                                      |
| `HOSTNAME`                    | `hostname`                                      | `127.0.0.1`                                                                                 |
| `DATA_DIR`                    | `dataDir`                                       | `./data`                                                                                    |
| `PUBLIC_URL`                  | `publicUrl`                                     | derived from each request                                                                   |
| `RELAY_NAME`                  | `name`                                          | `Scuttlesaurus`                                                                             |
| `RELAY_DESCRIPTION`           | `description`                                   | a short default                                                                             |
| `HOPS`                        | `replication.hops`                              | `2`                                                                                         |
| `MAX_AUTHORS`                 | `replication.maxAuthors`                        | `1500`                                                                                      |
| `HORIZON_DAYS`                | `replication.horizonDays`                       | `0,90,14`                                                                                   |
| `BOOTSTRAP_RELAYS`            | `replication.bootstrapRelays` (comma separated) | `wss://relay.damus.io/`, `wss://nos.lol/`, `wss://relay.primal.net/`, `wss://purplepag.es/` |
| `MAX_RELAYS`                  | `replication.maxRelays`                         | `12`                                                                                        |
| `FORWARD`                     | `replication.forward`                           | `all`                                                                                       |
| `REPLICATION`                 | `replication.enabled` (`off` disables)          | on                                                                                          |
| `ALLOW_PRIVATE_RELAYS`        | `replication.allowPrivateRelays`                | off                                                                                         |
| `SPARQL_ENDPOINT_QUERY`       | `store.queryUrl`; selects the endpoint store    | embedded store                                                                              |
| `SPARQL_ENDPOINT_UPDATE`      | `store.updateUrl`                               | the query URL                                                                               |
| `SPARQL_ENDPOINT_CREDENTIALS` | `store.credentials`                             | none                                                                                        |
| `QLEVER_DIR_URL`              | `store.qleverUrl`; selects the QLever store     | embedded store                                                                              |
| `QLEVER_DIR_GRAPH_DIR`        | `store.qleverGraphDir`                          | `<DATA_DIR>/graph`                                                                          |
| `QLEVER_DIR_BASE_URI`         | `store.qleverBaseUri`                           | `https://example.org/data/`                                                                 |
| `SPARQL_PUBLIC`               | `publicSparql`                                  | `true`                                                                                      |
| `NOSTR_CONNECT`               | `nostrConnect` (`off` disables)                 | on                                                                                          |
| `BLOSSOM`                     | `blossom.enabled` (`off` disables)              | on                                                                                          |
| `BLOSSOM_MAX_SIZE_MB`         | `blossom.maxBlobSize`                           | `50`                                                                                        |
| `MAX_LIMIT`                   | `maxLimit`                                      | `500`                                                                                       |

Files in `dataDir`: `graph.nt` (the graph of the embedded store), `blobs/`,
`config.json`, `sync-state.json`, `qlever-dir-state.json`. The QLever store
keeps the graph under `QLEVER_DIR_GRAPH_DIR` instead, as `YYYY/MM/DD/*.nt` batch
files and merged `YYYY/MM/DD.nt` files, and does not write `graph.nt`.

## Web client (`web/`)

A single-page application. It reads with SPARQL, writes by publishing signed
events to the node's relay, and listens on the same relay for new events.

| Route                      | View                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `/`                        | Home: notes, scoped to "Following" or the whole replicated network |
| `/n/<note or nevent>`      | A note with its thread                                             |
| `/reads`                   | Articles                                                           |
| `/a/<naddr>`               | An article, with comments                                          |
| `/write`, `/write/<naddr>` | Article editor                                                     |
| `/p/<npub>`                | Profile: notes, articles, following                                |
| `/notifications`           | Replies, mentions and reactions                                    |
| `/search`                  | People, notes and articles                                         |
| `/network`                 | The node: social graph, relays, replication, SPARQL console        |
| `/settings`                | Owner settings                                                     |

Identity is one of: a NIP-07 browser extension, a signer app over NIP-46, a
private key kept in the browser's local storage, or a public key only
(read-only). On a node without an owner the first screen is the setup: choose or
create an identity, which becomes the owner.

**Signer app (NIP-46, `lib/remote_signer.ts`).** The user's key stays in a
signer app such as Amber. The browser has a connection key of its own and
exchanges NIP-44-encrypted kind 24133 events with the signer over a relay.

- _Client-initiated._ The sign-in dialog shows a `nostrconnect://` link (on
  Android tapping it opens the signer app) and the same link as a QR code (a
  signer on another device). The link asks for `sign_event` for the kinds the
  client signs, so that a signer can remember approvals per kind. The relay in
  the link is this node's own (`relayUrl` of `/api/status`), because a phone
  that opened the page by that address can reach it. On `localhost` or a
  loopback address it cannot, so the person must enter a relay, with
  `wss://relay.nsec.app/` offered as a suggestion; nothing connects to it unless
  they choose it.
- _Signer-initiated._ The person pastes a `bunker://` address or a
  `name@domain`; the browser connects directly to the relays named in it.
- The signer's pubkey is not necessarily the user's, so the client asks
  `get_public_key`. In `localStorage`, next to the session, it keeps the
  connection key, the signer's pubkey, the relays and the user's pubkey, and
  nothing of the user's secret. After a reload the session is restored at once
  and the connection is rebuilt in the background (a `ping`) and on the first
  signature. Signing out sends `logout`, closes the connection and discards the
  connection key.
- Every signature may need a tap on the phone, so `signEvent` itself shows a
  "waiting for approval" indicator (any caller gets it), a request waits up to
  60 seconds (5 minutes after an `auth_url`, which is shown as a link) and the
  errors say whether the signer refused, did not answer, or the relay could not
  be reached.
- `scripts/fake_signer.ts` stands in for a signer app in development; see
  [DEVELOPMENT.md](DEVELOPMENT.md#testing-remote-signing).
