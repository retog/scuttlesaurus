/**
 * Seeds a node as an external Nostr client. The order matters: the owner's
 * lists first, then each distance in turn (publish the follow lists of one
 * distance, wait until the node has the next distance), then the blobs of the
 * people the node now has in range, then everything else in time order.
 *
 * Events from authors outside the node's social graph are refused by policy.
 * That is the node working as designed, so they are counted apart from the
 * unexpected failures.
 * @module
 */
import {
  type GraphDocument,
  mapLimit,
  messageOf,
  NodeClient,
  type PublishOutcome,
  RelaySession,
} from "./client.ts";
import { distancesFrom } from "./graph.ts";
import { personaKey } from "./keys.ts";
import type { Template, World } from "./model.ts";
import { Renderer } from "./template.ts";
import { buildWorld, startOfHour } from "./world.ts";

const PUBLISH_CONCURRENCY = 20;
const UPLOAD_CONCURRENCY = 4;
const GRAPH_DEADLINE_MS = 20_000;
const POLL_MS = 300;
/** Kinds of the lists that build the graph. */
const LIST_KINDS = new Set([3, 10000, 10002]);
/** Kind 5 deletes its targets, so it is published after everything else. */
const DELETION_KIND = 5;

/** What the seed was asked to do. */
export interface SeedOptions {
  /** The node's URL, e.g. `http://127.0.0.1:7777`. */
  readonly url: string;
  /** A persona's handle, or `hub`. */
  readonly owner: string;
  /** Suppresses progress lines; the summary is always printed. */
  readonly quiet?: boolean;
}

/** Injection points for the tests and for `seed.ts`. */
export interface SeedDeps {
  /** The world to publish; built from `now` when absent. */
  readonly world?: World;
  /** Start of the hour, unix seconds; defaults to the current hour. */
  readonly now?: number;
  /** Receives progress lines. */
  readonly log?: (line: string) => void;
  /** How long to wait for the node's graph to show each distance. */
  readonly graphDeadlineMs?: number;
}

/** Counts of the events the node answered. */
export interface EventCounts {
  readonly total: number;
  readonly accepted: number;
  readonly present: number;
  readonly refused: number;
  readonly failed: number;
  /** The first distinct reasons of the failures. */
  readonly failures: readonly string[];
}

/** The result of one seeding run. */
export interface SeedReport {
  readonly url: string;
  readonly owner: {
    readonly handle: string;
    readonly pubkey: string;
    readonly npub: string;
    readonly nsec: string;
  };
  /** Whether the seed made the owner of a node that had none. */
  readonly setup: boolean;
  /** The owner the node already had, when it is not the seed's owner. */
  readonly foreignOwner: string | null;
  readonly events: EventCounts;
  readonly blobs: {
    readonly total: number;
    readonly uploaded: number;
    readonly skipped: number;
    readonly failed: number;
    readonly failures: readonly string[];
  };
  /** Number of authors in the node's graph at each distance. */
  readonly hops: Readonly<Record<string, number>>;
}

/**
 * Seeds the node at `options.url`. Throws {@link NodeUnreachableError} when the
 * node does not answer; otherwise resolves with the report, whatever the
 * outcome of the individual events.
 */
