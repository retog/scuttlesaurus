/**
 * Believable fake data for the `/dev/gallery` test bench. Nothing here is
 * loaded by the real views.
 *
 * @module
 */
import type { NodeGraph, NodeStatus } from "./lib/api.ts";
import { type NoteEvent, toNpub } from "./lib/nostr.ts";
import type { ArticleSummary } from "./components/ArticleCard.tsx";
import { toNaddr } from "./lib/nostr.ts";

function svg(body: string, size = 160): string {
  return `data:image/svg+xml;utf8,${
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${body}</svg>`,
    )
  }`;
}

function wide(body: string): string {
  return `data:image/svg+xml;utf8,${
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420" preserveAspectRatio="xMidYMid slice">${body}</svg>`,
    )
  }`;
}

/** A landscape illustration for notes and article covers. */
export const IMG_HILLS = wide(
  `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3d9a4"/><stop offset="1" stop-color="#f6f4ee"/></linearGradient></defs>
   <rect width="800" height="420" fill="url(#s)"/><circle cx="600" cy="120" r="54" fill="#d98a1f" opacity=".85"/>
   <path d="M0 300 C120 220 220 260 320 230 S520 180 800 270 V420 H0Z" fill="#7fb59c"/>
   <path d="M0 350 C140 290 260 330 400 300 S640 270 800 340 V420 H0Z" fill="#1f7a5c"/>`,
);
/** A second illustration, cooler. */
export const IMG_FERNS = wide(
  `<rect width="800" height="420" fill="#16382c"/>
   <g stroke="#4cc79a" stroke-width="6" fill="none" stroke-linecap="round" opacity=".9">
   <path d="M120 420 C140 300 200 220 300 160"/><path d="M300 420 C300 320 360 230 470 190"/>
   <path d="M520 420 C520 330 590 250 700 210"/><path d="M60 420 C60 340 100 300 160 270"/></g>
   <circle cx="660" cy="90" r="28" fill="#f0b254"/>`,
);
const PIC_ADA = svg(
  `<rect width="160" height="160" fill="#dff0e8"/><circle cx="80" cy="64" r="30" fill="#1f7a5c"/><path d="M24 160 C28 112 132 112 136 160Z" fill="#1f7a5c"/>`,
);
const PIC_NOVA = svg(
  `<rect width="160" height="160" fill="#2b2f4a"/><circle cx="80" cy="80" r="44" fill="#f0b254"/><circle cx="96" cy="68" r="38" fill="#2b2f4a"/>`,
);

const hex = (seed: string) => {
  let out = "";
  let h = 2166136261;
  for (let i = 0; out.length < 64; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
};

/** The people of the fixture world, with their hop distance from "you". */
export const PEOPLE = {
  you: {
    pubkey: hex("you"),
    name: "mara",
    displayName: "Mara Okafor",
    about: "Reads slowly, writes rarely. Keeps ferns.",
    picture: undefined as string | undefined,
    nip05: "mara@saurus.example",
    hops: 0,
  },
  ada: {
    pubkey: hex("ada"),
    name: "ada",
    displayName: "Ada Lindqvist",
    about: "Typesetting, tide tables and tiny databases.",
    picture: PIC_ADA as string | undefined,
    nip05: "ada@lindqvist.example",
    hops: 1,
  },
  tomas: {
    pubkey: hex("tomas"),
    name: "tomas",
    displayName: undefined as string | undefined,
    about: "Sailing, soldering, sourdough.",
    picture: undefined as string | undefined,
    nip05: undefined as string | undefined,
    hops: 1,
  },
  nova: {
    pubkey: hex("nova"),
    name: "nova",
    displayName: "Nova Reyes",
    about: "Night-shift radio astronomer.",
    picture: PIC_NOVA as string | undefined,
    nip05: "nova@observatory.example",
    hops: 2,
  },
  kofi: {
    pubkey: hex("kofi"),
    name: "kofi.m",
    displayName: "Kofi Mensah",
    about: "Cartographer of things that do not exist yet.",
    picture: undefined as string | undefined,
    nip05: undefined as string | undefined,
    hops: 3,
  },
  stranger: {
    pubkey: hex("stranger"),
    name: undefined as string | undefined,
    displayName: undefined as string | undefined,
    about: undefined as string | undefined,
    picture: undefined as string | undefined,
    nip05: undefined as string | undefined,
    hops: undefined as number | undefined,
  },
};

const now = Math.floor(Date.now() / 1000);
const id = (n: string) => hex("note-" + n);

/** Notes in different shapes: plain, links, mentions, hashtags, images. */
export const NOTES: Record<string, NoteEvent> = {
  plain: {
    id: id("plain"),
    pubkey: PEOPLE.ada.pubkey,
    created_at: now - 3 * 60,
    content:
      "The tide table for the harbour is now a single SQLite file and a 40-line script.\nSome problems want a smaller hammer.",
  },
  links: {
    id: id("links"),
    pubkey: PEOPLE.tomas.pubkey,
    created_at: now - 2 * 3600,
    content:
      "Finally read the Scuttlebutt protocol guide again (https://ssbc.github.io/scuttlebutt-protocol-guide/). Still the clearest explanation of why gossip beats broadcast. Also: https://example.org/a/very/long/path/that/keeps/going/and/going/index.html?with=query&and=more.",
  },
  mention: {
    id: id("mention"),
    pubkey: PEOPLE.nova.pubkey,
    created_at: now - 26 * 3600,
    content: `Thanks nostr:${
      toNpub(PEOPLE.ada.pubkey)
    } for the pointer! And hello nostr:${
      toNpub(PEOPLE.stranger.pubkey)
    }, whoever you are. Notes on the survey go to #radioastronomy and #nightshift, see you at 3am.`,
  },
  image: {
    id: id("image"),
    pubkey: PEOPLE.you.pubkey,
    created_at: now - 3 * 86400,
    content:
      `First light over the ridge this morning.\n${IMG_HILLS}\nWorth the early alarm. #photography`,
  },
  gallery: {
    id: id("gallery"),
    pubkey: PEOPLE.kofi.pubkey,
    created_at: now - 12 * 86400,
    content:
      `Two sketches of the same coastline, drawn a year apart.\n${IMG_HILLS}\n${IMG_FERNS}`,
  },
  long: {
    id: id("long"),
    pubkey: PEOPLE.ada.pubkey,
    created_at: now - 40 * 86400,
    content:
      "A good protocol is one you can explain on a napkin and implement on a weekend.\n\nA great protocol survives its own success: the napkin still works once a million people are using it, and nobody had to ask permission.\n\nNostr is closer to that than most things I have used. Keys instead of accounts, events instead of APIs, and relays you can swap like batteries.",
  },
};

