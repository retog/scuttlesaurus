//https://deno.land/x/scuttlesaurus@0.1.0/
import staticFiles from "https://x.nest.land/static_files@1.1.2/mod.ts";
import { proxy } from "https://deno.land/x/oak_http_proxy@2.0.0/mod.ts";
import { createScuttlebuttHost } from "../scuttlesaurus/main.ts";
import SparqlStorer from "./SparqlStorer.ts";
import { log } from "../scuttlesaurus/util.ts";

function getRequiredEnvVar(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`The environment variable "${name}" must be set.`);
  }
  log.debug(() => `${name} set to ${value}`);
  return value;
}

const sparqlEndpointQuery = getRequiredEnvVar("SPARQL_ENDPOINT_QUERY");
const sparqlEndpointUpdate = getRequiredEnvVar("SPARQL_ENDPOINT_UPDATE");

const host = await createScuttlebuttHost();
const storer = new SparqlStorer(sparqlEndpointQuery, sparqlEndpointUpdate);
storer.connectAgent(host.feedsAgent!);
host.controlAppRouter!.all("/query", proxy(sparqlEndpointQuery));
host.controlApp!.use(staticFiles("static"));
host.start();
