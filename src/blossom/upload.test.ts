/**
 * Tests of `PUT /upload` and `HEAD /upload` (BUD-02, BUD-06).
 * @module
 */
import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import type { TripleStore } from "../types.ts";
import { PREFIXES, pubkeyIri } from "../vocab.ts";
import {
  authorization,
  blobDirEntries,
  newSigner,
  sha256,
  withFixture,
} from "./fixtures.ts";

const BYTES = new TextEncoder().encode("hello blossom");
const HASH = sha256(BYTES);
const ALICE = newSigner();
const BOB = newSigner();
const OUTSIDER = newSigner();
const MEMBERS = { [ALICE.pubkey]: 1, [BOB.pubkey]: 2 };
const BASE = "http://localhost";

function put(
  headers: Record<string, string>,
  body: BodyInit | null = BYTES,
): Request {
  return new Request(`${BASE}/upload`, { method: "PUT", body, headers });
}

function uploadHeaders(
  auth: string | undefined,
  contentType = "text/plain",
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (auth !== undefined) headers["Authorization"] = auth;
  return headers;
}

/** The receipts of one uploader for the test blob. */
function receiptsOf(triples: TripleStore, uploader: string) {
  return triples.select(`${PREFIXES}
    SELECT ?receipt WHERE {
      ?receipt nostr:blob <urn:sha256:${HASH}> ;
               nostr:uploadedBy <${pubkeyIri(uploader)}> .
      MINUS { ?receipt nostr:removedAt ?removed }
    }`);
}

Deno.test("upload returns a descriptor, stores the bytes and the triples", () =>
  withFixture(MEMBERS, async ({ server, dataDir, triples }) => {
    const response = await server.handle(put(
      uploadHeaders(
        authorization(ALICE, "upload", { hashes: [HASH] }),
        "image/PNG; charset=binary",
      ),
    ));
    assertEquals(response?.status, 200);
    const descriptor = await response!.json();
    assertEquals(descriptor.sha256, HASH);
    assertEquals(descriptor.size, BYTES.byteLength);
    assertEquals(descriptor.type, "image/png");
    assertEquals(descriptor.url, `${BASE}/${HASH}.png`);
    assertEquals(typeof descriptor.uploaded, "number");

    assertEquals(
      new Uint8Array(await Deno.readFile(join(dataDir, "blobs", HASH))),
      BYTES,
    );
    assertEquals(await blobDirEntries(dataDir), [HASH]);

    const described = await triples.ask(`${PREFIXES}
      ASK { <urn:sha256:${HASH}> nostr:blobSize "${BYTES.byteLength}"^^xsd:integer ;
                                 nostr:blobType "image/png" . }`);
    assertEquals(described, true);
    const receipts = await receiptsOf(triples, ALICE.pubkey);
    assertEquals(receipts.length, 1);
    assertMatch(receipts[0].receipt.value, /^urn:uuid:/);
  }));

Deno.test("a missing Content-Type is stored as application/octet-stream", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const response = await server.handle(
      new Request(`${BASE}/upload`, {
        method: "PUT",
        body: BYTES,
        headers: {
          Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
        },
      }),
    );
    assertEquals(response?.status, 200);
    assertEquals((await response!.json()).type, "application/octet-stream");
  }));

Deno.test("upload without authorization is 401", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    const response = await server.handle(put(uploadHeaders(undefined)));
    assertEquals(response?.status, 401);
    assertEquals(response?.headers.get("X-Reason") !== null, true);
    assertEquals(await blobDirEntries(dataDir), []);
  }));

Deno.test("upload with an expired authorization is 401", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const response = await server.handle(put(uploadHeaders(
      authorization(ALICE, "upload", { hashes: [HASH], expiration: past }),
    )));
    assertEquals(response?.status, 401);
  }));

Deno.test("upload with an authorization created in the future is 401", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const later = Math.floor(Date.now() / 1000) + 600;
    const response = await server.handle(put(uploadHeaders(
      authorization(ALICE, "upload", { hashes: [HASH], createdAt: later }),
    )));
    assertEquals(response?.status, 401);
  }));

Deno.test("upload with a wrong event kind is 401", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const response = await server.handle(put(uploadHeaders(
      authorization(ALICE, "upload", { hashes: [HASH], kind: 1 }),
    )));
    assertEquals(response?.status, 401);
  }));

Deno.test("upload with a delete authorization is 401", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const response = await server.handle(put(uploadHeaders(
      authorization(ALICE, "delete", { hashes: [HASH] }),
    )));
    assertEquals(response?.status, 401);
  }));

Deno.test("upload with an authorization for another blob is 400", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    const response = await server.handle(put(uploadHeaders(
      authorization(ALICE, "upload", { hashes: [sha256(new Uint8Array(1))] }),
    )));
    assertEquals(response?.status, 400);
    assertEquals(await blobDirEntries(dataDir), []);
  }));

Deno.test("an uploader outside the social graph is 403", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    const response = await server.handle(put(uploadHeaders(
      authorization(OUTSIDER, "upload", { hashes: [HASH] }),
    )));
    assertEquals(response?.status, 403);
    assertEquals(
      response?.headers.get("X-Reason"),
      "not within the social graph of this server's owner",
    );
    assertEquals(await blobDirEntries(dataDir), []);
  }));

