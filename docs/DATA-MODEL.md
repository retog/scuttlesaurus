# Data model

Scuttlesaurus keeps everything it knows in one RDF graph. This document defines
the IRIs, the vocabulary, the mapping from Nostr events to triples, and the
rules that make the graph **monotonic**.

The term names are defined in code in [`src/vocab.ts`](../src/vocab.ts); a
machine-readable description is in [`vocab/nostr.ttl`](../vocab/nostr.ttl).

## The graph only grows

No triple is ever removed or changed. The storage interface (`TripleStore` in
[`src/types.ts`](../src/types.ts)) has a single write operation, `insert`.

Nostr, however, has events that replace or retract earlier ones. These are
expressed by _adding_ knowledge:

| Nostr concept                                     | What is added to the graph                               |
| ------------------------------------------------- | -------------------------------------------------------- |
| A newer replaceable or addressable event (NIP-01) | `<older> nostr:supersededBy <newer>`                     |
| A deletion request, kind 5 (NIP-09)               | `<target> nostr:deletedBy <deletion>`                    |
| A blob is deleted by its uploader (BUD-02)        | `<receipt> nostr:removedAt <time>` on the upload receipt |

Consequences:

- The **current** version of anything replaceable is the event without a
  `nostr:supersededBy` triple. Queries express this as
  `MINUS { ?e nostr:supersededBy ?newer }` (see [Query idioms](#query-idioms)
  for why `MINUS` and not `FILTER NOT EXISTS`).
- A retracted event stays in the graph, marked with `nostr:deletedBy`. The relay
  never serves it and the client never shows it, but it is not physically
  erased. Only blob _files_ are physically removed.
- Persistence is an append-only log of N-Triples in the embedded store, and a
  directory of N-Triples files in the QLever store, where a merge replaces a
  day's files with one file holding the same triples. See
  [ARCHITECTURE.md](ARCHITECTURE.md#storage-srcstore).

## IRIs

| Thing               | IRI                           | Notes                                                          |
| ------------------- | ----------------------------- | -------------------------------------------------------------- |
| Public key          | `nostr:npub1…`                | NIP-21 URI of the NIP-19 `npub`                                |
| Event               | `nostr:note1…`                | NIP-21 URI of the NIP-19 `note` (the event id)                 |
| Address             | `nostr:naddr1…`               | `naddr` of kind, pubkey and `d` value, **without** relay hints |
| Relay               | `wss://relay.example.com/`    | Normalized: lower-case scheme and host, a path always present  |
| Blob                | `urn:sha256:<hex>`            |                                                                |
| Blob upload receipt | `urn:uuid:<uuid>`             |                                                                |
| Vocabulary term     | `nostr:ontology:<term>`       | Prefix `nostr:`                                                |
| Tag index term      | `nostr:ontology:tag:<letter>` | Prefix `tag:`                                                  |

```sparql
PREFIX nostr: <nostr:ontology:>
PREFIX tag:   <nostr:ontology:tag:>
PREFIX xsd:   <http://www.w3.org/2001/XMLSchema#>
```

Note that the prefixed name `nostr:kind` is the IRI `nostr:ontology:kind`, while
entity IRIs such as `<nostr:npub1…>` are always written in full.

An event and the addressable thing it is a version of are different resources:
each version of an article is a `nostr:note1…` event, linked by `nostr:address`
to the one `nostr:naddr1…` that identifies the article.

## Mapping an event to triples

`E` is the event's IRI. Integers are `xsd:integer`, dates `xsd:date`, everything
else is a plain string unless marked IRI.

### Every event

| Predicate         | Object                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `nostr:author`    | Pubkey IRI                                                                                  |
| `nostr:kind`      | Integer                                                                                     |
| `nostr:createdAt` | Integer, unix seconds                                                                       |
| `nostr:date`      | UTC day of `created_at`, e.g. `"2026-11-13"^^xsd:date`                                      |
| `nostr:content`   | The content. Omitted when empty.                                                            |
| `nostr:tags`      | The `tags` array as compact JSON, verbatim. Omitted when the array is empty.                |
| `nostr:sig`       | Hex signature                                                                               |
| `nostr:seenOn`    | Relay IRI the event was received from, see below. Absent for events published to this node. |

`nostr:seenOn` is written for the relay an event is first received from, and
again, as the only new triple, when a stored event is received from another
relay (its signature is not verified again, but its id is recomputed from its
fields and must match). An event has at most four `seenOn` relays; later ones
are not recorded. It is the provenance that relay planning counts: for an
author, the number of their events seen on each relay (`relayScores`), so a
relay that delivers an author's notes later than a faster one still gets its
credit.

The id is in the event IRI and the pubkey in the author IRI, so these triples
are sufficient to reconstruct the signed event exactly. The relay serves events
by reconstructing them; nothing is stored twice. The one exception is a follow
or mute list that is already superseded when it arrives: it is stored as a stub
without `nostr:content` and `nostr:tags`, cannot be reconstructed and is never
served (see [Stale follow and mute lists](#stale-follow-and-mute-lists)).

`nostr:date` exists because triple stores index by term, not by numeric range. A
query for "the newest 50 notes" restricts `nostr:date` to a window of recent
days instead of sorting every note ever stored.

### Tag index

For every tag whose name is a single ASCII letter and that has a value, as
NIP-01 defines for filters:

| Predicate      | Object               |
| -------------- | -------------------- |
| `tag:<letter>` | `tag[1]` as a string |

`#e`, `#p`, `#t`, `#d`, … filters are answered from these. Upper and lower case
letters are distinct (`tag:e` and `tag:E`).

Exception: in kinds 3 and 10000, a `p` tag whose value is a valid pubkey (64
lowercase hex characters) has no `tag:p` triple. Its value is in the graph once,
as the `nostr:follows` or `nostr:mutes` link (see [Links](#links)); a follow
list of a few hundred entries would otherwise hold each of them twice. A `p` tag
with any other value keeps its `tag:p` triple, and has no link. So in these two
kinds a value is in the graph either as `tag:p "v"` or as `follows` / `mutes`
`<npub(v)>`, never both.

A `#p` filter is therefore answered from `tag:p` and, for those of its values
that are pubkeys, from `nostr:follows` if the filter has no `kinds` or they
include 3, and from `nostr:mutes` if it has no `kinds` or they include 10000,
joined by `UNION`. The values of one `#p` are alternatives; several tag letters
must all match. A filter for other kinds only, such as `{"kinds":[1]}`, reads
`tag:p` alone. Stores written before this rule hold both triples for these tags;
nothing is removed, and such an event is found once.

### Links

Tag values that are not valid (64 hex characters, a parseable coordinate, an
absolute IRI) produce no link triple; the tag index triple is still written.

| Source                                         | Predicate                 | Object                             |
| ---------------------------------------------- | ------------------------- | ---------------------------------- |
| every `e` tag                                  | `nostr:references`        | Event IRI                          |
| every `q` tag (event id)                       | `nostr:quotes`            | Event IRI                          |
| every `a` tag                                  | `nostr:referencesAddress` | Address IRI                        |
| every `p` tag, except in kinds 3 and 10000     | `nostr:mentions`          | Pubkey IRI                         |
| kind 3: every `p` tag (NIP-02), no `tag:p`     | `nostr:follows`           | Pubkey IRI                         |
| kind 10000: every `p` tag (NIP-51), no `tag:p` | `nostr:mutes`             | Pubkey IRI                         |
| kind 7: the last `e` tag (NIP-25)              | `nostr:reactsTo`          | Event IRI                          |
| kinds 6 and 16: the last `e` tag (NIP-18)      | `nostr:reposts`           | Event IRI                          |
| kind 5: every `e` tag (NIP-09)                 | `nostr:deletes`           | Event IRI                          |
| kind 5: every `a` tag (NIP-09)                 | `nostr:deletesAddress`    | Address IRI                        |
| kinds 30000–39999                              | `nostr:address`           | Address IRI of (kind, pubkey, `d`) |

Threading:

| Source                                                                                                             | Predicate              | Object      |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------- |
| kind 1, NIP-10 root (marked `root`, or first `e` tag if unmarked)                                                  | `nostr:root`           | Event IRI   |
| kind 1, NIP-10 parent (marked `reply`; else the root if it is the only marked tag; else the last unmarked `e` tag) | `nostr:replyTo`        | Event IRI   |
| kind 1111 (NIP-22), `E` tag                                                                                        | `nostr:root`           | Event IRI   |
| kind 1111, `e` tag                                                                                                 | `nostr:replyTo`        | Event IRI   |
| kind 1111, `A` tag                                                                                                 | `nostr:rootAddress`    | Address IRI |
| kind 1111, `a` tag                                                                                                 | `nostr:replyToAddress` | Address IRI |

A kind 1 event with `nostr:replyTo` is a reply; one without is a top-level note.
`e` tags marked `mention` never produce `nostr:root` or `nostr:replyTo`.

### Kind-specific properties

| Kind                         | Source                             | Predicate             | Object    |
| ---------------------------- | ---------------------------------- | --------------------- | --------- |
| 0 (profile; content is JSON) | `name`                             | `nostr:name`          | String    |
|                              | `display_name`                     | `nostr:displayName`   | String    |
|                              | `about`                            | `nostr:about`         | String    |
|                              | `picture`                          | `nostr:picture`       | IRI       |
|                              | `banner`                           | `nostr:banner`        | IRI       |
|                              | `website`                          | `nostr:website`       | String    |
|                              | `nip05`                            | `nostr:nip05`         | String    |
|                              | `lud16`                            | `nostr:lud16`         | String    |
| 30023, 30024 (NIP-23)        | `title` tag                        | `nostr:title`         | String    |
|                              | `summary` tag                      | `nostr:summary`       | String    |
|                              | `image` tag                        | `nostr:image`         | IRI       |
|                              | `published_at` tag                 | `nostr:publishedAt`   | Integer   |
| 10002 (NIP-65)               | `r` tag without marker, or `read`  | `nostr:readRelay`     | Relay IRI |
|                              | `r` tag without marker, or `write` | `nostr:writeRelay`    | Relay IRI |
| 10063 (BUD-03)               | `server` tag                       | `nostr:blossomServer` | IRI       |

Profile JSON that does not parse, and fields of the wrong type, are ignored. A
value mapped to an IRI is written only if it is an absolute `http:`, `https:`,
`ws:` or `wss:` IRI that is valid in N-Triples.

### Bookkeeping added by the store

| Predicate            | Meaning                                                       |
| -------------------- | ------------------------------------------------------------- |
| `nostr:supersededBy` | Older event → the event that replaced it                      |
| `nostr:deletedBy`    | Event → the kind 5 event by the same author that retracted it |

**Replaceable events** are kinds 0, 3 and 10000–19999, keyed by (kind, pubkey).
**Addressable events** are kinds 30000–39999, keyed by (kind, pubkey, `d`). For
each key the events form a chain: every event except the newest has exactly one
`nostr:supersededBy`. When an event arrives the store compares it with the
current head of its key. The newer one wins; with equal `created_at` the one
with the lexically lower id wins (NIP-01). The loser gets
`nostr:supersededBy <winner>`. Events may arrive in any order.

**Deletion requests** (kind 5) mark each target that has the same author: events
referenced by `e` tags, and all versions of an address referenced by an `a` tag
that are not newer than the deletion request. A retracted event that is offered
again is rejected, whichever arrived first.

**Ephemeral events** (kinds 20000–29999) are never stored.

**Order and repair.** A group of events is inserted as one document: each
event's triples complete with its `nostr:sig` (written last, so an event counts
as stored once it has it), then the `nostr:seenOn` additions, then the
`supersededBy` / `deletedBy` bookkeeping. The stub of a stale follow or mute
list carries its own `supersededBy` before its `nostr:sig`; the version it
points at is complete in the graph or earlier in the document. Every backend
writes a document in this order: the embedded store loads it at once and appends
it to its log, the endpoint store sends it in requests of consecutive lines, one
after the other (a split inside an event leaves that event incomplete), and the
QLever store writes it as one file.

The invariant: **a bookkeeping triple is only written after the event it points
at is complete.** The graph only grows, so bookkeeping that points at an event
which never became complete cannot be taken back, and would hide the older
version for good (no version of a profile, no follow list) while nothing offers
the newer event again. Bookkeeping that is missing can be added later. So the
only intermediate state an insert that is cut off can leave (the embedded log
after a crash, a failed request of a SPARQL endpoint) is "events stored,
bookkeeping missing": two versions of a key are current for a while, a follow
list is briefly the merge of both, a retracted event is still served. Events
that are not complete are not stored; they are offered and planned again.

The repair (`src/store/repair.ts`) finds the missing bookkeeping from the graph
alone: replaceable and addressable keys with more than one current version (only
versions with `nostr:sig` count, and the newest of them wins, so a version
without it is never a winner) and kind 5 events (with `nostr:sig`) whose
same-author targets lack `nostr:deletedBy`. It writes the missing triples by the
rules above and logs how many it wrote (nothing when there was nothing to
write). It runs at start-up and again before the next commit after an insert
failed, or 30 seconds after it on a node that receives nothing, without a
restart; if the repair itself fails it is logged and tried again, and does not
reject events. A repair at runtime that wrote something is announced to the
listeners of `EventStore.onRepaired`; the social graph recomputes on it, since
it may have read two versions of a list as current. A healthy graph costs five
queries however many deletion requests it holds: a deletion naming a replaceable
event by `a` tag is a candidate only if its author has an undeleted event of the
kind in the coordinate (the kind is read from the `tag:a` value).

A store written by the first version of this order (events without `nostr:sig`,
bookkeeping, then signatures) and cut before the signatures can hold
`supersededBy` / `deletedBy` triples that point at an event without `nostr:sig`.
They cannot be removed and the queries do not look for them; the repair does not
treat such an event as a winner, and once the event is received again it is the
current version.

#### Stale follow and mute lists

A follow list (kind 3) or mute list (kind 10000) that loses on arrival to a
version that is already current, in the graph or earlier in the same group, is
written as a stub:

| Predicate                                                     | Object                                 |
| ------------------------------------------------------------- | -------------------------------------- |
| `nostr:author`, `nostr:kind`, `nostr:createdAt`, `nostr:date` | As for every event                     |
| `nostr:seenOn`                                                | The relay it was received from, if any |
| `nostr:supersededBy`                                          | The version it lost to                 |
| `nostr:sig`                                                   | The signature, last                    |

It has no `nostr:content`, no `nostr:tags`, no tag index and no link triple.
Such a version is never served, and its list can be long. Replication pages the
replaceable kinds backwards in time, so a relay that keeps old versions hands
over an author's whole history newest first, and nearly every version arrives
superseded. Written in full, each version added its whole list again.

Otherwise a stub is an event like any other: the add is `stored`, subscribers
are told, its id is known (also after a restart), it is counted, and offered
again it is a `duplicate` that may still add a `nostr:seenOn`. Its `e`-tag
deletion is recorded as usual.

`supersededBy` is one of the stub's own triples, before its `nostr:sig`, not
part of the bookkeeping at the end of the document. A complete stub without it
would read as the current version, an empty list, and would be served as an
event with empty tags and an invalid id. Written this way, an insert cut off
anywhere leaves either an incomplete stub (no `nostr:sig`: ignored, and planned
again when offered again) or a complete stub that is already superseded. The
triple points at an event that is complete in the graph or earlier in the same
document, so the invariant of
[Order and repair](#bookkeeping-added-by-the-store) holds.

A stub is recognisable as a kind 3 or 10000 event with `nostr:supersededBy` and
without `nostr:tags`. A genuine empty list has no `nostr:tags` either; once it
is superseded it looks the same, and neither is ever served.

Only these two kinds are stubbed; superseded versions of every other kind
(profiles, relay lists, articles, …) are stored in full. A list version that is
the newest when it arrives is stored in full, and keeps all its triples when a
newer one supersedes it later. Stores written before this rule keep the stale
versions they hold in full, with `tag:p` as well: nothing is removed.

## Blobs

Blob bytes are files; their descriptions are triples.

```turtle
<urn:sha256:b167…> nostr:blobSize 184292 ;
                   nostr:blobType "image/jpeg" .

<urn:uuid:5f0c…>   nostr:blob <urn:sha256:b167…> ;
                   nostr:uploadedBy <nostr:npub1…> ;
                   nostr:uploadedAt 1794528000 .
```

Each upload creates a receipt. Deleting a blob adds `nostr:removedAt` to the
uploader's receipts for it; a blob's file is removed once no receipt without
`nostr:removedAt` is left. Uploading it again creates a fresh receipt.

## Query idioms

Exclusions are written as `MINUS { … }` after the pattern that binds the
variable, not as `FILTER NOT EXISTS { … }`. The two return the same rows here,
but QLever answers a query that has several `FILTER NOT EXISTS` slowly. On a
graph of 1.9 million triples (156 000 events) the key query of the home feed
took about 7 s with three of them and about 0.15 s with three `MINUS` (0.03 s
once QLever has the parts cached); a page of the feed took 6.5 s against 0.2 s.
On a node with unmerged updates the first form runs into QLever's 30 s limit
("Operation timed out. Last operation: Query planning"). Oxigraph evaluates both
forms in about the same time (the key query takes 50 ms with `FILTER NOT EXISTS`
and 75 ms with `MINUS`).

The current profile of every author of a recent note:

```sparql
SELECT ?note ?content ?createdAt ?author ?name ?picture WHERE {
  VALUES ?date { "2026-11-13"^^xsd:date "2026-11-12"^^xsd:date }
  ?note nostr:date ?date ;
        nostr:kind 1 ;
        nostr:createdAt ?createdAt ;
        nostr:author ?author ;
        nostr:content ?content .
  MINUS { ?note nostr:deletedBy ?deletion }
  MINUS { ?note nostr:replyTo ?parent }
  OPTIONAL {
    ?profile nostr:author ?author ; nostr:kind 0 .
    MINUS { ?profile nostr:supersededBy ?newer }
    OPTIONAL { ?profile nostr:name ?name }
    OPTIONAL { ?profile nostr:picture ?picture }
  }
}
ORDER BY DESC(?createdAt)
LIMIT 50
```

Whom somebody currently follows, and the notes of those people:

```sparql
SELECT ?note ?createdAt WHERE {
  ?list nostr:author <nostr:npub1…> ; nostr:kind 3 ; nostr:follows ?author .
  MINUS { ?list nostr:supersededBy ?newer }
  ?note nostr:author ?author ; nostr:kind 1 ; nostr:createdAt ?createdAt .
  MINUS { ?note nostr:deletedBy ?deletion }
}
ORDER BY DESC(?createdAt) LIMIT 50
```

The current version of every article (NIP-23):

```sparql
SELECT ?article ?version ?title ?summary ?image ?author WHERE {
  ?version nostr:kind 30023 ;
           nostr:address ?article ;
           nostr:author ?author .
  MINUS { ?version nostr:supersededBy ?newer }
  MINUS { ?version nostr:deletedBy ?deletion }
  OPTIONAL { ?version nostr:title ?title }
  OPTIONAL { ?version nostr:summary ?summary }
  OPTIONAL { ?version nostr:image ?image }
}
```

Replies to and reactions on a note:

```sparql
SELECT (COUNT(DISTINCT ?reply) AS ?replies) (COUNT(DISTINCT ?reaction) AS ?reactions) WHERE {
  { ?reply nostr:replyTo <nostr:note1…> . MINUS { ?reply nostr:deletedBy ?d1 } }
  UNION
  { ?reaction nostr:reactsTo <nostr:note1…> . MINUS { ?reaction nostr:deletedBy ?d2 } }
}
```

Whether a version is the current one, as a column instead of a filter, uses
`OPTIONAL` and `BOUND`, because `MINUS` cannot produce a value
(`BIND(NOT EXISTS
{ … } AS ?current)` evaluates the pattern per row like the
filter does). A version has at most one `nostr:supersededBy`, so this adds no
rows:

```sparql
SELECT ?version ?current WHERE {
  ?version nostr:kind 30023 .
  OPTIONAL { ?version nostr:supersededBy ?newer }
  BIND(!BOUND(?newer) AS ?current)
}
```

Rules of thumb for fast queries:

1. Start from something selective: a known author, event, tag value or a small
   set of `nostr:date` values. `ORDER BY` over an unrestricted pattern sorts
   every match.
2. Always exclude `nostr:deletedBy`, and exclude `nostr:supersededBy` whenever
   the kind is replaceable or addressable. Use `MINUS`, placed after the pattern
   that binds the variable (`MINUS` removes from what precedes it in the group).
   It needs a variable shared with that pattern, so write
   `MINUS { ?e nostr:deletedBy ?deletion }`, never `MINUS { ?x … }` with a
   variable of its own, which removes nothing; and the subtracted pattern must
   not contain a `FILTER` that refers to variables outside it. Name the
   variables used only inside differently at each use. Where a condition does
   not fit, keep `FILTER NOT EXISTS`.
3. Fetch the optional parts (`OPTIONAL`) of a page of results in a second query
   over `VALUES ?e { … }` of the ids the first one returned, not in the query
   that sorts and limits: joined before the `LIMIT`, they are evaluated for
   every candidate. Keep each `OPTIONAL` a single triple pattern; an `OPTIONAL`
   group with its own `OPTIONAL`s takes seconds on Oxigraph.
4. Restrict kinds with `FILTER(?kind IN (1, 6))` rather than
   `VALUES ?kind { 1 6 }` joined to `nostr:kind ?kind`: Oxigraph needs seconds
   for the latter on a large store, QLever is faster with the filter as well.
