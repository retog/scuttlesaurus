# Tricerascuttler

Consumes a set of feeds using Scuttlesaurus to aggregate the data in an RDF
store accessed via SPARQL.

## Running

The recommended way to run Tricerascuttler is with docker-compose

    docker-compose up

Alternatively `main.ts` can be run directly with Deno. It accepts the command line options and configurations of Scuttlesaurus. Additionally the following environment variables must be set:

 - SPARQL_ENDPOINT_QUERY
 - SPARQL_ENDPOINT_UPDATE

## Developing

It i recommended to open this project as a dev container in VSCode. This will automatically start a Apache Jena Fuseki Triple store and appropriately set the environment variables.