/** An article with every Markdown element the prose styles must handle. */
export const ARTICLE_MARKDOWN = `# Why a small network is a good network

*A note on neighbourhoods, gossip, and keeping only what you will read.*

Most social software is built to maximise the number of people you can reach. Scuttlebutt, the peer-to-peer network that inspired this project, was built around a different number: the number of people you can *care about*. Your feed is the people you follow, and the people they follow, and then it stops.

![A ridge at first light](${IMG_HILLS})

## Social distance is a feature

When everything is replicated from everywhere, distance disappears and with it any sense of where a voice came from. When you replicate only what is near you, **distance becomes information**. A note from a friend of a friend reads differently from a note from a friend, and that is as it should be.

> The graph is the spam filter. Nobody is blocked; most people are simply far away.

There are three rings worth naming:

1. **You**, whose whole history is kept.
2. **The people you follow**, with a generous window of recent history.
3. **Their follows**, with a short window, just enough to read along.

### What it costs

Rough numbers, for a node following about a hundred people:

- a few hundred thousand triples
- a few hundred megabytes of memory
- almost no bandwidth, once the backfill has finished

If you are curious how a query looks, here is the one that finds the newest notes of the people you follow:

\`\`\`sparql
SELECT ?note ?createdAt WHERE {
  ?list nostr:author <nostr:npub1…> ; nostr:kind 3 ; nostr:follows ?author .
  ?note nostr:author ?author ; nostr:kind 1 ; nostr:createdAt ?createdAt .
}
ORDER BY DESC(?createdAt) LIMIT 50
\`\`\`

Inline code such as \`nostr:supersededBy\` should sit comfortably inside a line of running text without breaking the rhythm of the paragraph.

---

## Reading further

| Idea | Where |
| ---- | ----- |
| Gossip replication | Scuttlebutt protocol guide |
| Outbox model | NIP-65 |

See [the NIP index](https://github.com/nostr-protocol/nips) or the profile of nostr:${
  toNpub(PEOPLE.ada.pubkey)
} who wrote most of this down.

#### A closing thought

Keep less, read more.`;

/** The article card fixtures. */
export const ARTICLES: ArticleSummary[] = [
  {
    naddr: toNaddr(30023, PEOPLE.ada.pubkey, "small-network"),
    title: "Why a small network is a good network",
    summary:
      "Most social software maximises reach. Scuttlebutt maximised care: your feed is the people you follow, their follows, and then it stops.",
    image: IMG_HILLS,
    pubkey: PEOPLE.ada.pubkey,
    publishedAt: now - 4 * 86400,
    content: ARTICLE_MARKDOWN,
  },
  {
    naddr: toNaddr(30023, PEOPLE.nova.pubkey, "listening"),
    title: "Listening to the sky at three in the morning",
    summary:
      "What a night shift at a radio telescope teaches you about patience.",
    image: IMG_FERNS,
    pubkey: PEOPLE.nova.pubkey,
    publishedAt: now - 20 * 86400,
    content: "word ".repeat(1650),
  },
  {
    naddr: toNaddr(30023, PEOPLE.kofi.pubkey, "no-cover"),
    title: "A short article without a cover image",
    pubkey: PEOPLE.kofi.pubkey,
    publishedAt: now - 400 * 86400,
    content: "word ".repeat(300),
  },
];

/** A status as the node would report it. */
export const STATUS: NodeStatus = {
  name: "Scuttlesaurus",
  description: "Mara's corner of the network.",
  version: "0.1.0",
  owner: PEOPLE.you.pubkey,
  setupRequired: false,
  relayUrl: "ws://localhost:7777/",
  publicUrl: "http://localhost:7777",
  hops: 3,
  publicSparql: true,
  blossom: { enabled: true, maxBlobSize: 52428800 },
  stats: { events: 48213, triples: 512940, authors: 1963 },
  authorsByHop: [1, 142, 1180, 640],
  replication: {
    enabled: true,
    running: true,
    authorsByHop: [1, 142, 1180, 640],
    relays: [],
  },
  connections: 1,
};

/** The social graph of the fixture world. */
export const GRAPH: NodeGraph = {
  owner: PEOPLE.you.pubkey,
  hops: 3,
  distances: Object.fromEntries(
    Object.values(PEOPLE)
      .filter((p) => p.hops !== undefined)
      .map((p) => [p.pubkey, p.hops!]),
  ),
};
