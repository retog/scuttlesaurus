//https://deno.land/x/scuttlesaurus@0.1.0/
import { proxy } from "https://deno.land/x/oak_http_proxy@2.0.0/mod.ts";
import {
  Application,
  Context,
  Middleware,
  Router,
  send,
} from "https://deno.land/x/oak@v10.2.0/mod.ts";
import { createScuttlebuttConfig } from "../scuttlesaurus/main.ts";
import SparqlStorer from "./SparqlStorer.ts";
import {
  BlobId,
  delay,
  fromBase64,
  fromFilenameSafeAlphabet,
  parseFeedId,
  path,
} from "../scuttlesaurus/util.ts";
import registerFollowees from "./registerFollowees.ts";
import DenoScuttlebuttHost from "../scuttlesaurus/DenoScuttlebuttHost.ts";
import FeedsStorage from "../scuttlesaurus/storage/FeedsStorage.ts";

function getRequiredEnvVar(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`The environment variable "${name}" must be set.`);
  }
  console.debug(() => `${name} set to ${value}`);
  return value;
}

const sparqlEndpointQuery = getRequiredEnvVar("SPARQL_ENDPOINT_QUERY");
const sparqlEndpointUpdate = getRequiredEnvVar("SPARQL_ENDPOINT_UPDATE");

const storer = new SparqlStorer(
  sparqlEndpointQuery,
  sparqlEndpointUpdate,
  Deno.env.get("SPARQL_ENDPOINT_CREDENTIALS"),
);

const storeFeedsInFiles = Deno.env.get("FEEDS_STORAGE") === "FILES";

class TriceraHost extends DenoScuttlebuttHost {
  createFeedsStorage(): FeedsStorage | undefined {
    if (storeFeedsInFiles) {
      return super.createFeedsStorage();
    } else {
      return storer;
    }
  }
}

const host = new TriceraHost(await createScuttlebuttConfig());
const portalOwner = Deno.env.get("SSB_PORTAL_OWNER");

const mainIdentity = portalOwner ? parseFeedId(portalOwner) : host.identity;

if (storeFeedsInFiles) {
  storer.connectAgent(host.feedsAgent!);
}
const staticDir = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "/static",
);
const hostRun = host.start();
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
      filterReq: (req: { method: string }, _res: unknown) => {
        return req.method !== "GET";
      },
      srcResHeaderDecorator: () =>
        new Headers({ "Cache-Control": "max-age=30, public" }),
    }),
  );
  /** the owner if one is set, otherwise scuttlesaurus identity */
  router.get("/main-identity", (ctx: Context) => {
    ctx.response.body = JSON.stringify({
      feedId: mainIdentity,
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
  application.use(staticFiles(path.join(staticDir, "common")));
}
addCommonEndpoints(host.webEndpoints.access);
addCommonEndpoints(host.webEndpoints.control);

host.webEndpoints.access.application.use(
  staticFiles(path.join(staticDir, "access")),
);
host.webEndpoints.control.application.use(
  staticFiles(path.join(staticDir, "control")),
);
while (true) {
  registerFollowees(mainIdentity, host, sparqlEndpointQuery);
  //update every 15 minutes
  await delay(15 * 60 * 1000);
}
//await hostRun;
console.info("Host terminated");

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
