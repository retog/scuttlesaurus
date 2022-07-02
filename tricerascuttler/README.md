# Tricerascuttler

Consumes a set of feeds using Scuttlesaurus to aggregate the data in an RDF
store accessed via SPARQL.

![](https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/LA-Triceratops_mount-2.jpg/1280px-LA-Triceratops_mount-2.jpg)

## Running

The recommended way to run Tricerascuttler is with docker-compose

    docker-compose up

Afer starting the instance you can access the web interface at
http://localhost:8000/

If you want to use your existing Scuttlebutt identity with Tricerascuttler you
can mount you existing `.ssb` directory to the docker by adding the following to
the `tricerascuttler` service in `docker-compose.yml`:

```
volumes:
    - ~/.ssb:/home/deno/.ssb
```

Alternatively `main.ts` can be run directly with Deno. It accepts the command
line options and configurations of Scuttlesaurus. Additionally the following
environment variables must be set:

- SPARQL_ENDPOINT_QUERY
- SPARQL_ENDPOINT_UPDATE

By default Tricerascuttler uses the an Scuttlesaurus' primary identity as the
identity of the portal owner. As tha actual owner of the portal may not want to
store their secret key on the computer running Tricerascuttler a different
identity can be specified with the environment variable

- SSB_PORTAL_OWNER

The value must an SSB "sigil" Feed-ID, e.g.
`@IX0YhhVNgs9btLPepGlyLpXKvB0URDHLrmrm4yDlD1c=.ed25519`. If this variable is
set, the content users see will be based on the contents and
follow-relationsship of this identity.

## Developing

It i recommended to open this project as a dev container in VSCode. This will
automatically start a Blazegraph Triple store and appropriately set the
environment variables.

To generate the scuttlesaurus bundle used in the browser run:

    deno run -A ./build.ts

Subsequently you can run the programm with:

    deno run --unstable -A ./main.ts --web.control.hostname 0.0.0.0 --logLevel INFO

## Mascot

The project mascot is a
[Triceratops prorsus](https://synospecies.plazi.org/#Triceratops+prorsus) a
friendly herbivore than can weigh up to 12'000 Kg. Its image near the top of
this document is from
[Wikimedia](https://commons.wikimedia.org/wiki/File:LA-Triceratops_mount-1.jpg).