Deno.test("a Content-Length above the limit is 413 before reading", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    const response = await server.handle(put({
      ...uploadHeaders(authorization(ALICE, "upload", { hashes: [HASH] })),
      "Content-Length": "999999999999",
    }, null));
    assertEquals(response?.status, 413);
    assertEquals(await blobDirEntries(dataDir), []);
  }, { blossom: { enabled: true, maxBlobSize: 100 } }));

Deno.test("a body above the limit is 413 and leaves no temporary file", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    const chunk = new Uint8Array(8).fill(7);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        if (++pulls >= 10) controller.close();
      },
    });
    const response = await server.handle(put(
      uploadHeaders(
        authorization(ALICE, "upload", { hashes: [HASH] }),
      ),
      body,
    ));
    assertEquals(response?.status, 413);
    assertEquals(await blobDirEntries(dataDir), []);
  }, { blossom: { enabled: true, maxBlobSize: 20 } }));

Deno.test("the same blob uploaded twice by one user has one receipt", () =>
  withFixture(MEMBERS, async ({ server, triples }) => {
    for (let i = 0; i < 2; i++) {
      const response = await server.handle(put(uploadHeaders(
        authorization(ALICE, "upload", { hashes: [HASH] }),
      )));
      assertEquals(response?.status, 200);
      await response!.body?.cancel();
    }
    assertEquals((await receiptsOf(triples, ALICE.pubkey)).length, 1);
  }));

Deno.test("the same blob uploaded by two users has two receipts", () =>
  withFixture(MEMBERS, async ({ server, dataDir, triples }) => {
    for (const who of [ALICE, BOB]) {
      const response = await server.handle(put(uploadHeaders(
        authorization(who, "upload", { hashes: [HASH] }),
      )));
      assertEquals(response?.status, 200);
      await response!.body?.cancel();
    }
    assertEquals((await receiptsOf(triples, ALICE.pubkey)).length, 1);
    assertEquals((await receiptsOf(triples, BOB.pubkey)).length, 1);
    assertEquals(await blobDirEntries(dataDir), [HASH]);
  }));

Deno.test("HEAD /upload answers 200 for an upload that would be accepted", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    const response = await server.handle(
      new Request(`${BASE}/upload`, {
        method: "HEAD",
        headers: {
          Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
          "X-SHA-256": HASH,
          "X-Content-Length": String(BYTES.byteLength),
          "X-Content-Type": "text/plain",
        },
      }),
    );
    assertEquals(response?.status, 200);
    assertEquals(await blobDirEntries(dataDir), []);
  }));

Deno.test("HEAD /upload reports why an upload would be refused", async (t) => {
  // Each case: the authorization's hashes (undefined: no authorization), the
  // headers sent, and the expected status.
  const cases: [
    string,
    string[] | undefined,
    Record<string, string>,
    number,
  ][] = [
    ["no authorization", undefined, { "X-SHA-256": HASH }, 401],
    ["malformed X-SHA-256", [HASH], { "X-SHA-256": "xyz" }, 400],
    ["authorization for another blob", [HASH], {
      "X-SHA-256": sha256(new Uint8Array(2)),
      "X-Content-Length": "5",
    }, 400],
    ["missing X-Content-Length", [HASH], { "X-SHA-256": HASH }, 400],
    [
      "too large",
      [HASH],
      { "X-SHA-256": HASH, "X-Content-Length": "9999" },
      413,
    ],
    ["malformed X-Content-Type", [HASH], {
      "X-SHA-256": HASH,
      "X-Content-Length": "5",
      "X-Content-Type": 'text/"plain"',
    }, 400],
  ];
  for (const [name, hashes, extra, status] of cases) {
    await t.step(
      name,
      () =>
        withFixture(MEMBERS, async ({ server, dataDir }) => {
          const headers: Record<string, string> = { ...extra };
          if (hashes !== undefined) {
            headers["Authorization"] = authorization(ALICE, "upload", {
              hashes,
            });
          }
          const response = await server.handle(
            new Request(`${BASE}/upload`, { method: "HEAD", headers }),
          );
          assertEquals(response?.status, status);
          assertEquals(response?.headers.get("X-Reason") !== null, true);
          assertEquals(await blobDirEntries(dataDir), []);
        }, { blossom: { enabled: true, maxBlobSize: 100 } }),
    );
  }
});

Deno.test("HEAD /upload is 403 for a pubkey outside the graph", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const response = await server.handle(
      new Request(`${BASE}/upload`, {
        method: "HEAD",
        headers: {
          Authorization: authorization(OUTSIDER, "upload", { hashes: [HASH] }),
          "X-SHA-256": HASH,
          "X-Content-Length": "5",
        },
      }),
    );
    assertEquals(response?.status, 403);
  }));

Deno.test("a Content-Type that cannot be written safely is 400", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    const response = await server.handle(put(uploadHeaders(
      authorization(ALICE, "upload", { hashes: [HASH] }),
      'text/plain"<x>',
    )));
    assertEquals(response?.status, 400);
    assertEquals(await blobDirEntries(dataDir), []);
  }));

Deno.test("an authorization whose content was altered is 401", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const header = authorization(ALICE, "upload", { hashes: [HASH] });
    const event = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(header.slice("Nostr ".length)),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    event.tags.push(["x", sha256(new Uint8Array(3))]);
    const forged = `Nostr ${btoa(JSON.stringify(event))}`;
    const response = await server.handle(put(uploadHeaders(forged)));
    assertEquals(response?.status, 401);
  }));
