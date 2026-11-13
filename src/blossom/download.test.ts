/**
 * Tests of `GET` and `HEAD /<sha256>[.ext]` (BUD-01).
 * @module
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { authorization, newSigner, sha256, withFixture } from "./fixtures.ts";

const BYTES = new TextEncoder().encode("0123456789abcdefghij");
const HASH = sha256(BYTES);
const ALICE = newSigner();
const BASE = "http://localhost";

/** Upload the test blob as Alice, with the given media type. */
async function uploadBlob(
  server: { handle(r: Request): Promise<Response | null> },
  type = "image/jpeg",
): Promise<void> {
  const response = await server.handle(
    new Request(`${BASE}/upload`, {
      method: "PUT",
      body: BYTES,
      headers: {
        "Content-Type": type,
        Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
      },
    }),
  );
  assertEquals(response?.status, 200);
  await response!.body?.cancel();
}

Deno.test("GET returns the bytes with the stored type and cache headers", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    await uploadBlob(server);
    const response = await server.handle(new Request(`${BASE}/${HASH}`));
    assertEquals(response?.status, 200);
    assertEquals(response?.headers.get("Content-Type"), "image/jpeg");
    assertEquals(
      response?.headers.get("Content-Length"),
      String(BYTES.byteLength),
    );
    assertEquals(response?.headers.get("Accept-Ranges"), "bytes");
    assertEquals(
      response?.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
    assertEquals(new Uint8Array(await response!.arrayBuffer()), BYTES);
  }));

Deno.test("GET ignores the extension of the URL", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    await uploadBlob(server);
    const response = await server.handle(new Request(`${BASE}/${HASH}.jpg`));
    assertEquals(response?.status, 200);
    assertEquals(new Uint8Array(await response!.arrayBuffer()), BYTES);
  }));

Deno.test("GET honours a Range request with 206", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    await uploadBlob(server);
    const response = await server.handle(
      new Request(`${BASE}/${HASH}`, {
        headers: { Range: "bytes=4-9" },
      }),
    );
    assertEquals(response?.status, 206);
    assertEquals(
      response?.headers.get("Content-Range"),
      `bytes 4-9/${BYTES.byteLength}`,
    );
    assertEquals(response?.headers.get("Content-Type"), "image/jpeg");
    assertEquals(
      new Uint8Array(await response!.arrayBuffer()),
      BYTES.subarray(4, 10),
    );
  }));

Deno.test("HEAD returns the same headers and no body", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    await uploadBlob(server);
    const response = await server.handle(
      new Request(`${BASE}/${HASH}.jpg`, { method: "HEAD" }),
    );
    assertEquals(response?.status, 200);
    assertEquals(response?.headers.get("Content-Type"), "image/jpeg");
    assertEquals(
      response?.headers.get("Content-Length"),
      String(BYTES.byteLength),
    );
    assertEquals(response?.headers.get("Accept-Ranges"), "bytes");
    assertEquals(
      response?.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
    assertEquals(response?.body, null);
  }));

Deno.test("a blob without a stored type is served as octet-stream", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server, dataDir }) => {
    await uploadBlob(server, "text/plain");
    // Simulate a file whose description is absent: only the bytes exist.
    const other = new TextEncoder().encode("orphan bytes");
    const orphan = sha256(other);
    await Deno.writeFile(`${dataDir}/blobs/${orphan}`, other);
    const response = await server.handle(new Request(`${BASE}/${orphan}`));
    assertEquals(response?.status, 200);
    assertEquals(
      response?.headers.get("Content-Type"),
      "application/octet-stream",
    );
    await response!.body?.cancel();
  }));

Deno.test("an unknown blob is 404 with X-Reason, for GET and HEAD", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    for (const method of ["GET", "HEAD"]) {
      const response = await server.handle(
        new Request(`${BASE}/${HASH}`, { method }),
      );
      assertEquals(response?.status, 404);
      assertEquals(response?.headers.get("X-Reason"), "unknown blob");
    }
  }));

Deno.test("a range beyond the end is not served as 206", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    await uploadBlob(server);
    const response = await server.handle(
      new Request(`${BASE}/${HASH}`, {
        headers: { Range: "bytes=900-999" },
      }),
    );
    assertNotEquals(response?.status, 206);
    await response!.body?.cancel();
  }));
