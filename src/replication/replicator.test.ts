/**
 * End-to-end tests of the replicator against real in-process relays: distances, outbox, paging, live events, restarts, failures, publishing and shutdown.
 * @module
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import {
  deadRelayUrl,
  type Downstream,
  eventually,
  follows,
  held,
  people,
  secondsAgo,
  sign,
  startDownstream,
  startUpstream,
  writeRelays,
} from "./test_network.ts";
import { SYNC_STATE_FILE } from "./sync_state.ts";
import type { NostrEvent } from "../types.ts";

/** Run `body` and clean up whatever it registered, whatever happens. */
async function scenario(
  body: (cleanup: (fn: () => Promise<void>) => void) => Promise<void>,
) {
  const tasks: (() => Promise<void>)[] = [];
  try {
    await body((fn) => tasks.unshift(fn));
  } finally {
    for (const task of tasks) await task();
  }
}

const waitIdle = (node: Downstream) =>
  eventually(
    () =>
      node.replicator.status().relays.every((r) =>
        !r.backfilling && r.state === "connected"
      ) && node.replicator.status().relays.length > 0,
    "the backfill to finish",
  );

Deno.test("replicates the neighbourhood by distance, kinds and horizon", async () => {
  await scenario(async (cleanup) => {
    const [owner, a, b, c, muted] = people(5);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());

    const wanted: NostrEvent[] = [
      sign(owner, 0, { content: '{"name":"owner"}' }),
      sign(owner, 1, { content: "owner note", created_at: secondsAgo(500) }),
      sign(owner, 7, { tags: [["e", "f".repeat(64)]] }),
      sign(a, 0, { content: '{"name":"a"}' }),
      follows(a, [b]),
      sign(a, 1, { content: "a recent" }),
      sign(a, 7, { tags: [["e", "f".repeat(64)]] }),
      sign(b, 0, { content: '{"name":"b"}' }),
      follows(b, [c]),
      sign(b, 1, { content: "b recent" }),
    ];
    const unwanted: NostrEvent[] = [
      sign(a, 1, { content: "a old", created_at: secondsAgo(200) }),
      sign(b, 1, { content: "b old", created_at: secondsAgo(30) }),
      sign(b, 7, { tags: [["e", "f".repeat(64)]] }), // no reactions at distance 2
      sign(c, 0, { content: '{"name":"c"}' }),
      sign(c, 1, { content: "three hops away" }),
      sign(muted, 1, { content: "muted" }),
      sign(muted, 0, { content: '{"name":"muted"}' }),
    ];
    const ownerLists = [
      follows(owner, [a, muted]),
      sign(owner, 10000, { tags: [["p", muted.pubkey]] }),
    ];
    await upstream.add(...wanted, ...unwanted, ...ownerLists);

    const node = await startDownstream(owner, [upstream.url]);
    cleanup(() => node.close());

    await eventually(
      () => held(node.events, wanted).length === wanted.length,
      "the neighbourhood to arrive",
    );
    await waitIdle(node);
    await delay(100);
    assertEquals(held(node.events, unwanted), [], "nothing out of range");
    for (const event of ownerLists) assert(node.events.has(event.id));
    assertEquals(
      Object.fromEntries(
        [...node.graph.authors()].map(([k, v]) => [k, v]),
      ),
      { [owner.pubkey]: 0, [a.pubkey]: 1, [b.pubkey]: 2 },
    );
    assertEquals(node.replicator.status().authorsByHop, [1, 1, 1]);
  });
});

Deno.test("fetches an author from their write relay although it is not a bootstrap relay", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const bootstrap = await startUpstream();
    const outbox = await startUpstream();
    cleanup(() => bootstrap.close());
    cleanup(() => outbox.close());

    await bootstrap.add(
      follows(owner, [a]),
      sign(a, 0, { content: '{"name":"a"}' }),
      writeRelays(a, [outbox.url]),
    );
    const note = sign(a, 1, { content: "only on the outbox relay" });
    await outbox.add(note);

    const node = await startDownstream(owner, [bootstrap.url]);
    cleanup(() => node.close());

    await eventually(
      () => node.events.has(note.id),
      "the note from the outbox",
    );
    const scores = await node.events.relayScores([a.pubkey]);
    assertEquals(scores.get(a.pubkey)?.get(outbox.url), 1);
    assert(
      node.replicator.status().relays.some((r) => r.url === outbox.url),
      "status lists the outbox relay",
    );
  });
});

