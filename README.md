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

play.ts: This establishes a connection to a specify address, requests its log
and outputs all received data as bytes and as text on the console. Example
usage:

    deno run -A  play.ts "net:gossip.noisebridge.info:8008~shs:2NANnQVdsoqk0XPiJG2oMZqaEpTeoGrxOHJkLIqs7eY="

main.ts: Starts a web-server on port `8000` and shows peers on the local network
detected via UDP.

    deno run -A  main.ts

## Using this project as a dev containers with VSCode:

1. Install Docker
2. Install the VSCode extension
   [Remote Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
3. Clone the repo
4. Open the repo in VSCode
5. Click open in Dev Container
