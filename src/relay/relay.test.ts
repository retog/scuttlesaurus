/**
 * End-to-end tests of the relay over real WebSocket connections on localhost.
 * @module
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { delay } from "@std/async";
import denoJson from "../../deno.json" with { type: "json" };
import type { NostrEvent } from "../types.ts";
import { MAX_MESSAGE_BYTES } from "./protocol.ts";
import { signedEvent, withRelay } from "./test_helpers.ts";

const NOW = () => Math.floor(Date.now() / 1000);

/** Waits until `condition` holds, polling briefly. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) await delay(10);
  assert(condition(), "condition not reached in time");
}

/** The event carried by an EVENT message. */
const eventOf = (message: unknown[]) => message[2] as NostrEvent;

Deno.test("REQ sends stored events newest first, then EOSE", () =>
  withRelay(async ({ store, friend, connect }) => {
    const older = signedEvent(friend, { createdAt: NOW() - 100 });
    const newer = signedEvent(friend, { createdAt: NOW() - 10 });
    await store.add(older);
    await store.add(newer);

    const client = await connect();
    client.send(["REQ", "sub", { kinds: [1] }]);
    const messages = await client.until("EOSE");

    assertEquals(messages.map((m) => m[0]), ["EVENT", "EVENT", "EOSE"]);
    assertEquals(messages[0][1], "sub");
    assertEquals(eventOf(messages[0]).id, newer.id);
    assertEquals(eventOf(messages[1]).id, older.id);
    assertEquals(messages[2], ["EOSE", "sub"]);
  }));

Deno.test("live events reach matching subscriptions and not others", () =>
  withRelay(async ({ friend, store, connect }) => {
    const client = await connect();
    client.send(["REQ", "notes", { kinds: [1], authors: [friend.pubkey] }]);
    await client.until("EOSE");
    client.send(["REQ", "reactions", { kinds: [7] }]);
    await client.until("EOSE");

    // A client publishes a note: delivered to "notes", then OK.
    const note = signedEvent(friend, { content: "live" });
    client.send(["EVENT", note]);
    const delivered = await client.next();
    assertEquals(delivered[0], "EVENT");
    assertEquals(delivered[1], "notes");
    assertEquals(eventOf(delivered).id, note.id);
    assertEquals(await client.next(), ["OK", note.id, true, ""]);

    // A reaction arrives from the replicator (not from a client). It matches
    // "reactions" only; the COUNT barrier shows nothing else was sent.
    const reaction = signedEvent(friend, { kind: 7, content: "+" });
    await store.add(reaction);
    client.send(["COUNT", "barrier", { kinds: [1] }]);
    const messages = await client.until("COUNT");
    assertEquals(messages.length, 2);
    assertEquals(messages[0][1], "reactions");
    assertEquals(eventOf(messages[0]).id, reaction.id);
  }));

Deno.test("an event arriving during the stored query is sent exactly once", async () => {
  for (const snapshot of [false, true]) {
    await withRelay(async ({ friend, store, connect }) => {
      const earlier = signedEvent(friend, { createdAt: NOW() - 50 });
      await store.add(earlier);
      const hold = store.holdNextQuery({ snapshot });

      const client = await connect();
      client.send(["REQ", "race", { kinds: [1] }]);
      await hold.started;
      // Buffered by the subscription. Whether the stored query also sees it
      // depends on `snapshot`; either way it must arrive once.
      const during = signedEvent(friend, { content: "during" });
      await store.add(during);
      hold.release();

      const messages = await client.until("EOSE");
      const ids = messages.filter((m) => m[0] === "EVENT").map((m) =>
        eventOf(m).id
      );
      assertEquals(ids.length, 2, `snapshot=${snapshot}`);
      assertEquals(new Set(ids), new Set([earlier.id, during.id]));
      assertEquals(messages.at(-1), ["EOSE", "race"]);

      // Still live afterwards, and only once.
      const after = signedEvent(friend, { content: "after" });
      await store.add(after);
      assertEquals(eventOf(await client.next()).id, after.id);
      client.send(["COUNT", "barrier", { kinds: [1] }]);
      assertEquals((await client.next())[0], "COUNT");
    });
  }
});

