# Deno SSB Experiments

![](https://tokei.rs/b1/github/retog/deno-ssb-experiments)

Both [Deno](https://deno.land/) and the
[Scuttlebutt Protocol](https://ssbc.github.io/scuttlebutt-protocol-guide/) are
new to me. My primary goal of this project is to learn about them, so I'm trying
to build things from scratch rather than porting
[ssb-server](https://github.com/ssbc/ssb-server). Pratcical usability of the
code is currently a subordinate goal.

## Usage

The main executables is `main.ts`, executing it with

    deno run --unstable -A main.ts

will start a host interacting on the Scuttlebut network according to the configuration
files in `~/.ssb`. By default feeds are stored in `~/.ssb/data/feeds`, one folder per feed, e.g. all
messages of `@2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY=.ed255` are in the
folder `data/feeds/2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY=/`:

FindPeers: listens for peers announcing themselves with UDP broadcast.

    deno run --unstable -A FindPeers.ts

## Using this project as a dev containers with VSCode:

1. Install Docker
2. Install the VSCode extension
   [Remote Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
3. Clone the repo
4. Open the repo in VSCode
5. Click open in Dev Container