export async function seedNode(
  options: SeedOptions,
  deps: SeedDeps = {},
): Promise<SeedReport> {
  const log = deps.log ?? ((line: string) => {
    if (!options.quiet) console.log(line);
  });
  const world = deps.world ?? buildWorld({ now: deps.now ?? startOfHour() });
  const owner = world.personas.find((p) => p.handle === options.owner);
  if (owner === undefined) throw new Error(`no persona named ${options.owner}`);
  const ownerKey = personaKey(owner.handle);
  const deadline = deps.graphDeadlineMs ?? GRAPH_DEADLINE_MS;

  const client = new NodeClient(options.url);
  const status = await client.status();
  let setup = false;
  let foreignOwner: string | null = null;
  if (status.setupRequired) {
    await client.setup(ownerKey.pubkey);
    setup = true;
    log(`Made ${owner.handle} the owner of ${client.url}.`);
  } else if (status.owner !== ownerKey.pubkey) {
    foreignOwner = status.owner;
    log(
      `The node already has another owner (${status.owner}); most events will be refused.`,
    );
  }
  const ownerIsUs = foreignOwner === null;

  const counts = new Tally();
  const urls = new Map<string, string>();
  // Lists are rendered before any upload; they refer to no blob, so the
  // renderer's memo can never hold a result that a later upload would change.
  const renderer = new Renderer(world.templates, {
    mediaUrl: (id) => urls.get(id),
  });
  const published = new Set<string>();
  const relay = await RelaySession.connect(client.relayUrl());
  try {
    const expected = distancesFrom(owner.handle, world.follows, world.mutes);
    const maxHop = Math.max(...expected.values());
    const atHop = (hop: number) =>
      [...expected].filter(([, d]) => d === hop).map(([h]) => h);

    for (let hop = 0; hop < maxHop; hop++) {
      const handles = atHop(hop);
      const lists = world.templates.filter((t) =>
        LIST_KINDS.has(t.kind) && handles.includes(t.author)
      );
      log(
        `Publishing follow lists of ${handles.length} people at distance ${hop}.`,
      );
      await publishAll(lists, renderer, relay, counts, published);
      if (foreignOwner !== null || hop + 1 > status.hops) continue;
      const next = atHop(hop + 1).map((h) => personaKey(h).pubkey);
      await waitForDistances(client, next, deadline, log);
    }

    const graph = await client.graph();
    const inGraph = (handle: string) =>
      (handle === owner.handle && ownerIsUs) ||
      graph.distances[personaKey(handle).pubkey] !== undefined;
    const blobs = await uploadBlobs(world, client, inGraph, urls, log);

    log(`Publishing ${world.templates.length - published.size} events.`);
    const rest = world.templates.filter((t) => !published.has(t.key));
    await publishAll(
      rest.filter((t) => t.kind !== DELETION_KIND).sort(publishOrder),
      renderer,
      relay,
      counts,
      published,
    );
    await publishAll(
      rest.filter((t) => t.kind === DELETION_KIND).sort(publishOrder),
      renderer,
      relay,
      counts,
      published,
    );

    const finalGraph = await client.graph();
    return {
      url: client.url,
      owner: {
        handle: owner.handle,
        pubkey: ownerKey.pubkey,
        npub: ownerKey.npub,
        nsec: ownerKey.nsec,
      },
      setup,
      foreignOwner,
      events: counts.summary(),
      blobs,
      hops: histogram(finalGraph),
    };
  } finally {
    relay.close();
  }
}

/** Counts of the answers, by class. */
class Tally {
  #accepted = 0;
  #present = 0;
  #refused = 0;
  #failed = 0;
  readonly #reasons = new Map<string, number>();

  /** Counts one answer of the relay. */
  record(outcome: PublishOutcome): void {
    if (outcome.ok && outcome.message.startsWith("duplicate:")) {
      this.#present++;
    } else if (outcome.ok) {
      this.#accepted++;
    } else if (
      outcome.message.startsWith("blocked:") ||
      outcome.message.startsWith("deleted:")
    ) {
      this.#refused++;
    } else {
      this.#failed++;
      const reason = outcome.message || "no reason given";
      this.#reasons.set(reason, (this.#reasons.get(reason) ?? 0) + 1);
    }
  }

