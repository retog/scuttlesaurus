/**
 * Tests of the routing, the enabled switch and the descriptor URLs of the
 * Blossom server.
 * @module
 */
import { assertEquals } from "@std/assert";
import { authorization, newSigner, sha256, withFixture } from "./fixtures.ts";

const ALICE = newSigner();
const BASE = "http://localhost";
const BYTES = new TextEncoder().encode("routing");
const HASH = sha256(BYTES);

Deno.test("non-Blossom requests, and OPTIONS, are left to the next handler", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    const requests = [
      new Request(`${BASE}/`),
      new Request(`${BASE}/api/status`),
      new Request(`${BASE}/sparql?query=ASK{}`),
      new Request(`${BASE}/upload`, { method: "POST" }),
      new Request(`${BASE}/upload`, { method: "GET" }),
      new Request(`${BASE}/list`),
      new Request(`${BASE}/list/${ALICE.pubkey}`, { method: "POST" }),
      new Request(`${BASE}/${HASH.toUpperCase()}`),
      new Request(`${BASE}/${HASH}/extra`),
      new Request(`${BASE}/${HASH}.png`, { method: "DELETE" }),
      new Request(`${BASE}/${HASH}`, { method: "POST" }),
      new Request(`${BASE}/upload`, { method: "OPTIONS" }),
      new Request(`${BASE}/${HASH}`, { method: "OPTIONS" }),
    ];
    for (const request of requests) {
      assertEquals(
        await server.handle(request),
        null,
        `${request.method} ${request.url}`,
      );
    }
  }));

Deno.test("nothing is handled while blossom is disabled, and it is read at each request", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server, config }) => {
    const upload = () =>
      server.handle(
        new Request(`${BASE}/upload`, {
          method: "PUT",
          body: BYTES,
          headers: {
            "Content-Type": "text/plain",
            Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
          },
        }),
      );

    config.blossom.enabled = false;
    assertEquals(await upload(), null);
    assertEquals(await server.handle(new Request(`${BASE}/${HASH}`)), null);

    config.blossom.enabled = true;
    const response = await upload();
    assertEquals(response?.status, 200);
    await response!.body?.cancel();
  }));

Deno.test("descriptor URLs follow the forwarding headers only when both are valid", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    const urlWith = async (forwarded: Record<string, string>) => {
      const response = await server.handle(
        new Request(`${BASE}/upload`, {
          method: "PUT",
          body: BYTES,
          headers: {
            "Content-Type": "image/png",
            Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
            ...forwarded,
          },
        }),
      );
      return (await response!.json()).url;
    };
    assertEquals(
      await urlWith({
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "saurus.example.org",
      }),
      `https://saurus.example.org/${HASH}.png`,
    );
    // A host with credentials, or only one of the two headers: the request's
    // own origin is used.
    assertEquals(
      await urlWith({
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "x@evil.example",
      }),
      `${BASE}/${HASH}.png`,
    );
    assertEquals(
      await urlWith({ "X-Forwarded-Host": "evil.example" }),
      `${BASE}/${HASH}.png`,
    );
  }));

Deno.test("descriptor URLs use publicUrl when it is set", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server, config }) => {
    config.publicUrl = "https://saurus.example.org/";
    const response = await server.handle(
      new Request(`${BASE}/upload`, {
        method: "PUT",
        body: BYTES,
        headers: {
          "Content-Type": "image/png",
          Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
        },
      }),
    );
    assertEquals(
      (await response!.json()).url,
      `https://saurus.example.org/${HASH}.png`,
    );
  }));

Deno.test("descriptor URLs honour X-Forwarded-Proto and X-Forwarded-Host", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    const response = await server.handle(
      new Request(`${BASE}/upload`, {
        method: "PUT",
        body: BYTES,
        headers: {
          "Content-Type": "image/png",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "media.example.net, proxy.internal",
          Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
        },
      }),
    );
    assertEquals(
      (await response!.json()).url,
      `https://media.example.net/${HASH}.png`,
    );
  }));

Deno.test("descriptor URLs fall back to the request origin", () =>
  withFixture({ [ALICE.pubkey]: 1 }, async ({ server }) => {
    const response = await server.handle(
      new Request(`http://node.lan:7777${"/upload"}`, {
        method: "PUT",
        body: BYTES,
        headers: {
          "Content-Type": "image/png",
          Authorization: authorization(ALICE, "upload", { hashes: [HASH] }),
        },
      }),
    );
    assertEquals(
      (await response!.json()).url,
      `http://node.lan:7777/${HASH}.png`,
    );
  }));
