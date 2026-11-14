import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import denoJson from "../../deno.json" with { type: "json" };
import { makeFixture, newSigner, sha256Hex } from "./test_helpers.ts";

const BASE = "http://127.0.0.1:7777";

async function body(response: Response): Promise<string> {
  return await response.text();
}

Deno.test("GET /api/status describes a node without an owner", async () => {
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(new Request(`${BASE}/api/status`));
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assertEquals(response.headers.get("cache-control"), "no-store");
    const status = JSON.parse(await body(response));
    assertEquals(status.owner, null);
    assertEquals(status.setupRequired, true);
    assertEquals(status.version, denoJson.version);
    assertEquals(status.name, "Scuttlesaurus");
    assertEquals(status.publicUrl, BASE);
    assertEquals(status.relayUrl, "ws://127.0.0.1:7777/");
    assertEquals(status.hops, 2);
    assertEquals(status.publicSparql, true);
    assertEquals(status.blossom.enabled, true);
    assertEquals(status.blossom.maxBlobSize, 50 * 1024 * 1024);
    assertEquals(status.authorsByHop, []);
    assertEquals(status.connections, 0);
    assertEquals(status.replication.enabled, false);
    assertEquals(typeof status.stats.events, "number");
    assertEquals(typeof status.stats.triples, "number");
  } finally {
    await fixture.close();
  }
});

Deno.test("GET /api/status counts authors by hop and reports the owner", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey },
    distances: { [owner.pubkey]: 0, aa: 1, bb: 1, cc: 2 },
  });
  try {
    const response = await fixture.handler(new Request(`${BASE}/api/status`));
    const status = JSON.parse(await body(response));
    assertEquals(status.owner, owner.pubkey);
    assertEquals(status.setupRequired, false);
    assertEquals(status.authorsByHop, [1, 2, 1]);
  } finally {
    await fixture.close();
  }
});

Deno.test("status caches store statistics for a few seconds", async () => {
  const fixture = await makeFixture();
  try {
    const original = fixture.node.events.stats.bind(fixture.node.events);
    let calls = 0;
    fixture.node.events.stats = () => {
      calls++;
      return original();
    };
    await body(await fixture.handler(new Request(`${BASE}/api/status`)));
    await body(await fixture.handler(new Request(`${BASE}/api/status`)));
    assertEquals(calls, 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("status uses the forwarded origin behind a reverse proxy", async () => {
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/api/status`, {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "saurus.example.org",
        },
      }),
    );
    const status = JSON.parse(await body(response));
    assertEquals(status.publicUrl, "https://saurus.example.org");
    assertEquals(status.relayUrl, "wss://saurus.example.org/");
  } finally {
    await fixture.close();
  }
});

Deno.test("an invalid forwarded host falls back to the request origin", async () => {
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/api/status`, {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "evil.example/path",
        },
      }),
    );
    const status = JSON.parse(await body(response));
    assertEquals(status.publicUrl, BASE);
  } finally {
    await fixture.close();
  }
});

Deno.test("the configured public URL wins over forwarded headers", async () => {
  const fixture = await makeFixture({
    env: { PUBLIC_URL: "https://public.example.org/" },
  });
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/api/status`, {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "other.example.org",
        },
      }),
    );
    const status = JSON.parse(await body(response));
    assertEquals(status.publicUrl, "https://public.example.org");
    assertEquals(status.relayUrl, "wss://public.example.org/");
  } finally {
    await fixture.close();
  }
});

Deno.test("GET /api/graph returns the owner and the distances", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey, HOPS: "3" },
    distances: { [owner.pubkey]: 0, aa: 1 },
  });
  try {
    const response = await fixture.handler(new Request(`${BASE}/api/graph`));
    assertEquals(response.status, 200);
    const graph = JSON.parse(await body(response));
    assertEquals(graph, {
      owner: owner.pubkey,
      hops: 3,
      distances: { [owner.pubkey]: 0, aa: 1 },
    });
  } finally {
    await fixture.close();
  }
});

Deno.test("GET / with Accept application/nostr+json returns the NIP-11 document", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/`, {
        headers: { Accept: "application/nostr+json" },
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "application/nostr+json",
    );
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
    const info = JSON.parse(await body(response));
    assertEquals(info.name, "Scuttlesaurus");
    assertEquals(info.pubkey, owner.pubkey);
    assert(info.supported_nips.includes(11));
  } finally {
    await fixture.close();
  }
});