  /** The counts so far. */
  summary(): EventCounts {
    return {
      total: this.#accepted + this.#present + this.#refused + this.#failed,
      accepted: this.#accepted,
      present: this.#present,
      refused: this.#refused,
      failed: this.#failed,
      failures: [...this.#reasons.keys()].slice(0, 5),
    };
  }
}

/** Publishes the templates in order, with a pipeline of events in flight. */
async function publishAll(
  templates: readonly Template[],
  renderer: Renderer,
  relay: RelaySession,
  counts: Tally,
  published: Set<string>,
): Promise<void> {
  await mapLimit(templates, PUBLISH_CONCURRENCY, async (template) => {
    published.add(template.key);
    const event = renderer.event(template.key);
    let outcome: PublishOutcome;
    try {
      outcome = await relay.publish(event);
    } catch (error) {
      outcome = { ok: false, message: messageOf(error) };
    }
    counts.record(outcome);
  });
}

/** Profiles first, then everything in time order. */
function publishOrder(a: Template, b: Template): number {
  const rank = (t: Template) => (t.kind === 0 ? 0 : 1);
  return rank(a) - rank(b) || a.createdAt - b.createdAt ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Polls `GET /api/graph` until every pubkey has a distance, or the deadline. */
async function waitForDistances(
  client: NodeClient,
  pubkeys: readonly string[],
  deadlineMs: number,
  log: (line: string) => void,
): Promise<GraphDocument> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const graph = await client.graph();
    const missing = pubkeys.filter((p) => graph.distances[p] === undefined);
    if (missing.length === 0) return graph;
    if (Date.now() >= deadline) {
      log(
        `Gave up waiting: ${missing.length} of ${pubkeys.length} people are not in the graph yet; carrying on.`,
      );
      return graph;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Uploads the blobs whose authors the node has in range. */
async function uploadBlobs(
  world: World,
  client: NodeClient,
  inGraph: (handle: string) => boolean,
  urls: Map<string, string>,
  log: (line: string) => void,
): Promise<SeedReport["blobs"]> {
  let uploaded = 0;
  let skipped = 0;
  const failures = new Map<string, number>();
  await mapLimit(world.blobs, UPLOAD_CONCURRENCY, async (blob) => {
    if (!inGraph(blob.owner)) {
      skipped++;
      return;
    }
    try {
      urls.set(blob.id, await client.upload(personaKey(blob.owner), blob));
      uploaded++;
    } catch (error) {
      const reason = messageOf(error);
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
  });
  const failed = [...failures.values()].reduce((sum, n) => sum + n, 0);
  log(`Uploaded ${uploaded} blobs (${skipped} skipped, ${failed} failed).`);
  return {
    total: world.blobs.length,
    uploaded,
    skipped,
    failed,
    failures: [...failures.keys()].slice(0, 5),
  };
}

/** Number of authors at each distance in a graph document. */
function histogram(graph: GraphDocument): Record<string, number> {
  const out: Record<string, number> = {};
  for (const distance of Object.values(graph.distances)) {
    out[String(distance)] = (out[String(distance)] ?? 0) + 1;
  }
  return out;
}

/** The lines of the final summary. */
export function formatSummary(report: SeedReport): string[] {
  const { events, blobs, owner } = report;
  const lines = [
    `Seeded ${report.url} as ${owner.handle}.`,
    `Events: ${events.accepted} accepted, ${events.present} already present, ` +
    `${events.refused} refused by policy (authors outside the graph; expected), ` +
    `${events.failed} failed.`,
    `Blobs: ${blobs.uploaded} uploaded, ${blobs.skipped} skipped (authors outside the graph), ${blobs.failed} failed.`,
    `Graph: ${
      Object.entries(report.hops)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([hop, n]) => `hop ${hop}: ${n}`)
        .join(", ") || "empty"
    }.`,
  ];
  if (report.foreignOwner !== null) {
    lines.push(
      `The node belongs to ${report.foreignOwner}, not to ${owner.handle}. ` +
        `Only events from that owner's social graph are stored; the rest are refused.`,
    );
  }
  for (const reason of [...events.failures, ...blobs.failures]) {
    lines.push(`  failure: ${reason}`);
  }
  lines.push(
    `Log in as ${owner.handle}: npub ${owner.npub}`,
    `  nsec ${owner.nsec}`,
    `  This is a public demo key, derived from a known seed. Never use it for anything real.`,
    `Open ${report.url}/ in a browser.`,
  );
  return lines;
}
