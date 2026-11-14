/**
 * Serves `web/dist` with single-page-app fallback so the client can be looked
 * at without the backend. `/api/*` and `/sparql` answer 503. Port: `PORT`
 * (default 4173).
 *
 * @module
 */
import { serveDir } from "@std/http/file-server";
import { dirname, fromFileUrl, join } from "@std/path";

const dist = join(dirname(fromFileUrl(import.meta.url)), "..", "web", "dist");
const port = Number(Deno.env.get("PORT") ?? 4173);

Deno.serve({ port, hostname: "127.0.0.1" }, async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/") || pathname === "/sparql") {
    return Response.json({ error: "no backend in preview" }, { status: 503 });
  }
  const response = await serveDir(request, { fsRoot: dist, quiet: true });
  if (response.status !== 404) return response;
  const index = new Request(new URL("/index.html", request.url), request);
  return serveDir(index, { fsRoot: dist, quiet: true });
});
