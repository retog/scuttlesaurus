//https://deno.land/x/scuttlesaurus@0.1.0/
import { proxy } from "https://deno.land/x/oak_http_proxy@2.0.0/mod.ts";
import {
  Application,
  Context,
  Middleware,
  Router,
  send,
} from "https://deno.land/x/oak@v10.2.0/mod.ts";
import { createScuttlebuttHost } from "../scuttlesaurus/main.ts";
import SparqlStorer from "./SparqlStorer.ts";
import {
  BlobId,
  fromBase64,
  fromFilenameSafeAlphabet,
  log,
  path,
} from "../scuttlesaurus/util.ts";

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
const portalOwner = Deno.env.get("SSB_PORTAL_OWNER");

const storer = new SparqlStorer(
  sparqlEndpointQuery,
  sparqlEndpointUpdate,
  Deno.env.get("SPARQL_ENDPOINT_CREDENTIALS"),
);
storer.connectAgent(host.feedsAgent!);
const staticDir = path.join(path.dirname(path.fromFileUrl(import.meta.url)),"/static");
function addCommonEndpoints(
  { application, router }: {
    application: Application<
      // deno-lint-ignore no-explicit-any
      Record<string, any>
    >;
    router: Router<
      // deno-lint-ignore no-explicit-any
      Record<string, any>
    >;
  },
) {
  router.all(
    "/query",
    proxy(sparqlEndpointQuery, {
      filterReq: (req, _res) => {
        return req.method !== "GET";
      },
      srcResHeaderDecorator: () =>
        new Headers({ "Cache-Control": "max-age=30, public" }),
    }),
  );
  /** the owner if one is set, otherwise scuttlesaurus identity */
  router.get("/main-identity", (ctx: Context) => {
    ctx.response.body = JSON.stringify({
      feedId: portalOwner ?? host.identity,
    });
  });
  router.get(
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
      try {
        const data = await host.blobsAgent.storage.getBlob(blobId);
        ctx.response.body = data;
        ctx.response.headers.append(
          "Cache-Control",
          "Immutable, max-age=604800, public",
        );
      } catch (_error) {
        ctx.response.status = 404;
      }
    },
  );
  application.use(staticFiles(path.join(staticDir,"common")));
}
addCommonEndpoints(host.webEndpoints.access);
addCommonEndpoints(host.webEndpoints.control);

host.webEndpoints.access.application.use(staticFiles(path.join(staticDir,"access")));
host.webEndpoints.control.application.use(staticFiles(path.join(staticDir,"control")));
//await registerFollowees(host, sparqlEndpointQuery);
await host.start();
log.info("Host terminated");

function staticFiles(
  baseDir: string,
) {
  const middleware: Middleware = async function (ctx, next) {
    if (ctx.isUpgradable) {
      await next();
    } else {
      const fsPath = path.join(baseDir, ctx.request.url.pathname);
      try {
        await Deno.stat(fsPath);
        //file or diretory exists
        await send(ctx, fsPath, {
          root: "/",
          index: "index.html",
        });
      } catch (_error) {
        await next();
      }
    }
  };
  return middleware;
}
