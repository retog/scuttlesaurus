# Tricerascuttler

Consumes a set of feeds using Scuttlesaurus to aggregate the data in an RDF
store accessed via SPARQL.

![](https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/LA-Triceratops_mount-2.jpg/1280px-LA-Triceratops_mount-2.jpg)

## Running

The recommended way to run Tricerascuttler is with docker-compose

    docker-compose up

Afer starting the instance you can access the web interface at
http://localhost:8000/

If you want to use your existing Scuttlebutt identity with Tricerascuttler you can mount you existing `.ssb` directory to the docker by adding the following to the `tricerascuttler` service in `docker-compose.yml`:

```
  volumes:
      - ~/.ssb:/home/deno/.ssb
```

Alternatively `main.ts` can be run directly with Deno. It accepts the command
line options and configurations of Scuttlesaurus. Additionally the following
environment variables must be set:

- SPARQL_ENDPOINT_QUERY
- SPARQL_ENDPOINT_UPDATE

## Developing

It i recommended to open this project as a dev container in VSCode. This will
automatically start a Blazegraph Triple store and appropriately set the
environment variables.

## Mascot

The project mascot is a
[Triceratops prorsus](https://synospecies.plazi.org/#Triceratops+prorsus) a
friendly herbivore than can weigh up to 12'000 Kg. Its image near the top of
this document is from
[Wikimedia](https://commons.wikimedia.org/wiki/File:LA-Triceratops_mount-1.jpg).
