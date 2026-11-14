# Developing Scuttlesaurus

This guide is for working on the code. For running a node, read
[INSTALL.md](INSTALL.md). For the design, read
[ARCHITECTURE.md](ARCHITECTURE.md) and [DATA-MODEL.md](DATA-MODEL.md).

## Layout

The source layout is in [ARCHITECTURE.md](ARCHITECTURE.md#source-layout). In
short: `main.ts` starts the node, `src/` holds the server, `web/` holds the web
client (a separate Deno workspace member), `scripts/` holds the build, the
development loop and the demo seed, and `vocab/nostr.ttl` describes the
vocabulary.

Conventions you will find in the code:

- Interfaces between modules are in [`src/types.ts`](../src/types.ts). Modules
  depend on those interfaces, not on each other's implementations.
- Each module directory exports its factory from its `mod.ts`, for example
  `createSocialGraph` in `src/social/mod.ts`.
- Tests live next to the code as `*.test.ts`.
- The JSDoc of a module names the NIP or BUD it implements, and the section of
  the documentation it follows.

## Tasks

Run tasks with `deno task <name>`. They are defined in
[`deno.json`](../deno.json).

| Task    | Command                       | What it does                                                                                                                              |
| ------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `build` | `deno task build`             | Bundles the web client into `web/dist/`.                                                                                                  |
| `start` | `deno task start`             | Builds, then runs the node with `main.ts`.                                                                                                |
| `dev`   | `deno task dev`               | Builds the web client without minification, rebuilds it on each change under `web/src` or `web/static`, and runs the node with `--watch`. |
| `test`  | `deno task test`              | Runs every test with all permissions (`deno test -A`).                                                                                    |
| `check` | `deno task check`             | Type-checks `main.ts` and the web client, runs the linter and checks the formatting.                                                      |
| `seed`  | `deno task seed -- [options]` | Fills a running node with demo data. See [The demo world](#the-demo-world).                                                               |

Run the tests of one module, or one file, by passing a path:

```bash
deno test -A src/store/event_triples.test.ts
deno test -A src/replication/
```

To look at the web client without a node, build it and run `scripts/preview.ts`.
It serves `web/dist/` on port 4173, and answers `/api/*` and `/sparql` with 503.

```bash
deno task build
deno run -A scripts/preview.ts
```

## The demo world

`deno task seed` is an external Nostr client. It publishes a small, believable
social world to a running node through the node's public interfaces only:
profiles, follows, mutes, notes, replies, reactions, reposts, articles with
comments and media. The people, texts and articles are in `scripts/seed/data/`,
and the world is described in `scripts/seed/world.ts`.

By default the seed publishes to `http://127.0.0.1:7777` as the owner `mara`.
Pass other options after `--`:

```bash
deno task seed -- --url http://127.0.0.1:7777 --owner hub --quiet
```

| Option           | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `--url <url>`    | The node to seed. Must be `http` or `https`.             |
| `--owner <name>` | The owner: a persona's handle, or `hub`. Default `mara`. |
| `--quiet`, `-q`  | Print only the summary.                                  |
| `--help`, `-h`   | Print the usage.                                         |

If the node has no owner, the seed makes the owner the node's owner. If the node
already has another owner, most events are refused, as designed. Events from
authors outside the owner's social graph are refused with `blocked`. The summary
counts them separately from failures.

The seed prints a login for the owner: the `npub`, and the `nsec` of a key
derived from a known seed. These are public demo keys. Never use them for
anything real.

Run the seed again and the events are already present, so it is safe to repeat.

### Two nodes replicating

This recipe starts two nodes on one machine. Node A holds the demo world as
`hub`. Node B has `hub` as its owner and fetches the world from node A, through
the bootstrap relay of node A. Run each step in its own terminal, from the root
of the repository.

First build the web client once:

```bash
deno task build
```

Terminal 1, node A. Replication is off, because A only needs to serve the events
it holds:

```bash
REPLICATION=off PORT=7801 DATA_DIR=./node-a-data deno run -A main.ts
```

Terminal 2, seed node A as `hub`:

```bash
deno task seed -- --url http://127.0.0.1:7801 --owner hub
```

Terminal 3, node B. It is owned by `mara`, the owner of the demo world, and its
only bootstrap relay is node A. The demo keys are derived from a fixed seed, so
her `npub` is always the same:

```bash
OWNER=npub1had0shskyyfxgp2gwjscrwft623cc8weulc7x5rwthxnzamrwjwq9mhrzt \
BOOTSTRAP_RELAYS=ws://127.0.0.1:7801/ \
PORT=7802 DATA_DIR=./node-b-data \
deno run -A main.ts
```

Give node B half a minute, then, in a fourth terminal, look at its status:

```bash
curl -sS http://127.0.0.1:7802/api/status
```

Node B starts with nothing but its owner's key. It fetches her follow list, then
the follow lists of the people she follows, and ends up with `authorsByHop` of
`[1, 12, 30]` and about 490 of node A's 764 events: everything by `mara`, 90
days of the people she follows, and 14 days of the people they follow, without
their reactions. It holds nothing by the eight people three hops away, by the
person `mara` has muted, or by `hub`.

`replication.relays` lists `ws://127.0.0.1:7801/` as `connected`. The other
relays are the ones named in the demo data's relay lists. They do not exist, so
they stay in `backoff`; that does not affect the recipe.

The Network page, `http://127.0.0.1:7802/network`, shows the node's state in the
browser.

To stop, press Ctrl+C in each terminal. Delete `node-a-data` and `node-b-data`
when you are done; both are ignored by git.

## Adding support for another event kind

Supporting a new kind means changing the mapping in both directions and the
vocabulary, then documenting and testing it:

1. Map the kind to triples in
   [`src/store/event_triples.ts`](../src/store/event_triples.ts), in
   `eventToTriples`, and make sure `eventFromBinding` can rebuild the event from
   the triples. Use the existing predicates where they fit; add new ones only
   for new meaning.
2. Declare each new term in `TERMS` in [`src/vocab.ts`](../src/vocab.ts) and
   describe it in [`vocab/nostr.ttl`](../vocab/nostr.ttl), with a label and a
   comment. `src/store/vocab.test.ts` checks that every term in the Turtle file
   has a label and a comment, and that its domains and ranges name declared
   classes. It does not compare the two files, so check the agreement yourself.
3. Document the mapping in [`docs/DATA-MODEL.md`](DATA-MODEL.md), in the table
   of the kind's triples.
4. Add a test next to the mapping in `src/store/event_triples.test.ts`, covering
   the triples and the round trip.

If the kind should be fetched by replication, add it to the kind lists in
[`src/replication/wanted.ts`](../src/replication/wanted.ts) and to the table in
[ARCHITECTURE.md](ARCHITECTURE.md#replication-srcreplication). If the relay
should advertise a new NIP, add it to `supported_nips` in
[`src/relay/nip11.ts`](../src/relay/nip11.ts).