Deno.test("backfill pages through more events than the page size", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const notes = Array.from(
      { length: 23 },
      (_, i) =>
        sign(a, 1, {
          content: `note ${i}`,
          created_at: secondsAgo(1, i * 30),
        }),
    );
    await upstream.add(follows(owner, [a]), ...notes);

    const node = await startDownstream(owner, [upstream.url], {
      tuning: { pageSize: 5 },
    });
    cleanup(() => node.close());

    await eventually(
      () => held(node.events, notes).length === notes.length,
      "all 23 notes",
    );
    const pages = upstream.requests.filter((f) =>
      f.authors?.includes(a.pubkey) && f.kinds?.includes(1) &&
      f.until !== undefined
    );
    assert(pages.length >= 5, `paged through ${pages.length} requests`);
    assert(pages.every((f) => f.limit === 5));
  });
});

Deno.test("live: an event published upstream after the backfill arrives", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    await upstream.add(follows(owner, [a]), sign(a, 1, { content: "first" }));

    const node = await startDownstream(owner, [upstream.url]);
    cleanup(() => node.close());
    await eventually(() => node.graph.distance(a.pubkey) === 1, "the graph");
    await waitIdle(node);

    const later = sign(a, 1, { content: "published later" });
    const profile = sign(a, 0, { content: '{"name":"late"}' });
    await upstream.add(later, profile);
    await eventually(
      () => node.events.has(later.id) && node.events.has(profile.id),
      "the live events",
    );
  });
});

Deno.test("following somebody new replicates them", async () => {
  await scenario(async (cleanup) => {
    const [owner, a, d] = people(3);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const note = sign(d, 1, { content: "from the new follow" });
    await upstream.add(
      follows(owner, [a]),
      note,
      sign(d, 0, { content: "{}" }),
    );

    const node = await startDownstream(owner, [upstream.url]);
    cleanup(() => node.close());
    await eventually(() => node.graph.distance(a.pubkey) === 1, "the graph");
    await waitIdle(node);
    assertEquals(node.events.has(note.id), false);

    await upstream.add(follows(owner, [a, d], secondsAgo(0) + 5));
    await eventually(() => node.events.has(note.id), "the new follow's note");
    assertEquals(node.graph.distance(d.pubkey), 1);
  });
});

Deno.test("a new follow does not make covered authors be backfilled again", async () => {
  await scenario(async (cleanup) => {
    const [owner, a, d] = people(3);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const noteA = sign(a, 1, { content: "a" });
    await upstream.add(follows(owner, [a]), noteA);
    const node = await startDownstream(owner, [upstream.url]);
    cleanup(() => node.close());
    await eventually(() => node.events.has(noteA.id), "a's note");
    await waitIdle(node);

    const before = upstream.requests.filter((f) =>
      f.authors?.includes(a.pubkey) && f.kinds?.includes(1) &&
      f.until !== undefined
    ).length;
    await upstream.add(follows(owner, [a, d], secondsAgo(0) + 5));
    await eventually(() =>
      node.graph.distance(d.pubkey) === 1, "d in range");
    await waitIdle(node);
    const after = upstream.requests.filter((f) =>
      f.authors?.includes(a.pubkey) && f.kinds?.includes(1) &&
      f.until !== undefined
    ).length;
    assertEquals(after, before, "a, already covered, was not backfilled again");
  });
});

