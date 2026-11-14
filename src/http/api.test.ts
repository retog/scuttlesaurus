import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { nip19 } from "@nostr/tools";
import {
  jsonOf,
  makeFixture,
  newSigner,
  nip98Event,
  nip98Header,
  sha256Hex,
} from "./test_helpers.ts";

const BASE = "http://127.0.0.1:7777";
const CONFIG_URL = `${BASE}/api/config`;

Deno.test("setup sets the owner once, from an npub or hex key", async () => {
  const owner = newSigner();
  const fixture = await makeFixture();
  try {
    const npub = nip19.npubEncode(owner.pubkey);
    const first = await fixture.handler(
      new Request(`${BASE}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: npub }),
      }),
    );
    const status = await jsonOf(first, 200) as Record<string, unknown>;
    assertEquals(status.owner, owner.pubkey);
    assertEquals(status.setupRequired, false);
    assertEquals(fixture.node.configManager.config.owner, owner.pubkey);

    const second = await fixture.handler(
      new Request(`${BASE}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: newSigner().pubkey }),
      }),
    );
    assertEquals(second.status, 409);
    await second.text();
    assertEquals(fixture.node.configManager.config.owner, owner.pubkey);
  } finally {
    await fixture.close();
  }
});

Deno.test("two simultaneous setups produce one owner and one 409", async () => {
  const fixture = await makeFixture();
  try {
    const attempt = () =>
      fixture.handler(
        new Request(`${BASE}/api/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner: newSigner().pubkey }),
        }),
      );
    const responses = await Promise.all([attempt(), attempt()]);
    assertEquals(responses.map((r) => r.status).sort(), [200, 409]);
    await Promise.all(responses.map((r) => r.text()));
  } finally {
    await fixture.close();
  }
});

Deno.test("setup is refused with 400 for an invalid owner or body", async () => {
  const fixture = await makeFixture();
  try {
    const cases: Array<[string, string]> = [
      [JSON.stringify({ owner: "not-a-key" }), "must be an npub"],
      [JSON.stringify({ owner: 42 }), "npub or a hex"],
      ["[]", "JSON object"],
      ["not json", "JSON"],
    ];
    for (const [body, message] of cases) {
      const response = await fixture.handler(
        new Request(`${BASE}/api/setup`, { method: "POST", body }),
      );
      assertEquals(response.status, 400, body);
      assertStringIncludes((await response.json()).error, message);
    }
    assertEquals(fixture.node.configManager.config.owner, undefined);
  } finally {
    await fixture.close();
  }
});

Deno.test("setup is a 409 when the owner comes from the environment", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(
      new Request(`${BASE}/api/setup`, {
        method: "POST",
        body: JSON.stringify({ owner: newSigner().pubkey }),
      }),
    );
    assertEquals(response.status, 409);
    await response.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("GET /api/config lists the settings and the locked ones", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey, RELAY_NAME: "Locked name" },
  });
  try {
    const document = await jsonOf(
      await fixture.handler(
        new Request(CONFIG_URL, {
          headers: {
            Authorization: nip98Header(
              nip98Event(owner, { url: CONFIG_URL }),
            ),
          },
        }),
      ),
      200,
    ) as {
      settings: Record<string, unknown>;
      locked: string[];
    };
    assertEquals(document.settings.owner, owner.pubkey);
    assertEquals(document.settings.name, "Locked name");
    assertEquals(document.settings.publicUrl, null);
    assertEquals(Object.keys(document.settings).sort(), [
      "description",
      "name",
      "owner",
      "publicUrl",
      "replication",
    ]);
    assertEquals(document.locked, ["name", "owner", "replication.enabled"]);
  } finally {
    await fixture.close();
  }
});

Deno.test("PUT /api/config changes settings and answers like GET", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const put = async (body: string): Promise<Response> =>
      fixture.handler(
        new Request(CONFIG_URL, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: nip98Header(
              nip98Event(owner, {
                url: CONFIG_URL,
                method: "PUT",
                payload: await hashOf(body),
              }),
            ),
          },
          body,
        }),
      );
    const body = JSON.stringify({
      name: "Renamed",
      publicUrl: "https://saurus.example.org",
      replication: { hops: 3 },
    });
    const response = await put(body);
    const document = await jsonOf(response, 200) as {
      settings: {
        name: string;
        publicUrl: string;
        replication: { hops: number };
      };
    };
    assertEquals(document.settings.name, "Renamed");
    assertEquals(document.settings.publicUrl, "https://saurus.example.org");
    assertEquals(document.settings.replication.hops, 3);
    assertEquals(fixture.node.configManager.config.name, "Renamed");
    assertEquals(fixture.node.configManager.config.replication.hops, 3);
  } finally {
    await fixture.close();
  }
});

Deno.test("PUT /api/config refuses locked settings and bad values with 400", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({
    env: { OWNER: owner.pubkey, HOPS: "1" },
  });
  try {
    const put = async (body: string): Promise<Response> =>
      fixture.handler(
        new Request(CONFIG_URL, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: nip98Header(
              nip98Event(owner, {
                url: CONFIG_URL,
                method: "PUT",
                payload: await hashOf(body),
              }),
            ),
          },
          body,
        }),
      );

    const locked = await put(JSON.stringify({ replication: { hops: 4 } }));
    assertEquals(locked.status, 400);
    assertStringIncludes((await locked.json()).error, "replication.hops");

    const outOfRange = await put(
      JSON.stringify({ replication: { maxRelays: 0 } }),
    );
    assertEquals(outOfRange.status, 400);
    await outOfRange.text();

    const wrongType = await put(JSON.stringify({ name: 5 }));
    assertEquals(wrongType.status, 400);
    assertStringIncludes(
      (await wrongType.json()).error,
      "name must be a string",
    );

    const notJson = await put("{");
    assertEquals(notJson.status, 400);
    await notJson.text();
  } finally {
    await fixture.close();
  }
});

Deno.test("PUT /api/config requires the owner", async () => {
  const owner = newSigner();
  const fixture = await makeFixture({ env: { OWNER: owner.pubkey } });
  try {
    const response = await fixture.handler(
      new Request(CONFIG_URL, {
        method: "PUT",
        body: JSON.stringify({ name: "Nope" }),
      }),
    );
    assertEquals(response.status, 401);
    await response.text();
    assertEquals(fixture.node.configManager.config.name, "Scuttlesaurus");
  } finally {
    await fixture.close();
  }
});

Deno.test("setup changes the status from setup-required to configured", async () => {
  const fixture = await makeFixture();
  try {
    const before = await jsonOf(
      await fixture.handler(new Request(`${BASE}/api/status`)),
      200,
    ) as { setupRequired: boolean };
    assert(before.setupRequired);
    const owner = newSigner();
    const response = await fixture.handler(
      new Request(`${BASE}/api/setup`, {
        method: "POST",
        body: JSON.stringify({ owner: owner.pubkey }),
      }),
    );
    await response.text();
    const after = await jsonOf(
      await fixture.handler(new Request(`${BASE}/api/status`)),
      200,
    ) as { setupRequired: boolean; owner: string };
    assertEquals(after.setupRequired, false);
    assertEquals(after.owner, owner.pubkey);
  } finally {
    await fixture.close();
  }
});

/** The lower-case hex SHA-256 of a text body. */
function hashOf(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