Deno.test("EVENT answers accepted, blocked, forged and duplicate events", () =>
  withRelay(async ({ friend, outsider, connect, accepted }) => {
    const client = await connect();

    const good = signedEvent(friend);
    client.send(["EVENT", good]);
    assertEquals(await client.next(), ["OK", good.id, true, ""]);

    client.send(["EVENT", good]);
    assertEquals(await client.next(), [
      "OK",
      good.id,
      true,
      "duplicate: already have this event",
    ]);

    const stranger = signedEvent(outsider);
    client.send(["EVENT", stranger]);
    assertEquals(await client.next(), [
      "OK",
      stranger.id,
      false,
      "blocked: author is not within 2 hops of this relay's owner",
    ]);

    const forged = signedEvent(friend, { content: "original" });
    client.send(["EVENT", { ...forged, sig: "00".repeat(64) }]);
    const reply = await client.next();
    assertEquals(reply.slice(0, 3), ["OK", forged.id, false]);
    assert(String(reply[3]).startsWith("invalid: "));

    assertEquals(accepted.map((event) => event.id), [good.id]);
  }));

Deno.test("EVENT is blocked while the relay has no owner", () =>
  withRelay(async ({ friend, connect, accepted }) => {
    const client = await connect();
    const event = signedEvent(friend);
    client.send(["EVENT", event]);
    assertEquals(await client.next(), [
      "OK",
      event.id,
      false,
      "blocked: this relay has no owner yet",
    ]);
    assertEquals(accepted, []);
  }, { owner: false }));

Deno.test("store rejections are reported with an invalid: prefix", () =>
  withRelay(async ({ friend, store, connect }) => {
    const client = await connect();
    store.nextRejection = "event is retracted";
    const event = signedEvent(friend);
    client.send(["EVENT", event]);
    assertEquals(await client.next(), [
      "OK",
      event.id,
      false,
      "invalid: event is retracted",
    ]);
  }));

Deno.test("EVENT without a usable id gets a NOTICE", () =>
  withRelay(async ({ connect }) => {
    const client = await connect();
    client.send(["EVENT", { kind: 1 }]);
    assertEquals((await client.next())[0], "NOTICE");
  }));

Deno.test("onAccepted is called for stored and ephemeral client events only", () =>
  withRelay(async ({ friend, store, connect, accepted }) => {
    const client = await connect();
    const ephemeral = signedEvent(friend, { kind: 20001 });
    client.send(["EVENT", ephemeral]);
    assertEquals(await client.next(), ["OK", ephemeral.id, true, ""]);
    assertEquals(accepted.map((e) => e.id), [ephemeral.id]);

    // An event that reaches the store by another route is not "accepted from
    // a client".
    await store.add(signedEvent(friend));
    assertEquals(accepted.length, 1);
  }));

Deno.test("a throwing onAccepted does not affect the client", async () => {
  const log = console.error;
  console.error = () => {};
  try {
    await withRelay(async ({ friend, connect }) => {
      const client = await connect();
      const event = signedEvent(friend);
      client.send(["EVENT", event]);
      assertEquals(await client.next(), ["OK", event.id, true, ""]);
    }, {
      onAccepted: () => {
        throw new Error("boom");
      },
    });
  } finally {
    console.error = log;
  }
});

Deno.test("ephemeral events are relayed to subscribers but not stored", () =>
  withRelay(async ({ friend, store, connect }) => {
    const client = await connect();
    client.send(["REQ", "eph", { kinds: [20001] }]);
    await client.until("EOSE");

    const ephemeral = signedEvent(friend, { kind: 20001 });
    client.send(["EVENT", ephemeral]);
    const delivered = await client.next();
    assertEquals(delivered[0], "EVENT");
    assertEquals(delivered[1], "eph");
    assertEquals(eventOf(delivered).id, ephemeral.id);
    assertEquals(await client.next(), ["OK", ephemeral.id, true, ""]);
    assertFalse(store.has(ephemeral.id));
  }));

