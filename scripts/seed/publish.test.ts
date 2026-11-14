/**
 * Tests of the publisher against an in-process node assembled from the real
 * store, relay and Blossom server. The social graph is a test double that
 * answers the node API with the distances it is told to; the seed itself
 * reaches the node only through its public interfaces.
 * @module
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createBlossomServer } from "../../src/blossom/mod.ts";
import { createRelayServer } from "../../src/relay/mod.ts";
import { openEventStore } from "../../src/store/mod.ts";
import { MemoryTripleStore, testConfig } from "../../src/testing/mod.ts";
import type { Config, EventStore, SocialGraph } from "../../src/types.ts";
import { NodeUnreachableError } from "./client.ts";
import { distancesFrom } from "./graph.ts";
import { personaKey } from "./keys.ts";
import type { Tier, World } from "./model.ts";
import { formatSummary, seedNode, type SeedReport } from "./publish.ts";
import { buildWorld } from "./world.ts";

const NOW = 1_794_528_000;
const quiet = { log: () => {}, graphDeadlineMs: 2_000 };

/** The graph the node uses: distances that the test sets. */
class TestGraph implements SocialGraph {
  readonly #distances = new Map<string, number>();

  distance(pubkey: string): number | undefined {
    return this.#distances.get(pubkey);
  }

  authors(): ReadonlyMap<string, number> {
    return this.#distances;
  }

  recompute(): Promise<void> {
    return Promise.resolve();
  }

  onChange(): () => void {
    return () => {};
  }

  close(): void {}

  replace(distances: ReadonlyMap<string, number>): void {
    this.#distances.clear();
    for (const [pubkey, hop] of distances) this.#distances.set(pubkey, hop);
  }