Deno.test("a restart fetches only the gap since the last run", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const old = sign(a, 1, { content: "old", created_at: secondsAgo(2) });
    await upstream.add(follows(owner, [a]), old, sign(a, 0, { content: "{}" }));

    const node = await startDownstream(owner, [upstream.url]);
    cleanup(() => node.close());
    await eventually(() => node.events.has(old.id), "the first run");
    await waitIdle(node);

    const stoppedAt = Math.floor(Date.now() / 1000);
    await node.replicator.stop();
    assertEquals(node.replicator.status().running, false);
    const saved = JSON.parse(
      await Deno.readTextFile(`${node.dataDir}/${SYNC_STATE_FILE}`),
    );
    assertEquals(saved.version, 1);
    assert(
      saved.relays[upstream.url][a.pubkey][1] >= stoppedAt,
      "coverage reaches the stop",
    );

    const fresh = sign(a, 1, { content: "while we were away" });
    await upstream.add(fresh);
    const mark = upstream.requests.length;

    node.replicator.start();
    await eventually(() => node.events.has(fresh.id), "the new event");
    await waitIdle(node);

    const asked = upstream.requests.slice(mark);
    assert(asked.length > 0);
    for (const filter of asked) {
      if (filter.kinds !== undefined && !filter.kinds.includes(1)) continue; // current versions
      assert(
        filter.since !== undefined && filter.since >= stoppedAt,
        `a request for regular events asked from ${filter.since}, not from the end of the covered range ${stoppedAt}: ${
          JSON.stringify(filter)
        }`,
      );
    }
  });
});

Deno.test("a damaged state file starts over instead of crashing", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const note = sign(a, 1, { content: "n" });
    await upstream.add(follows(owner, [a]), note);
    const dataDir = await Deno.makeTempDir();
    await Deno.writeTextFile(`${dataDir}/${SYNC_STATE_FILE}`, "{{{ not json");
    const node = await startDownstream(owner, [upstream.url], { dataDir });
    cleanup(() => node.close());
    await eventually(() => node.events.has(note.id), "the note");
  });
});

Deno.test("a grown horizon backfills the missing range", async () => {
  await scenario(async (cleanup) => {
    const [owner, a, b] = people(3);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const recent = sign(b, 1, { content: "recent" });
    const older = sign(b, 1, {
      content: "30 days",
      created_at: secondsAgo(30),
    });
    await upstream.add(follows(owner, [a]), follows(a, [b]), recent, older);

    const node = await startDownstream(owner, [upstream.url]);
    cleanup(() => node.close());
    await eventually(() => node.events.has(recent.id), "the recent note");
    await waitIdle(node);
    assertEquals(node.events.has(older.id), false);

    await node.replicator.stop();
    node.config.replication.horizonDays = [0, 90, 60];
    node.replicator.start();
    await eventually(() => node.events.has(older.id), "the older note");
  });
});

Deno.test("a dead bootstrap relay does not stop replication and shows in the status", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const dead = await deadRelayUrl();
    const note = sign(a, 1, { content: "via the live relay" });
    await upstream.add(follows(owner, [a]), note);

    const node = await startDownstream(owner, [dead, upstream.url]);
    cleanup(() => node.close());
    await eventually(() => node.events.has(note.id), "the note");
    await eventually(
      () =>
        node.replicator.status().relays.some((r) =>
          r.url === dead && r.lastError !== undefined && r.state !== "connected"
        ),
      "the failure in the status",
    );
    const live = node.replicator.status().relays.find((r) =>
      r.url === upstream.url
    );
    assertEquals(live?.state, "connected");
    assert((live?.eventsReceived ?? 0) >= 2);
  });
});

Deno.test("a relay that keeps failing is left out of the plan and tried again later", async () => {
  await scenario(async (cleanup) => {
    const [owner] = people(1);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const dead = await deadRelayUrl();
    const node = await startDownstream(owner, [dead, upstream.url]);
    cleanup(() => node.close());

    await eventually(
      () =>
        node.replicator.status().relays.some((r) =>
          r.url === dead && r.state === "closed"
        ),
      "the dead relay to be given up on",
    );
    // After the exclusion expires it is part of the plan again and retried.
    await eventually(
      () =>
        node.replicator.status().relays.some((r) =>
          r.url === dead && r.state !== "closed"
        ),
      "the dead relay to be retried",
    );
  });
});

