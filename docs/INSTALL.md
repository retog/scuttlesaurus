# Installing Scuttlesaurus

This guide covers running a node from source, with Docker, behind a reverse
proxy, with an external triple store or QLever, and tuning replication. For what
the node is and how it works, read [ARCHITECTURE.md](ARCHITECTURE.md). For the
data, read [DATA-MODEL.md](DATA-MODEL.md).

- [Run from source](#run-from-source)
- [First run](#first-run)
- [Run with Docker](#run-with-docker)
- [Put it on the internet](#put-it-on-the-internet)
- [Use an external triple store](#use-an-external-triple-store)
- [Use QLever through qlever-dir](#use-qlever-through-qlever-dir)
- [Tune replication](#tune-replication)
- [Use the node from other software](#use-the-node-from-other-software)
- [Troubleshooting](#troubleshooting)

## Run from source

You need Deno 2.9. The project was tested with Deno 2.9.6; check yours with
`deno --version`. To install Deno, follow the instructions at
<https://deno.com>.

Clone the repository and start the node:

```bash
git clone https://github.com/retog/scuttlesaurus.git
cd scuttlesaurus
deno task start
```

`deno task start` builds the web client into `web/dist/` and then runs the node
in the foreground. The message `deno bundle is experimental` printed during the
build is expected. The node listens on `http://127.0.0.1:7777` by default. Stop
it with Ctrl+C.

### Where the data lives

Everything the node keeps is in one directory, `./data` by default. Set
`DATA_DIR` to put it elsewhere.

| File / directory  | Contents                                                                            |
| ----------------- | ----------------------------------------------------------------------------------- |
| `graph.nt`        | The RDF graph as N-Triples. An append-only log: lines are only ever added.          |
| `blobs/`          | Media files, named by their SHA-256.                                                |
| `config.json`     | Settings changed in the setup screen or the settings page.                          |
| `sync-state.json` | How far each author's events have been fetched, so a restart does not refetch them. |

To back up the node, stop it and copy the whole directory. To restore, copy the
directory back and start the node.

## First run

On a node with no owner, the first screen of the web client is the setup. Choose
an existing identity or create one in the browser, and it becomes the owner of
the node. The owner is the person whose social neighbourhood the node keeps.

For an unattended installation, set the owner in the environment:

```bash
OWNER=npub1… deno task start
```

`OWNER` accepts an `npub1…` or a 64-character hex public key. A node with an
`OWNER` never shows the setup screen, and the owner cannot be changed from the
settings page while the variable is set.

Set `OWNER` for any public installation. Without it, the first visitor to the
node becomes its owner, and that may not be you.

## Run with Docker

The repository contains a `Dockerfile` and a `docker-compose.yml`. From a clone:

```bash
docker compose up -d
```

Compose builds the image, starts the node on port 7777 and keeps its data in the
named volume `scuttlesaurus-data`, mounted at `/data` in the container. Open
`http://localhost:7777` to run the setup.

The image sets `HOSTNAME=0.0.0.0` and `DATA_DIR=/data`. The environment
variables are listed in `docker-compose.yml`; the common ones are commented out
there, so you can enable them by editing the file:

```yaml
environment:
  OWNER: npub1…
  PUBLIC_URL: https://your.host
```

Other settings from the
[table in ARCHITECTURE.md](ARCHITECTURE.md#configuration-srcconfigts) work the
same way.

To update, pull the new source and rebuild:

```bash
git pull
docker compose up -d --build
```

Your data stays in the volume. To see the logs, run `docker compose logs -f`. To
remove the node and its data, run `docker compose down -v`. That deletes the
volume, so do this only when you no longer need the data.

## Put it on the internet

A node serves its web client, its relay and its APIs on one port, and all of
them must be reachable under one origin. Two things must be true:

1. WebSocket connections must reach the node. The relay is on the same path as
   the web client, so the proxy must forward `Upgrade` requests.
2. `PUBLIC_URL` must be the address people use, such as `https://your.host`. The
   node uses it for its relay URL, for NIP-05 and NIP-98 checks, and in blob
   links. Without it, the node derives the address from each request, using
   `X-Forwarded-Proto` and `X-Forwarded-Host` when a proxy sends them.

The node listens on `127.0.0.1` by default, so it is reachable only from the
machine itself. Keep that and let a reverse proxy on the same machine serve the
public address. If the proxy runs on another machine, set `HOSTNAME=0.0.0.0` and
protect the port with a firewall.

### Caddy

Caddy obtains and renews the TLS certificate itself and forwards WebSockets
without extra configuration. This `Caddyfile` serves the node at
`https://your.host`:

```
your.host {
    reverse_proxy 127.0.0.1:7777
}
```

Set `PUBLIC_URL=https://your.host` for the node.

### nginx

With nginx you supply the certificate yourself, for example from Let's Encrypt.
Put the `map` block in the `http` context, for example in
`/etc/nginx/nginx.conf` or a file included from it. It sends
`Connection: upgrade` only for WebSocket requests:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name your.host;

    ssl_certificate     /etc/letsencrypt/live/your.host/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.host/privkey.pem;

    # Blob uploads. Match BLOSSOM_MAX_SIZE_MB (default 50).
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:7777;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
}

server {
    listen 80;
    server_name your.host;
    return 301 https://$host$request_uri;
}
```

Set `PUBLIC_URL=https://your.host` for the node. The `proxy_read_timeout` keeps
idle WebSocket subscriptions open; nginx closes them after 60 seconds otherwise.

### systemd, from source

To run the node as a service without Docker, create a dedicated user and a unit
file. Find the path of the Deno binary with `which deno` and put it into
`ExecStart` and `ExecStartPre`. The service user must be able to write to the
checkout, because the build writes `web/dist/`.

```bash
sudo useradd --system --home /var/lib/scuttlesaurus --shell /usr/sbin/nologin scuttlesaurus
sudo git clone https://github.com/retog/scuttlesaurus.git /opt/scuttlesaurus
sudo chown -R scuttlesaurus: /opt/scuttlesaurus
```

`/etc/systemd/system/scuttlesaurus.service`:

```ini
[Unit]
Description=Scuttlesaurus Nostr node
After=network-online.target
Wants=network-online.target

[Service]
User=scuttlesaurus
WorkingDirectory=/opt/scuttlesaurus
ExecStartPre=/usr/local/bin/deno task build
ExecStart=/usr/local/bin/deno run -A main.ts
StateDirectory=scuttlesaurus
CacheDirectory=scuttlesaurus
Environment=DATA_DIR=/var/lib/scuttlesaurus
Environment=DENO_DIR=/var/cache/scuttlesaurus
Environment=HOSTNAME=127.0.0.1
Environment=PORT=7777
Environment=PUBLIC_URL=https://your.host
Environment=OWNER=npub1…
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then start it and check the log:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scuttlesaurus
journalctl -u scuttlesaurus -n 20
```

Update the node by pulling the checkout, then restarting:

```bash
sudo -u scuttlesaurus git -C /opt/scuttlesaurus pull
sudo systemctl restart scuttlesaurus
```

## Use an external triple store

By default the graph is held in memory by the node and persisted to `graph.nt`.
That is simple and needs no other software. The embedded store keeps the whole
graph in memory, at roughly 0.5 GB per million triples, so use an external
SPARQL 1.1 endpoint for a node that is bigger than a few million triples.

Three variables select and configure the endpoint:

| Variable                      | Meaning                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `SPARQL_ENDPOINT_QUERY`       | The query URL. Setting it selects the endpoint store.                    |
| `SPARQL_ENDPOINT_UPDATE`      | The update URL. Defaults to the query URL.                               |
| `SPARQL_ENDPOINT_CREDENTIALS` | `user:password` for HTTP basic authentication, if the endpoint needs it. |

`SPARQL_ENDPOINT_UPDATE` and `SPARQL_ENDPOINT_CREDENTIALS` are refused unless
`SPARQL_ENDPOINT_QUERY` is also set. The node sends `INSERT DATA` requests to
the update URL and nothing else.

With an endpoint, the endpoint holds the graph instead of `graph.nt`, so back up
the endpoint's own data as well. The node still keeps `blobs/`, `config.json`
and `sync-state.json` in `DATA_DIR`. The node does not start the endpoint; run
it as a separate service.

An Oxigraph server is one option. Its query endpoint is `/query` and its update
endpoint is `/update`:

```bash
oxigraph serve --location ./oxigraph-data --bind 127.0.0.1:7878
SPARQL_ENDPOINT_QUERY=http://127.0.0.1:7878/query \
SPARQL_ENDPOINT_UPDATE=http://127.0.0.1:7878/update \
deno task start
```

The Oxigraph example is not yet tested against a running Oxigraph server; see
the README's status section before relying on it.

## Use QLever through qlever-dir

[qlever-dir](https://github.com/Retinue-OS/qlever-dir) turns a directory of RDF
files into a read-only SPARQL endpoint backed by
[QLever](https://github.com/ad-freiburg/qlever). With `QLEVER_DIR_URL` set, the
node keeps its graph as N-Triples files in a directory that qlever-dir watches,
and sends its queries to qlever-dir's endpoint. The node never sends SPARQL
Update to it.

Choose this store when QLever should answer the queries and you want the graph
to be plain files on disk that you can back up. The embedded store needs nothing
else, so keep it while the graph fits in memory.

The store was tested with qlever-dir 0.6.0 (QLever 0.6.0), run outside Docker,
on graphs of up to about ten thousand triples. The Compose setup below has not
been run yet.

### With Compose

From the clone, start the node with the override file next to the base file:

```bash
docker compose -f docker-compose.yml -f docker-compose.qlever.yml up -d
```

The override adds a `qlever` service, from the published image
`ghcr.io/retinue-os/qlever-dir:0.6.0`, and points the node at it. No port of
`qlever` is published on the host. It adds three named volumes:

- `graph`, which the node writes to at `/data/graph` and `qlever` reads at
  `/data`, read-only.
- `qlever-index-a` and `qlever-index-b`, which hold qlever-dir's two indexes.
  With them, an endpoint whose container was recreated, for example by an image
  update, answers from its last index while it rebuilds, instead of answering
  502 for the whole rebuild.

Compose starts the node only after `qlever` reports healthy. The node's other
data stays in `scuttlesaurus-data`, as before. Compose names the volumes after
the project, which is the directory name by default: the graph is in
`scuttlesaurus_graph` for a clone in a directory called `scuttlesaurus`.
`docker compose down -v` deletes that volume, and the graph with it.

**Switching an existing node.** The override does not move the graph by itself,
and the node does not fetch again what `sync-state.json` records as fetched.
Move the graph first; see
[Move a graph from the embedded store](#move-a-graph-from-the-embedded-store).

### Set it up by hand

Run qlever-dir yourself, and give the node three variables:

| Variable               | Meaning                                                                                           | Default                     |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| `QLEVER_DIR_URL`       | qlever-dir's SPARQL endpoint, for example `http://127.0.0.1:7001/`. Setting it selects the store. | none: the embedded store    |
| `QLEVER_DIR_GRAPH_DIR` | The directory the node writes its files to. It must be the directory qlever-dir watches.          | `<DATA_DIR>/graph`          |
| `QLEVER_DIR_BASE_URI`  | qlever-dir's `BASE_URI`: an absolute http or https URI ending with `/`.                           | `https://example.org/data/` |

`QLEVER_DIR_GRAPH_DIR` and `QLEVER_DIR_BASE_URI` are refused unless
`QLEVER_DIR_URL` is set, and `QLEVER_DIR_URL` cannot be set together with
`SPARQL_ENDPOINT_QUERY`.

```bash
QLEVER_DIR_URL=http://127.0.0.1:7001/ \
QLEVER_DIR_GRAPH_DIR=/srv/scuttlesaurus/graph \
deno task start
```

These settings must agree with qlever-dir's:

- qlever-dir's `/data` is the node's graph directory. Mount it there, read-only.
  qlever-dir only reads it.
- qlever-dir's `BASE_URI` is equal to `QLEVER_DIR_BASE_URI`. qlever-dir names
  the graph of each file by `BASE_URI` followed by the file's path under
  `/data`, and the node looks for the same names.
- `INCREMENTAL_DELAY=0`. qlever-dir applies a changed file after that many
  seconds without a further change to it. The node writes each file once and
  never changes it, so there is nothing to wait for. With the default of 2
  seconds, every event would be acknowledged 2 seconds later.
- `COMPACTION_DELTA_TRIPLES` sets how much change qlever-dir accepts before it
  rebuilds its whole index. Each file the node writes adds its triples to that
  count. When the count since the last full build reaches the value, qlever-dir
  rebuilds the index in the background. A lower value means more rebuilds. A
  higher one lets unmerged changes pile up, which slows queries, as qlever-dir's
  README explains. Merging the node's day files also causes a rebuild, because
  removing a directory is a structural change. Leave the default, 100000, unless
  you have measured a need to change it.

The directory must be on a local filesystem. qlever-dir detects changes with
inotify, which does not work reliably on NFS or on Docker Desktop for macOS and
Windows.

### What to expect

- **An event is acknowledged after about a second.** Measured with qlever-dir
  0.6.0 and `INCREMENTAL_DELAY=0`, a file of 10 triples could be queried 1.0 s
  after it was written, and a file of 5,000 triples 1.4 s after. qlever-dir
  applies the files one after another, about 80 ms each.
- **Bulk loads are slow.** Each write waits until its file is visible. Seeding
  the demo world through the relay took 211 s with this store, and about 7 s
  with the embedded store.
- **Queries see one graph.** A query without a `GRAPH` clause sees the union of
  the files' graphs, with set semantics. Of 77 distinct queries the web client
  issues on a tour of all its views, 74 returned the same rows on Oxigraph and
  on QLever over the same data. Of those 74, 21 came back in a different order,
  where the query does not fix one. The other 3 differed only in the order of
  ties or inside `GROUP_CONCAT`.
- **Integers have another datatype.** QLever returns integers as `xsd:int`,
  where the graph holds `xsd:integer`. The values are the same.
- **Merges and rebuilds keep the results.** In a test, a day of 300 small files
  was merged into one, and the index was rebuilt meanwhile. The number of
  matching triples did not change.
- **The first start waits for the first index.** qlever-dir answers 502 until it
  has built its first index. While the node waits, it logs
  `[qlever-dir] waiting for qlever-dir at <query URL> (it may still be building its first index)`.

### Move a graph from the embedded store

The embedded store keeps the whole graph in one file, `graph.nt` in `DATA_DIR`.
qlever-dir indexes any N-Triples file in the graph directory, so moving the
graph is copying that file. Stop the node, copy the file, and start the node
with `QLEVER_DIR_URL` set:

```bash
mkdir -p data/graph
cp data/graph.nt data/graph/embedded.nt
QLEVER_DIR_URL=http://127.0.0.1:7001/ deno task start
```

When it starts, the node waits until qlever-dir has indexed every file in the
graph directory, and logs that it does. In a test, a node started right after
the copy came up with the same 782 events, 9,095 triples and social graph as the
embedded node it was copied from. The node never changes or merges
`embedded.nt`. Keep `graph.nt` until you have checked the result; the node no
longer reads it.

With Compose, the embedded graph is in the volume mounted at `/data` and the new
graph directory is the volume mounted at `/data/graph`. Stop the node, then copy
inside a one-off container before starting with the override. This command has
not been run:

```bash
docker compose -f docker-compose.yml -f docker-compose.qlever.yml run --rm --no-deps --entrypoint cp scuttlesaurus /data/graph.nt /data/graph/embedded.nt
```

### Backup

The graph directory is the source of truth. qlever-dir's indexes in `/index-a`
and `/index-b` are built from it, and qlever-dir always rebuilds them when it
starts, so they need not be backed up. Back up the graph directory together with
`sync-state.json` in `DATA_DIR`, and at the same time: the file records how far
events were fetched, so the two must belong together. Stop the node first, for a
consistent copy. With Compose, the graph is in the volume `scuttlesaurus_graph`:

```bash
docker compose stop scuttlesaurus
docker run --rm -v scuttlesaurus_graph:/graph:ro -v "$PWD":/backup alpine tar -czf /backup/graph.tar.gz -C /graph .
docker compose start scuttlesaurus
```

To restore, stop the node and `qlever`, replace the contents of the graph
directory with the copy, and start them again.

### Troubleshooting

**Every write fails after two minutes.** Each insert fails with a message of
this form:

```
qlever-dir endpoint <query URL> did not show <file> (graph <<graph IRI>>) within 120 s (the graph holds 0 of 1 triples). Most likely QLEVER_DIR_BASE_URI (currently <base URI>) does not equal qlever-dir's BASE_URI plus the path of <graph directory> inside its /data; otherwise qlever-dir may be down or far behind. The file is kept in <graph directory> and will be indexed when qlever-dir catches up.
```

The node looks for each file under the graph IRI made of `QLEVER_DIR_BASE_URI`
and the file's path, and that graph never appears. The usual cause is that
`QLEVER_DIR_BASE_URI` is not qlever-dir's `BASE_URI`. qlever-dir does index the
file, but under its own base, and queries without a `GRAPH` clause see it. Make
the two equal, stop the node, and remove the files written while they differed.
Their names begin with the time of writing, in milliseconds since 1970. Then
start the node again.

**The endpoint does not answer at start.** The node prints a message of this
form and exits with status 1:

```
qlever-dir at <query URL> did not answer within 600 s: <reason>
```

The usual causes are a wrong `QLEVER_DIR_URL`, qlever-dir not running or not
reachable from the node, or an index still being built after 10 minutes. Check
the endpoint from the node's side:

```bash
curl -sS -X POST http://127.0.0.1:7001/ -H 'Content-Type: application/sparql-query' -H 'Accept: application/sparql-results+json' --data 'ASK {}'
```

It answers `{"boolean":true,"head":{}}` once it is ready. With Compose, Docker
restarts the node, which tries again.

## Tune replication

Replication decides which people's events the node keeps. Every setting below is
an environment variable. The defaults are in
[`src/config.ts`](../src/config.ts), and each can also be changed on the
settings page, except where the variable locks it.

| Variable               | Default            | What it does                                                                                                                  |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `HOPS`                 | `2`                | How many follow steps from the owner the node covers, 0 to 4. `1` keeps the owner's follows only.                             |
| `MAX_AUTHORS`          | `1500`             | The most authors kept. Beyond the cap, the authors followed by the most people in the previous step win.                      |
| `HORIZON_DAYS`         | `0,90,14`          | Days of history per distance: the owner (`0` = all), distance 1 (90 days), distance 2 and further (14 days).                  |
| `BOOTSTRAP_RELAYS`     | four public relays | Comma-separated `wss://` relays asked for everybody's profile, follows and relay list. Used when an author has no relay list. |
| `MAX_RELAYS`           | `12`               | The most relay connections at once.                                                                                           |
| `FORWARD`              | `all`              | Which events clients publish to the node are also sent to the author's write relays: `all`, `owner` or `none`.                |
| `REPLICATION`          | on                 | `off` stops all replication. The node still serves what it has.                                                               |
| `ALLOW_PRIVATE_RELAYS` | off                | Whether relay lists may name relays on private addresses. Bootstrap relays are always allowed.                                |

An example for a small community node that keeps only the owner's friends:

```bash
OWNER=npub1… HOPS=1 MAX_AUTHORS=300 deno task start
```

A node that is only a relay for files and notes you have already fetched can run
with `REPLICATION=off`.

## Use the node from other software

**Other Nostr clients.** Add `wss://your.host/` as a relay, with the path and
the trailing slash. The node serves everybody's events to readers. It accepts an
event only when its author is in the node's social graph, which is the owner and
the people within `HOPS` of the owner. Other events get `OK false` with the
reason `blocked`.

**Signer apps.** The web client can sign in with a signer app such as Amber
(NIP-46). The link it shows names this node's relay, built from the address the
page was opened with (or `PUBLIC_URL`), so the node must be reachable from the
phone under that address, and the page must not be opened as `localhost`. The
relay carries these messages (kind 24133, never stored) for any author, which is
the one exception to the rule that only the social graph may write. Set
`NOSTR_CONNECT=off` to remove the exception; the signer link then needs a relay
that is not this node.

**Blossom.** Use the base URL `https://your.host`, without a path. Uploads go to
`/upload`, and the same rule applies: only authors in the graph may upload.
Uploads and deletions are authorized with signed kind 24242 events.

**SPARQL.** The endpoint is `/sparql` on the node. It accepts queries only.
Updates are refused, so the graph is written only by publishing events. This
query lists the five most recent notes that are not superseded:

```bash
curl -sS -G "http://127.0.0.1:7777/sparql" \
  -H 'Accept: application/sparql-results+json' \
  --data-urlencode 'query=PREFIX nostr: <nostr:ontology:>
SELECT ?note ?content ?created WHERE {
  ?note nostr:kind 1 ; nostr:content ?content ; nostr:createdAt ?created .
  FILTER NOT EXISTS { ?note nostr:supersededBy ?newer }
}
ORDER BY DESC(?created) LIMIT 5'
```

Set `SPARQL_PUBLIC=off` to require the owner's NIP-98 authorization for queries.
For the vocabulary, see [DATA-MODEL.md](DATA-MODEL.md).

## Troubleshooting

**The web client says it "has not been built".** The `web/dist/` directory is
missing or empty. Run `deno task build`, then restart the node.
`deno task start` does this for you.

**The port is in use.** The node exits with
`Address already in use (os error
98)`. Another process holds the port, for
example an earlier node. Find it with `ss -ltnp | grep :7777`, stop it, or
choose another port with `PORT=7778 deno task start`.

**Nothing replicates.** Check three things, in this order:

1. The owner. Replication needs an owner. Open
   `http://localhost:7777/api/status` and check that `owner` is not `null`. Then
   check `setupRequired`.
2. The owner's follows. The graph is built from the owner's follow list (kind
   3). If the owner follows nobody, the graph holds only the owner. Look at
   `authorsByHop` in `/api/status`: `[1]` means nobody else is in range.
3. The relays. `replication.relays` in `/api/status` lists each relay with its
   `state` and `lastError`. A relay in `backoff` with a network error is not
   reachable from this machine. A node on a machine without outside network
   access will show every public relay in that state, and then it only sees
   relays it can reach, such as another node set as a bootstrap relay.

The Network page (`/network`) shows the same information in the browser.

**Configuration errors at start.** The node refuses to start and names the
variable or the file, for example
`Invalid OWNER="npub1…": must be an npub or a
64-character hex public key`.
Correct the value and start again.

**A configuration value cannot be changed in the settings page.** It is set by
an environment variable, which takes precedence over `config.json`. Remove the
variable and restart the node to change it there.
