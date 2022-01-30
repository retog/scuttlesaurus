# Scuttlesaurus

Scuttlesaurus implements the Secure Scuttlebutt (SSB) protocol in Typescript to
run in [Deno](https://deno.land/) as well as in browsers. It is based on the
[Scuttlebutt Protocol Guide](https://ssbc.github.io/scuttlebutt-protocol-guide/)
with some tweaks to be interoperable with existing implementation, specifically:

- for computing their sha256 hashes messages are encoded using the non-standard
  encoding nodejs refers to as _binary_ or _latin1_
- response to blobs.createWants may contain multiple blobs
- blobs.get requests with a json object (rather than just a blob id as string)
  point to the blob id with the key _id_ rather than _hash_.

The following parts of the guide are not currently implemented:

- private messages
- pub invites
- transitive following
- publishing messages

As both [Deno](https://deno.land/) and the
[Scuttlebutt Protocol](https://ssbc.github.io/scuttlebutt-protocol-guide/) are
new to me, an important goal of this project is to learn about them, so I'm
trying to build things from scratch rather than porting
[ssb-server](https://github.com/ssbc/ssb-server). The code shall provide a
library to use Scuttlebut technology in TypeScrit and JavaScript applications.
It makes extenive use of _AsyncIterables_ and attempts to minimize dependencies.
By itself the code can be used to provide pub like functionality and collect and
share the contents of feeds and blobs.

## Standalone Usage

The main executables is `main.ts`, executing it with

    deno run --unstable -A main.ts

will start a host interacting on the Scuttlebut network according to the
configuration files in `~/.ssb`. By default feeds are stored in
`~/.ssb/data/feeds`, one folder per feed, e.g. all messages of
`@2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY=.ed255` are in the folder
`data/feeds/2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY=/`.

The following command-line options are supported:

- baseDir: The base directory (default: `~/.ssb`)
- logLevel: DEBUG, INFO, WARNING , ERROR or CRITICAL
- incoming: Accept incoming connections (default: true)

Additional the properties of the web endpoints can be configured with in the
form `--web.control.hostname 0.0.0.0`, an endpoint can be disabled with
`--web.control.hostname false`.

## Configuration

Scuttlesaurus can be configured with a `config.json` file in the base directory.
This is the default configuraton:

```
{
   baseDir: "/path/to/base/dir/",
   dataDir: "/path/to/data/dir,
   transport: {
     net: {
       port: 8008,
     },
     ws: {
       web: ["access"],
     },
   },
   networkIdentifier: "1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=",
   acceptIncomingConnections: true,
   web: {
     control: {
       port: 8000,
       hostname: "localhost",
     },
     access: {
       port: 8989,
       hostname: "0.0.0.0",
     },
   },
   agents: {
     feeds: {},
     blobs: {}
   },
 }
```

## Web Control

If control.web is enabled the list of peers and followees can be modified at
runtime. Here are some examples using Curl.

Add a peer:

    curl -X POST http://localhost:8000/peers -H 'Content-Type: application/json' -d '{"address":"net:eu-west.ssbpeer.net:8008~shs:4TG/WLESyhThgTvmi5W3baX//tbF0HyskFprREqHbyc="}'

Remove peer:

    curl -X POST http://localhost:8000/peers -H 'Content-Type: application/json' -d '{"address":"net:eu-west.ssbpeer.net:8008~shs:4TG/WLESyhThgTvmi5W3baX//tbF0HyskFprREqHbyc=", "action":"remove"}'

Follow feed:

    curl -X POST http://localhost:8000/followees -H 'Content-Type: application/json' -d '{"id":"@IX0YhhVNgs9btLPepGlyLpXKvB0URDHLrmrm4yDlD1c=.ed25519"}'

Unfollow feed:

    curl -X POST http://localhost:8000/followees -H 'Content-Type: application/json' -d '{"id":"@IX0YhhVNgs9btLPepGlyLpXKvB0URDHLrmrm4yDlD1c=.ed25519", "action":"remove"}'

## Using this project as a dev containers with VSCode:

1. Install Docker
2. Install the VSCode extension
   [Remote Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
3. Clone the repo
4. Open the repo in VSCode
5. Click open in Dev Container
