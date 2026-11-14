# Installing Scuttlesaurus

This guide covers running a node from source, with Docker, behind a reverse
proxy, with an external triple store, and tuning replication. For what the node
is and how it works, read [ARCHITECTURE.md](ARCHITECTURE.md). For the data, read
[DATA-MODEL.md](DATA-MODEL.md).

- [Run from source](#run-from-source)
- [First run](#first-run)
- [Run with Docker](#run-with-docker)
- [Put it on the internet](#put-it-on-the-internet)
- [Use an external triple store](#use-an-external-triple-store)
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