  /** The distances, keyed by pubkey, for the API. */
  entries(): Record<string, number> {
    return Object.fromEntries(this.#distances);
  }
}

/**
 * Who the node has in range once the owner is set: `everyone` puts all the
 * personas in range (the muted person and the hub at distance 3), `two-hops`
 * only the friends and friends of friends.
 */
type Plan = "everyone" | "two-hops";

interface TestNode {
  readonly url: string;
  readonly dataDir: string;
  readonly config: Config;
  readonly events: EventStore;
  readonly graph: TestGraph;
  close(): Promise<void>;
}

/** Starts a node on a random local port with an empty store. */
async function startNode(
  world: World,
  plan: Plan,
  presetOwner?: string,
): Promise<TestNode> {
  const dataDir = await Deno.makeTempDir();
  const hops = plan === "everyone" ? 3 : 2;
  const defaults = testConfig();
  const config = testConfig({
    dataDir,
    owner: presetOwner,
    replication: { ...defaults.replication, hops },
  });
  const triples = new MemoryTripleStore();
  const events = await openEventStore(triples, config);
  const graph = new TestGraph();
  const relay = createRelayServer({ events, graph, config });
  const blossom = createBlossomServer({ triples, graph, config });
  const statusDocument = () => ({
    owner: config.owner ?? null,
    setupRequired: config.owner === undefined,
    hops: config.replication.hops,
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      if (request.headers.get("upgrade") === "websocket") {
        return relay.handleUpgrade(request);
      }
      if (url.pathname === "/api/status") return json(statusDocument());
      if (url.pathname === "/api/graph") {
        return json({
          owner: config.owner ?? null,
          hops,
          distances: graph.entries(),
        });
      }
      if (url.pathname === "/api/setup" && request.method === "POST") {
        if (config.owner !== undefined) return json({}, 409);
        const body = await request.json() as { owner: string };
        config.owner = body.owner;
        graph.replace(ownerDistances(world, body.owner, plan));
        return json(statusDocument());
      }
      const answer = await blossom.handle(request);
      return answer ?? new Response("not found", { status: 404 });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    dataDir,
    config,
    events,
    graph,
    async close() {
      relay.close();
      await server.shutdown();
      await events.close();
      await Deno.remove(dataDir, { recursive: true });
    },
  };
}

/** The distances the node would have, keyed by pubkey, for a plan. */
function ownerDistances(
  world: World,
  owner: string,
  plan: Plan,
): Map<string, number> {
  const handleOf = new Map(
    world.personas.map((p) => [personaKey(p.handle).pubkey, p.handle]),
  );
  const handles = new Map<string, string>(
    [...handleOf].map(([pubkey, handle]) => [handle, pubkey]),
  );
  const ownerHandle = handleOf.get(owner) ?? owner;
  const distances = distancesFrom(ownerHandle, world.follows, world.mutes);
  const out = new Map<string, number>();
  for (const persona of world.personas) {
    const hop = distances.get(persona.handle);
    const pubkey = handles.get(persona.handle);
    if (pubkey === undefined) continue;
    if (hop !== undefined && (plan === "everyone" || hop <= 2)) {
      out.set(pubkey, hop);
    } else if (plan === "everyone") {
      out.set(pubkey, 3);
    }
  }
  return out;
}

function tierOf(world: World): Map<string, Tier> {
  return new Map(world.personas.map((p) => [p.handle, p.tier]));
}

async function run(
  node: TestNode,
  world: World,
  extra: { owner?: string } = {},
): Promise<SeedReport> {
  return await seedNode(
    { url: node.url, owner: extra.owner ?? "mara", quiet: true },
    { world, ...quiet },
  );
}

Deno.test("with everyone in range, everything is accepted and every blob is stored", async () => {
  const world = buildWorld({ now: NOW });
  const node = await startNode(world, "everyone");
  try {
    const first = await run(node, world);
    assertEquals(first.setup, true);
    assertEquals(first.events.failures, []);
    assertEquals(first.events.failed, 0);
    assertEquals(first.events.refused, 0);
    assertEquals(first.events.present, 0);
    assertEquals(first.events.accepted, world.templates.length);
    assertEquals(first.blobs.uploaded, world.blobs.length);
    assertEquals(first.blobs.failed, 0);
    const files: string[] = [];
    for await (const entry of Deno.readDir(`${node.dataDir}/blobs`)) {
      files.push(entry.name);
    }
    const hashes = new Set(world.blobs.map((b) => b.sha256));
    assertEquals(files.length, hashes.size);
    for (const hash of hashes) {
      await Deno.stat(`${node.dataDir}/blobs/${hash}`);
    }
    assertEquals(node.config.owner, personaKey("mara").pubkey);
  } finally {
    await node.close();
  }
});

Deno.test("a second run reports everything as already present", async () => {
  const world = buildWorld({ now: NOW });
  const node = await startNode(world, "everyone");
  try {
    const first = await run(node, world);
    const second = await run(node, world);
    assertEquals(second.setup, false);
    assertEquals(second.events.accepted, 0);
    assertEquals(second.events.present, first.events.accepted);
    assertEquals(second.events.refused, 0);
    assertEquals(second.events.failed, 0);
    assertEquals(second.blobs.failed, 0);
  } finally {
    await node.close();
  }
});

Deno.test("with two hops in range, the strangers are refused by policy and nothing fails", async () => {
  const world = buildWorld({ now: NOW });
  const node = await startNode(world, "two-hops");
  try {
    const report = await run(node, world);
    const tiers = tierOf(world);
    const outside = (handle: string) =>
      ["stranger", "muted", "hub"].includes(tiers.get(handle) ?? "");
    const refusedExpected = world.templates.filter((t) => outside(t.author))
      .length;
    assert(refusedExpected > 0, "some events come from outside");
    assertEquals(report.events.failed, 0, report.events.failures.join("; "));
    assertEquals(report.events.refused, refusedExpected);
    assertEquals(
      report.events.accepted,
      world.templates.length - refusedExpected,
    );
    const skippedExpected = world.blobs.filter((b) => outside(b.owner)).length;
    assertEquals(report.blobs.skipped, skippedExpected);
    assertEquals(report.blobs.failed, 0);
    assertEquals(report.hops, { "0": 1, "1": 12, "2": 30 });
    const summary = formatSummary(report).join("\n");
    assert(summary.includes("refused by policy"));
    assert(summary.includes(personaKey("mara").npub));
  } finally {
    await node.close();
  }
});

Deno.test("a node that already has another owner refuses the events and says so", async () => {
  const world = buildWorld({ now: NOW });
  const stranger = personaKey("hub").pubkey;
  const node = await startNode(world, "two-hops", stranger);
  try {
    const report = await run(node, world);
    assertEquals(report.setup, false);
    assertEquals(report.foreignOwner, stranger);
    assertEquals(report.events.failed, 0);
    assertEquals(report.events.accepted, 0);
    assertEquals(report.blobs.uploaded, 0);
    assert(
      formatSummary(report).some((line) => line.includes("belongs to")),
      "the summary says whose node it is",
    );
  } finally {
    await node.close();
  }
});

Deno.test("an unreachable node is reported as such", async () => {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  await assertRejects(
    () =>
      seedNode(
        { url: `http://127.0.0.1:${port}`, owner: "mara", quiet: true },
        quiet,
      ),
    NodeUnreachableError,
  );
});