Deno.test("events already in the store are not received again", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const note = sign(a, 1, { content: "known" });
    const list = follows(owner, [a]);
    await upstream.add(list, note);

    const node = await startDownstream(owner, [upstream.url], { start: false });
    cleanup(() => node.close());
    await node.events.add(note);
    node.replicator.start();
    await eventually(() => node.graph.distance(a.pubkey) === 1, "the graph");
    await waitIdle(node);
    // Only the follow list was new; the note is not counted.
    assertEquals(node.replicator.status().relays[0].eventsReceived, 1);
    assertEquals(node.events.has(list.id), true);
  });
});

Deno.test("events with a bad signature are not stored", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    // A relay that serves a forged event: wrap a real relay's store.
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const good = sign(a, 1, { content: "good" });
    await upstream.add(follows(owner, [a]), good);
    const forged: NostrEvent = {
      ...sign(a, 1, { content: "forged" }),
      content: "tampered",
    };
    // The relay's store would refuse it, so serve it through a raw server.
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen() {} },
      (request) => {
        const { socket, response } = Deno.upgradeWebSocket(request);
        socket.onmessage = (message) => {
          const frame = JSON.parse(message.data);
          if (frame[0] !== "REQ") return;
          socket.send(JSON.stringify(["EVENT", frame[1], forged]));
          socket.send(JSON.stringify(["EOSE", frame[1]]));
        };
        return response;
      },
    );
    cleanup(() => server.shutdown());
    const url = `ws://127.0.0.1:${server.addr.port}/`;

    const node = await startDownstream(owner, [url, upstream.url]);
    cleanup(() => node.close());
    await eventually(() => node.events.has(good.id), "the good note");
    await waitIdle(node);
    assertEquals(node.events.has(forged.id), false);
  });
});

Deno.test("publish goes to the author's write relays, or to the bootstrap relays", async () => {
  await scenario(async (cleanup) => {
    const [owner, withList, withoutList] = people(3);
    const outbox = await startUpstream([withList]);
    const bootstrap = await startUpstream([withoutList]);
    cleanup(() => outbox.close());
    cleanup(() => bootstrap.close());
    const dead = await deadRelayUrl();

    const node = await startDownstream(owner, [bootstrap.url, dead], {
      start: false,
    });
    cleanup(() => node.close());
    await node.events.add(writeRelays(withList, [outbox.url, dead]));

    // Not started: every relay is connected to just for the event.
    const note = sign(withList, 1, { content: "to the outbox" });
    const results = await node.replicator.publish(note);
    assertEquals(results.map((r) => r.relay).sort(), [dead, outbox.url].sort());
    assertEquals(results.find((r) => r.relay === outbox.url)?.ok, true);
    const failure = results.find((r) => r.relay === dead);
    assertEquals(failure?.ok, false);
    assert(failure?.message);
    assert(outbox.store.has(note.id));
    assertEquals(bootstrap.store.has(note.id), false);

    const other = sign(withoutList, 1, { content: "to the bootstrap relays" });
    const fallback = await node.replicator.publish(other);
    assertEquals(
      fallback.map((r) => r.relay).sort(),
      [bootstrap.url, dead].sort(),
    );
    assertEquals(fallback.find((r) => r.relay === bootstrap.url)?.ok, true);
    assert(bootstrap.store.has(other.id));

    // A relay's refusal is reported with its message.
    const stranger = people(1)[0];
    const refused = await node.replicator.publish(sign(stranger, 1, {}));
    const verdict = refused.find((r) => r.relay === bootstrap.url);
    assertEquals(verdict?.ok, false);
    assert(verdict?.message?.startsWith("blocked"), verdict?.message);

    // Started: the open connection to a bootstrap relay is reused.
    node.replicator.start();
    await eventually(
      () =>
        node.replicator.status().relays.some((r) =>
          r.url === bootstrap.url && r.state === "connected"
        ),
      "the connection",
    );
    const again = sign(withoutList, 1, { content: "over the open connection" });
    const reused = await node.replicator.publish(again);
    assertEquals(reused.find((r) => r.relay === bootstrap.url)?.ok, true);
    assert(bootstrap.store.has(again.id));
  });
});

