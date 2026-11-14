/**
 * Builds the seed world: the personas, their profiles, follow lists, relay
 * lists and mute list, and every note, article and reaction. Building is pure:
 * the same `now` always gives the same world, down to the blob bytes.
 *
 * Signing is not done here (see `template.ts`); the publisher signs what it
 * sends, once it knows which blobs were uploaded.
 * @module
 */
import { BlobBook } from "./blobs.ts";
import { planFollows } from "./graph.ts";
import { PEOPLE, type PersonaData } from "./data/people.ts";
import { TOPIC_BANK } from "./data/phrases.ts";
import { buildLongForm } from "./long-form.ts";
import { buildNotes } from "./notes.ts";
import type { Persona, Profile, Template, Tier, World } from "./model.ts";
import { createRng, type Rng } from "./random.ts";
import {
  AVATAR_PAIRS,
  avatarLook,
  avatarSvg,
  bannerSvg,
  MOTIFS,
} from "./svg.ts";

const DAY = 86400;
const RELAY_HOSTS = [
  "lantern",
  "tidepool",
  "meadow",
  "harbour",
  "foundry",
  "orchard",
];

/** The start of the hour containing `date`, in unix seconds. */
export function startOfHour(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 3600_000) * 3600;
}

/**
 * Builds the world for the hour starting at `now`. Throws when the cast in
 * `data/people.ts` is malformed, which the tests guard against.
 */
export function buildWorld(options: { now: number }): World {
  const { now } = options;
  checkCast(PEOPLE);
  const rng = createRng("scuttlesaurus-seed");
  const blobs = new BlobBook();
  const personas = PEOPLE.map((data, index) =>
    toPersona(data, index, rng.fork(`persona:${data.handle}`))
  );

  const plan = planFollows(personas, rng.fork("follows"));
  const templates: Template[] = [];
  templates.push(...profiles(personas, now, rng.fork("profiles"), blobs));
  templates.push(...lists(personas, plan, now, rng.fork("lists")));
  templates.push(
    ...buildNotes({ personas, now, rng: rng.fork("notes"), blobs }),
  );
  templates.push(
    ...buildLongForm({ personas, now, rng: rng.fork("long"), blobs }),
  );
  templates.sort((a, b) =>
    a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  return {
    now,
    personas,
    follows: new Map(plan.current),
    mutes: new Map(plan.mutes),
    templates,
    blobs: blobs.list(),
  };
}

/** Counts of a world, for the summary and for the tests. */
export function summarize(world: World): {
  people: Record<Tier, number>;
  kinds: Record<number, number>;
  blobs: number;
} {
  const people: Record<Tier, number> = {
    owner: 0,
    friend: 0,
    fof: 0,
    stranger: 0,
    muted: 0,
    hub: 0,
  };
  for (const p of world.personas) people[p.tier]++;
  const kinds: Record<number, number> = {};
  for (const t of world.templates) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
  return { people, kinds, blobs: world.blobs.length };
}

function checkCast(cast: readonly PersonaData[]): void {
  const handles = new Set<string>();
  const names = new Set<string>();
  for (const p of cast) {
    if (handles.has(p.handle)) throw new Error(`duplicate handle ${p.handle}`);
    if (names.has(p.name)) throw new Error(`duplicate name ${p.name}`);
    handles.add(p.handle);
    names.add(p.name);
    for (const topic of p.topics) {
      if (!(topic in TOPIC_BANK)) throw new Error(`unknown topic ${topic}`);
    }
  }
}

function toPersona(data: PersonaData, index: number, rng: Rng): Persona {
  const avatar = data.avatar === false ? undefined : avatarLook(
    data.motif ?? rng.pick(MOTIFS),
    data.palette ?? index % AVATAR_PAIRS.length,
  );
  return {
    handle: data.handle,
    name: data.name,
    displayName: data.displayName,
    about: data.about,
    tier: data.tier,
    topics: data.topics,
    voice: data.voice,
    nip05: data.nip05,
    website: data.website,
    avatar,
    banner: data.banner === true,
    relay: `wss://relay.${RELAY_HOSTS[index % RELAY_HOSTS.length]}.example/`,
    previousName: data.previousName,
  };
}

/** Profiles, with one older version for a person who changed their name. */
function profiles(
  personas: readonly Persona[],
  now: number,
  rng: Rng,
  blobs: BlobBook,
): Template[] {
  const out: Template[] = [];
  for (const persona of personas) {
    if (persona.avatar) {
      blobs.addSvg(
        `avatar:${persona.handle}`,
        persona.handle,
        avatarSvg(persona.avatar),
      );
    }
    if (persona.banner) {
      blobs.addSvg(
        `banner:${persona.handle}`,
        persona.handle,
        bannerSvg(rng.fork(`banner:${persona.handle}`)),
      );
    }
    if (persona.previousName !== undefined) {
      out.push({
        key: `profile:${persona.handle}:old`,
        author: persona.handle,
        kind: 0,
        createdAt: now - 50 * DAY,
        tags: [],
        content: "",
        profile: {
          name: persona.previousName,
          display_name: persona.name,
          about: persona.about,
        },
      });
    }
    out.push({
      key: `profile:${persona.handle}`,
      author: persona.handle,
      kind: 0,
      createdAt: now - rng.int(10, 40) * DAY,
      tags: [],
      content: "",
      profile: profileOf(persona),
    });
  }
  return out;
}

function profileOf(persona: Persona): Profile {
  return {
    name: persona.name,
    display_name: persona.displayName,
    about: persona.about,
    picture: persona.avatar ? `avatar:${persona.handle}` : undefined,
    banner: persona.banner ? `banner:${persona.handle}` : undefined,
    nip05: persona.nip05,
    website: persona.website,
  };
}

/** Follow lists (with one replaced older version), relay lists and the mute list. */
function lists(
  personas: readonly Persona[],
  plan: ReturnType<typeof planFollows>,
  now: number,
  rng: Rng,
): Template[] {
  const out: Template[] = [];
  for (const persona of personas) {
    const { handle } = persona;
    out.push({
      key: `follows:${handle}`,
      author: handle,
      kind: 3,
      createdAt: now - rng.int(2, 20) * DAY,
      tags: (plan.current.get(handle) ?? []).map((p) => ["p", `{{pub:${p}}}`]),
      content: "",
    });
    const earlier = plan.earlier.get(handle);
    if (earlier) {
      out.push({
        key: `follows:${handle}:old`,
        author: handle,
        kind: 3,
        createdAt: now - earlier.daysAgo * DAY,
        tags: earlier.follows.map((p) => ["p", `{{pub:${p}}}`]),
        content: "",
      });
    }
    out.push({
      key: `relays:${handle}`,
      author: handle,
      kind: 10002,
      createdAt: now - rng.int(20, 60) * DAY,
      tags: [["r", persona.relay]],
      content: "",
    });
  }
  for (const [handle, muted] of plan.mutes) {
    out.push({
      key: `mutes:${handle}`,
      author: handle,
      kind: 10000,
      createdAt: now - 12 * DAY,
      tags: muted.map((p) => ["p", `{{pub:${p}}}`]),
      content: "",
    });
  }
  return out;
}