Deno.test("NIP-05 names the owner and the relay, or is empty before setup", async () => {
  const owner = newSigner();
  const empty = await makeFixture();
  try {
    const response = await empty.handler(
      new Request(`${BASE}/.well-known/nostr.json`),
    );
    assertEquals(JSON.parse(await body(response)), { names: {} });
  } finally {
    await empty.close();
  }

  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/.well-known/nostr.json`),
    );
    assertEquals(JSON.parse(await body(response)), {
      names: { _: owner.pubkey },
      relays: { [owner.pubkey]: ["ws://127.0.0.1:7777/"] },
    });
  } finally {
    await fixture.close();
  }
});

Deno.test("unknown API paths are 404 and wrong methods are 405 with Allow", async () => {
  const fixture = await makeFixture();
  try {
    const missing = await fixture.handler(new Request(`${BASE}/api/nothing`));
    assertEquals(missing.status, 404);
    assertEquals(
      JSON.parse(await body(missing)).error,
      "no such API endpoint",
    );

    const wrong = await fixture.handler(
      new Request(`${BASE}/api/status`, { method: "POST" }),
    );
    assertEquals(wrong.status, 405);
    assertEquals(wrong.headers.get("allow"), "GET");
    assertStringIncludes(await body(wrong), "method not allowed");
  } finally {
    await fixture.close();
  }
});

Deno.test("every ordinary response carries the CORS headers", async () => {
  const fixture = await makeFixture();
  try {
    for (
      const response of [
        await fixture.handler(new Request(`${BASE}/api/status`)),
        await fixture.handler(new Request(`${BASE}/api/nothing`)),
        await fixture.handler(new Request(`${BASE}/assets/app.js`)),
      ]
    ) {
      assertEquals(response.headers.get("access-control-allow-origin"), "*");
      assertEquals(response.headers.get("access-control-expose-headers"), "*");
      await body(response);
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("OPTIONS on any path is the CORS preflight answer", async () => {
  const fixture = await makeFixture();
  try {
    for (const path of ["/", "/api/config", "/sparql", "/anything/else"]) {
      const response = await fixture.handler(
        new Request(`${BASE}${path}`, { method: "OPTIONS" }),
      );
      assertEquals(response.status, 204);
      assertEquals(response.headers.get("access-control-allow-origin"), "*");
      assertEquals(
        response.headers.get("access-control-allow-methods"),
        "GET, HEAD, POST, PUT, DELETE, OPTIONS",
      );
      assertEquals(
        response.headers.get("access-control-allow-headers"),
        "Authorization, Content-Type, X-SHA-256, X-Content-Length, X-Content-Type",
      );
      assertEquals(response.headers.get("access-control-max-age"), "86400");
      await body(response);
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("the route order: /sparql is not a file, a Blossom hash is not the client", async () => {
  const fixture = await makeFixture();
  try {
    const sparql = await fixture.handler(
      new Request(`${BASE}/sparql?query=ASK%20%7B%7D`, {
        headers: { Accept: "text/html" },
      }),
    );
    assertEquals(sparql.status, 200);
    assertEquals(
      sparql.headers.get("content-type"),
      "application/sparql-results+json",
    );
    await body(sparql);

    const hash = await sha256Hex(new TextEncoder().encode("missing"));
    const blob = await fixture.handler(
      new Request(`${BASE}/${hash}`, { headers: { Accept: "text/html" } }),
    );
    assertEquals(blob.status, 404);
    assert(!(blob.headers.get("content-type") ?? "").includes("text/html"));
    await body(blob);
  } finally {
    await fixture.close();
  }
});

Deno.test("a handler error becomes a 500 JSON response", async () => {
  const fixture = await makeFixture();
  try {
    fixture.node.replicator.status = () => {
      throw new Error("boom");
    };
    const response = await fixture.handler(new Request(`${BASE}/api/status`));
    assertEquals(response.status, 500);
    assertEquals(JSON.parse(await body(response)), {
      error: "internal server error",
    });
  } finally {
    await fixture.close();
  }
});
