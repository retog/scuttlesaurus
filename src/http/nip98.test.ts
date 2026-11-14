import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  makeFixture,
  newSigner,
  nip98Event,
  nip98Header,
  sha256Hex,
  signEvent,
} from "./test_helpers.ts";

const BASE = "http://127.0.0.1:7777";
const CONFIG_URL = `${BASE}/api/config`;

/** A GET of the owner-only settings with the given Authorization header. */
function getConfig(authorization?: string, headers: HeadersInit = {}) {
  return new Request(CONFIG_URL, {
    headers: authorization === undefined
      ? headers
      : { ...headers, Authorization: authorization },
  });
}

Deno.test("a valid owner authorization opens the owner endpoints", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(
      getConfig(nip98Header(nip98Event(owner, { url: CONFIG_URL }))),
    );
    assertEquals(response.status, 200);
    await response.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("a valid authorization of another key is 403", async () => {
  const owner = newSigner();
  const stranger = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(
      getConfig(nip98Header(nip98Event(stranger, { url: CONFIG_URL }))),
    );
    assertEquals(response.status, 403);
    assertStringIncludes(
      (await response.json()).error,
      "only the owner",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("nobody is the owner of a node without one", async () => {
  const someone = newSigner();
  const fixture = await makeFixture();
  try {
    const response = await fixture.handler(
      getConfig(nip98Header(nip98Event(someone, { url: CONFIG_URL }))),
    );
    assertEquals(response.status, 403);
    await response.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("a missing authorization is 401 with a challenge", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(getConfig());
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("www-authenticate"), "Nostr");
    await response.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("malformed authorizations are 401", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const event = nip98Event(owner, { url: CONFIG_URL });
    const cases: Record<string, string> = {
      "not a Nostr scheme": `Bearer ${btoa("{}")}`,
      "not base64": "Nostr !!!not-base64!!!",
      "not JSON": `Nostr ${btoa("not json")}`,
      "not an event": `Nostr ${btoa('{"kind":27235}')}`,
      "tampered content": nip98Header({ ...event, content: "changed" }),
      "wrong kind": nip98Header(
        signEvent(owner, 1, "", [["u", CONFIG_URL], ["method", "GET"]]),
      ),
    };
    for (const [name, header] of Object.entries(cases)) {
      const response = await fixture.handler(getConfig(header));
      assertEquals(response.status, 401, name);
      await response.text();
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("a stale authorization is 401", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const old = Math.floor(Date.now() / 1000) - 120;
    const response = await fixture.handler(
      getConfig(
        nip98Header(nip98Event(owner, { url: CONFIG_URL, createdAt: old })),
      ),
    );
    assertEquals(response.status, 401);
    assertStringIncludes((await response.json()).error, "stale");
  } finally {
    await fixture.close();
  }
});

Deno.test("an authorization for another URL or method is 401", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const otherUrl = await fixture.handler(
      getConfig(
        nip98Header(
          nip98Event(owner, { url: `${BASE}/api/status` }),
        ),
      ),
    );
    assertEquals(otherUrl.status, 401);
    await otherUrl.text();

    const otherMethod = await fixture.handler(
      getConfig(
        nip98Header(
          nip98Event(owner, { url: CONFIG_URL, method: "POST" }),
        ),
      ),
    );
    assertEquals(otherMethod.status, 401);
    await otherMethod.text();

    const noUrl = await fixture.handler(
      getConfig(
        nip98Header(signEvent(owner, 27235, "", [["method", "GET"]])),
      ),
    );
    assertEquals(noUrl.status, 401);
    await noUrl.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("the URL includes the query string", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey, SPARQL_PUBLIC: "off" },
  });
  try {
    const query = "SELECT * WHERE { ?s ?p ?o } LIMIT 1";
    const url = `${BASE}/sparql?query=${encodeURIComponent(query)}`;

    // Signed for the path only, sent with a query: the URL does not match.
    const signedWithoutQuery = await fixture.handler(
      new Request(url, {
        headers: {
          Authorization: nip98Header(
            nip98Event(owner, { url: `${BASE}/sparql` }),
          ),
        },
      }),
    );
    assertEquals(signedWithoutQuery.status, 401);
    await signedWithoutQuery.text();

    const signed = await fixture.handler(
      new Request(url, {
        headers: { Authorization: nip98Header(nip98Event(owner, { url })) },
      }),
    );
    assertEquals(signed.status, 200);
    await signed.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("the payload tag must match a body that is sent", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const body = JSON.stringify({ name: "renamed" });
    const url = CONFIG_URL;
    const put = (payload: string) =>
      fixture.handler(
        new Request(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: nip98Header(
              nip98Event(owner, { url, method: "PUT", payload }),
            ),
          },
          body,
        }),
      );

    const wrong = await put(await sha256Hex(new TextEncoder().encode("other")));
    assertEquals(wrong.status, 401);
    await wrong.text();

    const right = await put(await sha256Hex(new TextEncoder().encode(body)));
    assertEquals(right.status, 200);
    await right.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("behind a reverse proxy the external URL is accepted", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(
      new Request(CONFIG_URL, {
        headers: {
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "saurus.example.org",
          Authorization: nip98Header(
            nip98Event(owner, { url: "https://saurus.example.org/api/config" }),
          ),
        },
      }),
    );
    assertEquals(response.status, 200);
    await response.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("the configured public URL is accepted for the signed URL", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey, PUBLIC_URL: "https://public.example.org/node" },
  });
  try {
    const response = await fixture.handler(
      getConfig(
        nip98Header(
          nip98Event(owner, {
            url: "https://public.example.org/node/api/config",
          }),
        ),
      ),
    );
    assertEquals(response.status, 200);
    await response.text();
  } finally {
    await fixture.close();
  }
});
