/**
 * Service worker of the web client. It does three things:
 *
 * - keeps the app shell (index.html, the bundle, styles and icons) so the
 *   installed app opens without a network; the network always wins when it
 *   answers, because the build does not fingerprint file names,
 * - answers `POST /share`, the share target of the manifest: the files of a
 *   share go to the `scuttlesaurus-share` cache, where the `/share` view picks
 *   them up, and the browser is redirected to `/share?title=…&text=…&url=…`,
 * - leaves everything else alone: the relay, the API, SPARQL and Blossom are
 *   never answered from a cache.
 */

const SHELL_CACHE = "scuttlesaurus-shell-v1";
const SHARE_CACHE = "scuttlesaurus-share";
const INDEX = "/index.html";

/** Files of the shell, kept at install so the first offline start works. */
const SHELL = [
  INDEX,
  "/assets/app.js",
  "/assets/tokens.css",
  "/assets/base.css",
  "/assets/layout.css",
  "/assets/components.css",
  "/assets/prose.css",
  "/assets/views-notes.css",
  "/assets/views-reads.css",
  "/assets/views-node.css",
  "/assets/views-profile.css",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {/* the shell fills in as it is fetched */})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("scuttlesaurus-shell-"))
            .filter((key) => key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        )
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === "POST" && url.pathname === "/share") {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET") return;
  if (request.headers.get("upgrade")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
  } else if (isShellFile(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname));
  }
});

/** Whether a path is a static file of the client (never data). */
function isShellFile(pathname) {
  return pathname.startsWith("/assets/") || pathname.startsWith("/icons/") ||
    pathname === "/favicon.svg" || pathname === "/manifest.webmanifest";
}

/**
 * A page load: from the network; the client's routes come back as index.html,
 * which is kept. Offline, the kept index.html lets the client route itself.
 */
async function navigation(request) {
  try {
    const response = await fetch(request);
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && type.startsWith("text/html")) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(INDEX, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(INDEX);
    if (cached) return cached;
    throw error;
  }
}

/** A shell file: from the network, else from the cache. */
async function networkFirst(request, key) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(key, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(key);
    if (cached) return cached;
    throw error;
  }
}

/**
 * The share target: keep the shared files for the `/share` view and redirect
 * there with the text fields in the query.
 */
async function receiveShare(request) {
  const target = new URLSearchParams();
  try {
    const form = await request.formData();
    for (const field of ["title", "text", "url"]) {
      const value = form.get(field);
      if (typeof value === "string" && value.trim() !== "") {
        target.set(field, value);
      }
    }
    const files = form.getAll("files").filter((f) =>
      typeof f !== "string" && f.size > 0
    );
    await caches.delete(SHARE_CACHE);
    if (files.length) {
      const cache = await caches.open(SHARE_CACHE);
      await Promise.all(files.map((file, i) =>
        cache.put(
          `/share-inbox/${i}`,
          new Response(file, {
            headers: {
              "content-type": file.type || "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name || `shared-${i}`),
            },
          }),
        )
      ));
      target.set("files", String(files.length));
    }
  } catch {
    target.set("files", "dropped");
  }
  const query = target.toString();
  return Response.redirect(`/share${query ? `?${query}` : ""}`, 303);
}
