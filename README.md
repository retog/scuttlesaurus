# Deno SSB Experiments

![](https://tokei.rs/b1/github/retog/deno-ssb-experiments)

Both [Deno](https://deno.land/) and the
[Scuttlebutt Protocol](https://ssbc.github.io/scuttlebutt-protocol-guide/) are
new to me. My primary goal of this project is to learn about them, so I'm trying
to build things from scratch rather than porting
[ssb-server](https://github.com/ssbc/ssb-server). Pratcical usability of the
code is currently a subordinate goal.

## Usage

There are currently two executables.

play.ts: This establishes a connection to a an address specified as the first
argument, requests the feed specified in the second argument, or the main feed
of the address if no second argument is given, and saves all received messages
in a folder in `data/feeds`. For example the following command will store all
messages of `@2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY=.ed255` it gets in the
folder `data/feeds/2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY=/`:

    deno run -A  play.ts "net:gossip.noisebridge.info:8008~shs:2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY="

FindPeers: listens for peers announcing themselves with UDP broadcast.

    deno run --unstable -A FindPeers.ts

## Using this project as a dev containers with VSCode:

1. Install Docker
2. Install the VSCode extension
   [Remote Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
3. Clone the repo
4. Open the repo in VSCode
5. Click open in Dev Container