Deno.test("CLOSE stops live delivery and gets no reply", () =>
  withRelay(async ({ friend, store, connect }) => {
    const client = await connect();
    client.send(["REQ", "s", { kinds: [1] }]);
    await client.until("EOSE");
    client.send(["CLOSE", "s"]);
    // Round trip first, so the server has read the CLOSE before the event.
    client.send(["COUNT", "sync", { kinds: [1] }]);
    await client.until("COUNT");
    await store.add(signedEvent(friend));

    client.send(["COUNT", "barrier", { kinds: [1] }]);
    const messages = await client.until("COUNT");
    assertEquals(messages.map((m) => m[0]), ["COUNT"]);
  }));

Deno.test("a REQ with an existing id replaces that subscription", () =>
  withRelay(async ({ friend, store, connect }) => {
    await store.add(signedEvent(friend, { kind: 1 }));
    const reaction = signedEvent(friend, { kind: 7 });
    await store.add(reaction);

    const client = await connect();
    client.send(["REQ", "r", { kinds: [1] }]);
    assertEquals((await client.until("EOSE")).length, 2);

    client.send(["REQ", "r", { kinds: [7] }]);
    const replaced = await client.until("EOSE");
    assertEquals(replaced.map((m) => m[0]), ["EVENT", "EOSE"]);
    assertEquals(eventOf(replaced[0]).id, reaction.id);

    // Live delivery follows the new filter only.
    await store.add(signedEvent(friend, { kind: 1 }));
    const live = signedEvent(friend, { kind: 7, content: "new" });
    await store.add(live);
    client.send(["COUNT", "barrier", { kinds: [1] }]);
    const messages = await client.until("COUNT");
    assertEquals(messages.map((m) => m[0]), ["EVENT", "COUNT"]);
    assertEquals(eventOf(messages[0]).id, live.id);
  }));

Deno.test("the 21st open subscription is refused", () =>
  withRelay(async ({ connect }) => {
    const client = await connect();
    for (let i = 0; i < 20; i++) {
      client.send(["REQ", `s${i}`, { kinds: [1] }]);
      await client.until("EOSE");
    }
    client.send(["REQ", "s20", { kinds: [1] }]);
    assertEquals(await client.next(), [
      "CLOSED",
      "s20",
      "rate-limited: too many subscriptions",
    ]);

    // Replacing an open subscription is not a new one.
    client.send(["REQ", "s0", { kinds: [1] }]);
    assertEquals((await client.until("EOSE")).at(-1), ["EOSE", "s0"]);
  }));

Deno.test("REQ with too many or no filters, or a non-object filter, is CLOSED", () =>
  withRelay(async ({ connect }) => {
    const client = await connect();
    const filters = Array.from({ length: 11 }, () => ({ kinds: [1] }));

    client.send(["REQ", "many", ...filters]);
    assertEquals(await client.next(), [
      "CLOSED",
      "many",
      "invalid: at most 10 filters are allowed",
    ]);

    client.send(["REQ", "none"]);
    assertEquals(await client.next(), [
      "CLOSED",
      "none",
      "invalid: at least one filter is required",
    ]);

    client.send(["REQ", "shape", [1]]);
    assertEquals(await client.next(), [
      "CLOSED",
      "shape",
      "invalid: each filter must be a JSON object",
    ]);
  }));

Deno.test("subscription ids must be 1 to 64 characters", () =>
  withRelay(async ({ connect }) => {
    const client = await connect();

    client.send(["REQ", "", { kinds: [1] }]);
    assertEquals((await client.next())[0], "NOTICE");
    client.send(["REQ", "x".repeat(65), { kinds: [1] }]);
    assertEquals((await client.next())[0], "NOTICE");

    client.send(["REQ", "x".repeat(64), { kinds: [1] }]);
    assertEquals((await client.until("EOSE")).at(-1), ["EOSE", "x".repeat(64)]);
  }));

Deno.test("malformed frames get a NOTICE and the connection stays usable", () =>
  withRelay(async ({ connect }) => {
    const client = await connect();
    const malformed: Array<string | Uint8Array> = [
      "not json",
      '{"kind":1}',
      '["FOO","x"]',
      new Uint8Array([1, 2, 3]),
      `["EVENT","${"a".repeat(MAX_MESSAGE_BYTES)}"]`,
    ];
    for (const frame of malformed) {
      client.send(frame);
      assertEquals((await client.next())[0], "NOTICE");
    }

    client.send(["COUNT", "still-here", { kinds: [1] }]);
    assertEquals(await client.next(), [
      "COUNT",
      "still-here",
      { count: 0 },
    ]);
  }));