Deno.test("publish returns nothing while replication is disabled", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream([a]);
    cleanup(() => upstream.close());
    const node = await startDownstream(owner, [upstream.url], {
      replication: { enabled: false },
    });
    cleanup(() => node.close());
    assertEquals(await node.replicator.publish(sign(a, 1, {})), []);
    node.replicator.start();
    assertEquals(node.replicator.status().running, false);
    assertEquals(node.replicator.status().enabled, false);
    assertEquals(upstream.requests.length, 0);
  });
});

Deno.test("start waits for an owner and works after stop and start", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const note = sign(a, 1, { content: "n" });
    await upstream.add(follows(owner, [a]), note);

    const node = await startDownstream(undefined, [upstream.url]);
    cleanup(() => node.close());
    assertEquals(node.replicator.status().running, false);
    assertEquals(upstream.requests.length, 0);

    node.config.owner = owner.pubkey;
    await node.replicator.stop();
    node.replicator.start();
    node.replicator.start(); // idempotent
    assertEquals(node.replicator.status().running, true);
    await eventually(() => node.events.has(note.id), "the note");
  });
});

Deno.test("stop is safe at any moment and leaves nothing running", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    await upstream.add(follows(owner, [a]), sign(a, 1, {}));
    const node = await startDownstream(owner, [
      upstream.url,
      await deadRelayUrl(),
    ], {
      start: false,
    });
    cleanup(() => node.close());

    // Immediately, while connecting, and mid-flight, repeatedly.
    for (const wait of [0, 0, 5, 30, 80]) {
      node.replicator.start();
      await delay(wait);
      const stopping = node.replicator.stop();
      await node.replicator.stop();
      await stopping;
      assertEquals(node.replicator.status().running, false);
      assertEquals(node.replicator.status().relays, []);
    }
    node.replicator.start();
    await eventually(() => node.graph.distance(a.pubkey) === 1, "a full run");
  });
});

Deno.test("a relay that closes the subscription is retried and reported", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    const note = sign(a, 1, { content: "after the refusal" });
    await upstream.add(follows(owner, [a]), note);
    let refusals = 2;
    // A relay that refuses the first requests with CLOSED, then proxies the real one.
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen() {} },
      (request) => {
        const { socket, response } = Deno.upgradeWebSocket(request);
        const upstreamSocket = new WebSocket(upstream.url);
        const pending: string[] = [];
        upstreamSocket.onopen = () =>
          pending.splice(0).forEach((m) => upstreamSocket.send(m));
        upstreamSocket.onmessage = (m) => socket.send(m.data);
        upstreamSocket.onclose = () => socket.close();
        socket.onclose = () => upstreamSocket.close();
        socket.onmessage = (message) => {
          const frame = JSON.parse(message.data);
          if (frame[0] === "REQ" && refusals > 0) {
            refusals--;
            socket.send(
              JSON.stringify(["CLOSED", frame[1], "rate-limited: slow down"]),
            );
            return;
          }
          if (upstreamSocket.readyState === WebSocket.OPEN) {
            upstreamSocket.send(message.data);
          } else pending.push(message.data);
        };
        return response;
      },
    );
    cleanup(() => server.shutdown());
    const url = `ws://127.0.0.1:${server.addr.port}/`;
    const node = await startDownstream(owner, [url]);
    cleanup(() => node.close());
    await eventually(
      () => node.events.has(note.id),
      "the note despite refusals",
    );
    assertNotEquals(node.replicator.status().relays[0]?.lastError, undefined);
  });
});

