# Scuttlesaurus

Scuttlesaurus is an implementation of the
[Scuttlebutt Protocol](https://ssbc.github.io/scuttlebutt-protocol-guide/) in
Typescript to run in [Deno](https://deno.land/) as well as in browsers.

Scuttlesaurus comprises the following projects:

- [Scuttlesaurus](scuttlesaurus): provides a simple Scuttlebutt implementation
  that can be used to run a standalone host relying feeds and blobs over tcp as
  well as websocket connections or used as library in code written for deno or
  the browser.

- [Compsoscuttly](compsoscuttly): This is a small client application running
  entirely in the browser. It can connect to pubs via websockets and display the
  contents of feeds.

The project mascot is a [Compsognathus longipes](https://synospecies.plazi.org/#Compsognathus+longipes)
![](https://upload.wikimedia.org/wikipedia/commons/c/c4/Compsognathus_BW.jpg)
