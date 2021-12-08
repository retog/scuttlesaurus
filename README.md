# Scuttlesaurus Habitat

![](https://tokei.rs/b1/github/retog/scuttlesaurus)

Scuttlesaurus Habitat is the monorepo where Scuttlesaurus lives with a couple of
friends. Together they aim at providing decentralized social media based on
[Scuttlebutt](https://scuttlebutt.nz/) technology.

- [Scuttlesaurus](scuttlesaurus): implements the
  [Scuttlebutt Protocol](https://ssbc.github.io/scuttlebutt-protocol-guide/) in
  Typescript to run in [Deno](https://deno.land/) as well as in browsers. It
  provides a simple Scuttlebutt implementation that can be used to run a
  standalone host relying feeds and blobs over tcp as well as websocket
  connections, or used as library in code written for Deno or for the browser.

- [Compsoscuttly](compsoscuttly): This is a small client application running
  entirely in the browser. It can connect to pubs via websockets and display the
  contents of feeds.

- [Tricerascuttler](tricerascuttler): stores the feeds retrieved by
  Scuttlesaurus in an RDF Graph-Database to allow fast and easy access to
  relevant content.