Deno.test("relay lists cannot point the node at private or plain ws relays by default", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const bootstrap = await startUpstream();
    const private_ = await startUpstream();
    cleanup(() => bootstrap.close());
    cleanup(() => private_.close());
    const onBootstrap = sign(a, 1, { content: "on the bootstrap relay" });
    const onPrivate = sign(a, 1, { content: "on the private relay" });
    await bootstrap.add(
      follows(owner, [a]),
      writeRelays(a, [private_.url, "ws://example.com/"]),
      onBootstrap,
    );
    await private_.add(onPrivate);

    // The bootstrap relay itself is on localhost and keeps working.
    const node = await startDownstream(owner, [bootstrap.url], {
      replication: { allowPrivateRelays: false },
    });
    cleanup(() => node.close());
    await eventually(
      () => node.events.has(onBootstrap.id),
      "the fallback fetch",
    );
    await waitIdle(node);
    await delay(150);
    assertEquals(node.events.has(onPrivate.id), false);
    assertEquals(private_.accepted, 0, "no connection to the private relay");
    assertEquals(
      node.replicator.status().relays.map((r) => r.url),
      [bootstrap.url],
    );
  });
});

Deno.test("publish ignores private relays of a relay list by default", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const bootstrap = await startUpstream([a]);
    const private_ = await startUpstream([a]);
    cleanup(() => bootstrap.close());
    cleanup(() => private_.close());
    const node = await startDownstream(owner, [bootstrap.url], {
      start: false,
      replication: { allowPrivateRelays: false },
    });
    cleanup(() => node.close());
    await node.events.add(writeRelays(a, [private_.url]));
    const note = sign(a, 1, {});
    const results = await node.replicator.publish(note);
    assertEquals(results.map((r) => r.relay), [bootstrap.url]);
    assertEquals(private_.accepted, 0);

    node.config.replication.allowPrivateRelays = true;
    const again = await node.replicator.publish(sign(a, 1, { content: "2" }));
    assertEquals(again.map((r) => r.relay), [private_.url]);
  });
});

Deno.test("a relay that goes silent is probed, dropped and reconnected", async () => {
  await scenario(async (cleanup) => {
    const [owner] = people(1);
    let connections = 0;
    const sockets: WebSocket[] = [];
    // Accepts the WebSocket and never answers anything.
    const silent = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen() {} },
      (request) => {
        connections++;
        const { socket, response } = Deno.upgradeWebSocket(request);
        sockets.push(socket);
        return response;
      },
    );
    cleanup(() => silent.shutdown());
    const url = `ws://127.0.0.1:${silent.addr.port}/`;
    const node = await startDownstream(owner, [url], {
      tuning: { idleProbeMs: 30, probeTimeoutMs: 30, maxFailures: 100 },
    });
    cleanup(() => node.close());
    await eventually(() => connections >= 3, "reconnects after dropped probes");
    const status = node.replicator.status().relays[0];
    assert(status.lastError?.includes("probe"), status.lastError);
  });
});

Deno.test("a healthy idle relay answers the probe and is left alone", async () => {
  await scenario(async (cleanup) => {
    const [owner, a] = people(2);
    const upstream = await startUpstream();
    cleanup(() => upstream.close());
    await upstream.add(follows(owner, [a]));
    const node = await startDownstream(owner, [upstream.url], {
      tuning: { idleProbeMs: 40, probeTimeoutMs: 500 },
    });
    cleanup(() => node.close());
    await eventually(() => node.graph.distance(a.pubkey) === 1, "the graph");
    await waitIdle(node);
    const probes = () =>
      upstream.requests.filter((f) => f.ids?.[0] === "0".repeat(64)).length;
    await eventually(() => probes() >= 3, "several probes");
    assertEquals(upstream.accepted, 1, "never reconnected");
    assertEquals(node.replicator.status().relays[0].lastError, undefined);

    const later = sign(a, 1, { content: "after the probes" });
    await upstream.add(later);
    await eventually(() => node.events.has(later.id), "live event");
  });
});
