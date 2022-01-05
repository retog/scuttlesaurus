//https://deno.land/x/scuttlesaurus@0.1.0/
import staticFiles from "https://x.nest.land/static_files@1.1.3/mod.ts";
import { proxy } from "https://deno.land/x/oak_http_proxy@2.0.0/mod.ts";
import { createScuttlebuttHost } from "../scuttlesaurus/main.ts";
import SparqlStorer from "./SparqlStorer.ts";
import {
  BlobId,
  fromBase64,
  fromFilenameSafeAlphabet,
  log,
} from "../scuttlesaurus/util.ts";
import { Context } from "https://deno.land/x/oak@v10.1.0/context.ts";

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
if (!host.controlAppRouter) {
  throw new Error("Tricerascuttler requires the control web app");
}
host.controlAppRouter.all("/query", proxy(sparqlEndpointQuery));
host.controlAppRouter.get(
  "/blob/sha256/:hash",
  async (ctx: Context) => {
    const base64hash = fromFilenameSafeAlphabet(
      (ctx as unknown as { params: Record<string, string> }).params.hash,
    );
    const hash = fromBase64(base64hash);
    const blobId = new BlobId(hash);
    if (!host.blobsAgent) {
      throw new Error("No BlobsAgent");
    }
    host.blobsAgent.want(blobId);
    const data = await host.blobsAgent.fsStorage.getBlob(blobId);
    ctx.response.body = data;
  },
);
host.controlApp!.use(staticFiles("static"));
host.start();