Deno.test("COUNT (NIP-45) counts matching events ignoring limit", () =>
  withRelay(async ({ friend, store, connect }) => {
    for (let i = 0; i < 3; i++) await store.add(signedEvent(friend));
    await store.add(signedEvent(friend, { kind: 7 }));

    const client = await connect();
    client.send(["COUNT", "c", { kinds: [1], limit: 1 }]);
    assertEquals(await client.next(), ["COUNT", "c", { count: 3 }]);

    client.send(["COUNT", "bad"]);
    assertEquals((await client.next()).slice(0, 2), ["CLOSED", "bad"]);
  }));

Deno.test("limits are clamped to maxLimit before querying the store", () =>
  withRelay(async ({ store, connect }) => {
    const client = await connect();
    client.send(["REQ", "big", { kinds: [1], limit: 100000 }]);
    await client.until("EOSE");
    assertEquals(store.queries.at(-1)?.[0].limit, 20);

    client.send(["REQ", "none", { kinds: [1] }]);
    await client.until("EOSE");
    assertEquals(store.queries.at(-1)?.[0].limit, undefined);
  }, { configOverrides: { maxLimit: 20 } }));

Deno.test("a failing store query closes the subscription with CLOSED", () =>
  withRelay(async ({ store, connect }) => {
    store.nextQueryError = "disk on fire";
    const client = await connect();
    client.send(["REQ", "broken", { kinds: [1] }]);
    assertEquals(await client.next(), [
      "CLOSED",
      "broken",
      "error: disk on fire",
    ]);
  }));

Deno.test("connections() counts open sockets", () =>
  withRelay(async ({ relay, connect }) => {
    assertEquals(relay.connections(), 0);
    const first = await connect();
    await connect();
    assertEquals(relay.connections(), 2);
    await first.close();
    await waitFor(() => relay.connections() === 1);
  }));

Deno.test("close() closes every socket and removes the store listener", () =>
  withRelay(async ({ relay, store, connect }) => {
    assertEquals(store.listenerCount, 1);
    const client = await connect();
    relay.close();
    await client.closed();
    assertEquals(relay.connections(), 0);
    assertEquals(store.listenerCount, 0);
  }));

Deno.test("NIP-11 information document", () =>
  withRelay(async ({ relay, owner, config }) => {
    const response = relay.info(
      new Request("http://127.0.0.1/", {
        headers: { Accept: "application/nostr+json" },
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "application/nostr+json",
    );
    assertEquals(response.headers.get("access-control-allow-origin"), "*");

    const document = await response.json();
    assertEquals(document.name, config.name);
    assertEquals(document.description, config.description);
    assertEquals(document.pubkey, owner.pubkey);
    assertEquals(document.software, "https://github.com/retog/scuttlesaurus");
    assertEquals(document.version, denoJson.version);
    assertEquals(document.supported_nips, [
      1,
      2,
      9,
      10,
      11,
      18,
      22,
      23,
      25,
      45,
      50,
      65,
    ]);
    assertEquals(document.limitation, {
      max_subscriptions: 20,
      max_filters: 10,
      max_limit: 500,
      max_subid_length: 64,
      max_message_length: MAX_MESSAGE_BYTES,
      auth_required: false,
      payment_required: false,
      restricted_writes: true,
    });

    // Read at call time: a renamed relay shows the new name.
    config.name = "Renamed";
    const renamed = await relay.info(new Request("http://127.0.0.1/")).json();
    assertEquals(renamed.name, "Renamed");
  }));

Deno.test("NIP-11 document omits pubkey while there is no owner", () =>
  withRelay(async ({ relay }) => {
    const document = await relay.info(new Request("http://127.0.0.1/")).json();
    assertFalse("pubkey" in document);
  }, { owner: false }));

Deno.test("handleUpgrade answers a request that is not a WebSocket upgrade with 400", () =>
  withRelay(async ({ relay }) => {
    const response = relay.handleUpgrade(new Request("http://127.0.0.1/"));
    assertEquals(response.status, 400);
    await response.text();
  }));
