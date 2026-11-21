/**
 * Tests of `GET /list/<pubkey>` and `DELETE /<sha256>` (BUD-02).
 * @module
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { BlobDescriptor } from "./blob.ts";
import {
  authorization,
  blobDirEntries,
  newSigner,
  sha256,
  withFixture,
} from "./fixtures.ts";
import { describeBlobNTriples, receiptNTriples } from "./triples.ts";

const ALICE = newSigner();
const BOB = newSigner();
const MEMBERS = { [ALICE.pubkey]: 1, [BOB.pubkey]: 2 };
const BASE = "http://localhost";
const BYTES = new TextEncoder().encode("shared file");
const HASH = sha256(BYTES);

async function upload(
  server: { handle(r: Request): Promise<Response | null> },
  who: typeof ALICE,
  bytes = BYTES,
  hash = sha256(bytes),
): Promise<void> {
  const response = await server.handle(
    new Request(`${BASE}/upload`, {
      method: "PUT",
      body: bytes,
      headers: {
        "Content-Type": "text/plain",
        Authorization: authorization(who, "upload", { hashes: [hash] }),
      },
    }),
  );
  assertEquals(response?.status, 200);
  await response!.body?.cancel();
}

function remove(
  server: { handle(r: Request): Promise<Response | null> },
  who: typeof ALICE,
  hash = HASH,
): Promise<Response | null> {
  return server.handle(
    new Request(`${BASE}/${hash}`, {
      method: "DELETE",
      headers: {
        Authorization: authorization(who, "delete", { hashes: [hash] }),
      },
    }),
  );
}

async function list(
  server: { handle(r: Request): Promise<Response | null> },
  pubkey: string,
  query = "",
): Promise<BlobDescriptor[]> {
  const response = await server.handle(
    new Request(`${BASE}/list/${pubkey}${query}`),
  );
  assertEquals(response?.status, 200);
  return response!.json();
}

Deno.test("list returns the blobs of a pubkey, newest first", () =>
  withFixture(MEMBERS, async ({ server, triples }) => {
    // Receipts with fixed times, so that the order is not left to the clock.
    const hashes = [1, 2, 3].map((i) => sha256(new Uint8Array([i])));
    for (const [i, hash] of hashes.entries()) {
      await triples.insert(describeBlobNTriples(hash, 1, "text/plain"));
      await triples.insert(
        receiptNTriples(
          `urn:uuid:00000000-0000-4000-8000-00000000000${i}`,
          hash,
          ALICE.pubkey,
          1000 * (i + 1),
        ),
      );
    }
    const all = await list(server, ALICE.pubkey);
    assertEquals(all.map((d) => d.uploaded), [3000, 2000, 1000]);
    assertEquals(all[0].sha256, hashes[2]);
    assertEquals(all[0].url, `${BASE}/${hashes[2]}.txt`);
    assertEquals(all[0].type, "text/plain");

    const window = await list(server, ALICE.pubkey, "?since=1500&until=2500");
    assertEquals(window.map((d) => d.uploaded), [2000]);
    assertEquals(await list(server, BOB.pubkey), []);
  }));

Deno.test("list omits blobs whose receipts were removed", () =>
  withFixture(MEMBERS, async ({ server }) => {
    await upload(server, ALICE);
    assertEquals((await list(server, ALICE.pubkey)).length, 1);
    assertEquals((await remove(server, ALICE))?.status, 200);
    assertEquals(await list(server, ALICE.pubkey), []);
  }));

Deno.test("list rejects a malformed pubkey or time bound with 400", () =>
  withFixture(MEMBERS, async ({ server }) => {
    const bad = [
      `${BASE}/list/not-a-key`,
      `${BASE}/list/${ALICE.pubkey}?since=yesterday`,
      `${BASE}/list/${ALICE.pubkey}?until=-5`,
    ];
    for (const url of bad) {
      const response = await server.handle(new Request(url));
      assertEquals(response?.status, 400);
      assertEquals(response?.headers.get("X-Reason") !== null, true);
    }
  }));

Deno.test("delete by someone without an upload is 404", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    await upload(server, ALICE);
    const response = await remove(server, BOB);
    assertEquals(response?.status, 404);
    assertEquals(await blobDirEntries(dataDir), [HASH]);
  }));

Deno.test("delete without a matching delete authorization is 401", async (t) => {
  await t.step(
    "no authorization",
    () =>
      withFixture(MEMBERS, async ({ server }) => {
        await upload(server, ALICE);
        const response = await server.handle(
          new Request(`${BASE}/${HASH}`, { method: "DELETE" }),
        );
        assertEquals(response?.status, 401);
      }),
  );
  await t.step(
    "authorization for another blob",
    () =>
      withFixture(MEMBERS, async ({ server, dataDir }) => {
        await upload(server, ALICE);
        const response = await server.handle(
          new Request(`${BASE}/${HASH}`, {
            method: "DELETE",
            headers: {
              Authorization: authorization(ALICE, "delete", {
                hashes: [sha256(new Uint8Array(1))],
              }),
            },
          }),
        );
        assertEquals(response?.status, 401);
        assertEquals(await blobDirEntries(dataDir), [HASH]);
      }),
  );
  await t.step(
    "upload authorization instead of delete",
    () =>
      withFixture(MEMBERS, async ({ server }) => {
        await upload(server, ALICE);
        const response = await server.handle(
          new Request(`${BASE}/${HASH}`, {
            method: "DELETE",
            headers: {
              Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
            },
          }),
        );
        assertEquals(response?.status, 401);
      }),
  );
});

Deno.test("the file stays while another owner remains, and goes with the last", () =>
  withFixture(MEMBERS, async ({ server, dataDir, triples }) => {
    await upload(server, ALICE);
    await upload(server, BOB);

    const first = await remove(server, ALICE);
    assertEquals(first?.status, 200);
    assertEquals(await first?.text(), "");
    assertEquals(await blobDirEntries(dataDir), [HASH]);
    assertEquals((await list(server, BOB.pubkey)).length, 1);

    const last = await remove(server, BOB);
    assertEquals(last?.status, 200);
    await last?.body?.cancel();
    assertEquals(await blobDirEntries(dataDir), []);
    assertEquals(
      await triples.ask(`PREFIX nostr: <nostr:ontology:>
      ASK { ?r nostr:removedAt ?t }`),
      true,
    );
  }));

Deno.test("a removed blob can be uploaded again", () =>
  withFixture(MEMBERS, async ({ server, dataDir }) => {
    await upload(server, ALICE);
    await (await remove(server, ALICE))?.body?.cancel();
    assertEquals(await blobDirEntries(dataDir), []);

    await upload(server, ALICE);
    assertEquals(await blobDirEntries(dataDir), [HASH]);
    assertEquals((await list(server, ALICE.pubkey)).length, 1);
    assertEquals(
      new Uint8Array(await Deno.readFile(join(dataDir, "blobs", HASH))),
      BYTES,
    );
  }));
