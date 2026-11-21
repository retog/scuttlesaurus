import { assert, assertEquals } from "@std/assert";
import { verifyEvent } from "@nostr/tools/pure";
import oxigraph from "oxigraph";
import {
  addressIri,
  eventIri,
  NOSTR,
  pubkeyIri,
  TAG,
  TERMS,
} from "../vocab.ts";
import {
  eventFromBinding,
  eventToTriples,
  nip10Thread,
  parseCoordinate,
  staleListToTriples,
} from "./event_triples.ts";
import { DAY, identities, objectsOf, parseTriples, sign } from "./test_util.ts";

const [alice, bob] = identities(2);
const id = (n: number) => n.toString(16).padStart(64, "0");
const note = (n: number) => `<${eventIri(id(n))}>`;
const term = (name: keyof typeof TERMS) => NOSTR + TERMS[name];
const objects = (nt: string, name: keyof typeof TERMS) =>
  objectsOf(nt, term(name));
const literalJson = (value: unknown) => JSON.stringify(JSON.stringify(value));

Deno.test("every event: core triples, omitted empties, sig last", () => {
  const event = sign(alice, 1, {
    content: "hello",
    tags: [["t", "nostr"]],
    created_at: 1794528000,
  });
  const nt = eventToTriples(event, { seenOn: "wss://Relay.Example.com" });
  assertEquals(objects(nt, "author"), [`<${pubkeyIri(alice.pubkey)}>`]);
  assertEquals(objects(nt, "kind"), [
    '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
  ]);
  assertEquals(objects(nt, "date"), [
    '"2026-11-13"^^<http://www.w3.org/2001/XMLSchema#date>',
  ]);
  assertEquals(objects(nt, "content"), ['"hello"']);
  assertEquals(objects(nt, "tags"), ['"[[\\"t\\",\\"nostr\\"]]"']);
  assertEquals(objects(nt, "seenOn"), ["<wss://relay.example.com/>"]);
  assertEquals(objectsOf(nt, TAG + "t"), ['"nostr"']);
  assert(nt.trimEnd().split("\n").pop()!.includes(`<${term("sig")}>`));

  const bare = eventToTriples(sign(alice, 1));
  assertEquals(objects(bare, "content"), []);
  assertEquals(objects(bare, "tags"), []);
  assertEquals(objects(bare, "seenOn"), []);
});

Deno.test("tags: links, tag index and case-distinct letters", () => {
  const event = sign(alice, 1, {
    tags: [
      ["e", id(1), "", "mention"],
      ["q", id(2)],
      ["p", bob.pubkey],
      ["a", `30023:${bob.pubkey}:my article`],
      ["E", id(3)],
      ["t", ""],
      ["relay", "wss://x"],
    ],
  });
  const nt = eventToTriples(event);
  assertEquals(objects(nt, "references"), [note(1)]);
  assertEquals(objects(nt, "quotes"), [note(2)]);
  assertEquals(objects(nt, "mentions"), [`<${pubkeyIri(bob.pubkey)}>`]);
  assertEquals(objects(nt, "referencesAddress"), [
    `<${addressIri(30023, bob.pubkey, "my article")}>`,
  ]);
  assertEquals(objectsOf(nt, TAG + "e"), [`"${id(1)}"`]);
  assertEquals(objectsOf(nt, TAG + "E"), [`"${id(3)}"`]);
  assertEquals(objectsOf(nt, TAG + "t"), ['""']);
  assertEquals(objectsOf(nt, TAG + "relay"), []);
});

Deno.test("invalid link targets only produce the tag index triple", () => {
  const event = sign(alice, 1, {
    tags: [
      ["e", "nothex"],
      ["e", "A".repeat(64)],
      ["p", "short"],
      ["q", "x"],
      ["a", "1:bad:d"],
      ["a", `99999999:${bob.pubkey}:d`],
      ["e"],
      [],
    ],
  });
  const nt = eventToTriples(event);
  for (
    const name of [
      "references",
      "mentions",
      "quotes",
      "referencesAddress",
      "root",
      "replyTo",
    ] as const
  ) assertEquals(objects(nt, name), [], name);
  assertEquals(objectsOf(nt, TAG + "e").length, 2);
  assertEquals(objectsOf(nt, TAG + "a").length, 2);
});

Deno.test("NIP-10 marked and positional threading", () => {
  const marked = nip10Thread([
    ["e", id(1), "", "root"],
    ["e", id(2), "", "mention"],
    ["e", id(3), "", "reply"],
  ]);
  assertEquals(marked, { root: id(1), reply: id(3) });
  assertEquals(
    nip10Thread([["e", id(1), "", "root"], ["e", id(2), "", "mention"]]),
    { root: id(1), reply: id(1) },
  );
  assertEquals(
    nip10Thread([["e", id(1)], ["e", id(2)], ["e", id(3)]]),
    { root: id(1), reply: id(3) },
  );
  assertEquals(nip10Thread([["e", id(1)]]), { root: id(1), reply: id(1) });
  assertEquals(nip10Thread([["e", id(1), "", "mention"]]), {
    root: undefined,
    reply: undefined,
  });
  assertEquals(nip10Thread([["e", id(9), "", "reply"]]), {
    root: undefined,
    reply: id(9),
  });
  assertEquals(nip10Thread([]), { root: undefined, reply: undefined });

  const nt = eventToTriples(sign(alice, 1, {
    tags: [["e", id(1), "", "root"], ["e", id(3), "", "reply"]],
  }));
  assertEquals(objects(nt, "root"), [note(1)]);
  assertEquals(objects(nt, "replyTo"), [note(3)]);
  assertEquals(objects(nt, "references").sort(), [note(1), note(3)].sort());
  // Threading is a kind 1 notion.
  const other = eventToTriples(sign(alice, 30023, {
    tags: [["d", "x"], ["e", id(1), "", "root"]],
  }));
  assertEquals(objects(other, "root"), []);
});

Deno.test("kind 3, 10000: follows and mutes instead of mentions", () => {
  const follows = eventToTriples(
    sign(alice, 3, { tags: [["p", bob.pubkey]] }),
  );
  assertEquals(objects(follows, "follows"), [`<${pubkeyIri(bob.pubkey)}>`]);
  assertEquals(objects(follows, "mentions"), []);
  const mutes = eventToTriples(
    sign(alice, 10000, { tags: [["p", bob.pubkey]] }),
  );
  assertEquals(objects(mutes, "mutes"), [`<${pubkeyIri(bob.pubkey)}>`]);
  assertEquals(objects(mutes, "mentions"), []);
});

Deno.test("kind 3, 10000: a valid p value is the link only, an invalid one the tag index only", () => {
  const tags = [["p", bob.pubkey], ["p", "not a key"], ["p", alice.pubkey], [
    "t",
    "x",
  ], ["P", bob.pubkey]];
  for (const [kind, link] of [[3, "follows"], [10000, "mutes"]] as const) {
    const nt = eventToTriples(sign(alice, kind, { tags }));
    assertEquals(objects(nt, link), [
      `<${pubkeyIri(bob.pubkey)}>`,
      `<${pubkeyIri(alice.pubkey)}>`,
    ]);
    assertEquals(objectsOf(nt, TAG + "p"), ['"not a key"']);
    // Other letters, and `P`, are indexed as in every kind.
    assertEquals(objectsOf(nt, TAG + "t"), ['"x"']);
    assertEquals(objectsOf(nt, TAG + "P"), [`"${bob.pubkey}"`]);
    // The tags themselves are kept verbatim.
    assertEquals(objects(nt, "tags"), [literalJson(tags)]);
  }
  // Every other kind keeps tag:p next to the link.
  const mention = eventToTriples(sign(alice, 1, { tags }));
  assertEquals(objectsOf(mention, TAG + "p"), [
    `"${bob.pubkey}"`,
    '"not a key"',
    `"${alice.pubkey}"`,
  ]);
  assertEquals(objects(mention, "mentions").length, 2);
});

Deno.test("stale list stub: header, seenOn, supersededBy, then sig", () => {
  const list = sign(alice, 3, {
    content: '{"wss://r.example.com":{}}',
    tags: [["p", bob.pubkey], ["t", "x"]],
    created_at: 1794528000,
  });
  const winner = id(9);
  const e = `<${eventIri(list.id)}>`;
  const integer = (n: number) =>
    `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
  assertEquals(
    parseTriples(
      staleListToTriples(list, winner, { seenOn: "wss://Relay.Example.com" }),
    ),
    [
      [e, `<${term("author")}>`, `<${pubkeyIri(alice.pubkey)}>`],
      [e, `<${term("kind")}>`, integer(3)],
      [e, `<${term("createdAt")}>`, integer(1794528000)],
      [
        e,
        `<${term("date")}>`,
        '"2026-11-13"^^<http://www.w3.org/2001/XMLSchema#date>',
      ],
      [e, `<${term("seenOn")}>`, "<wss://relay.example.com/>"],
      [e, `<${term("supersededBy")}>`, note(9)],
      [e, `<${term("sig")}>`, `"${list.sig}"`],
    ],
  );
  assertEquals(parseTriples(staleListToTriples(list, winner)).length, 6);
});

Deno.test("kinds 5, 6, 7, 16: deletes, reposts, reactsTo (last e tag)", () => {
  const deletion = eventToTriples(sign(alice, 5, {
    tags: [["e", id(1)], ["e", id(2)], ["a", `30023:${alice.pubkey}:d`]],
  }));
  assertEquals(objects(deletion, "deletes").sort(), [note(1), note(2)].sort());
  assertEquals(objects(deletion, "deletesAddress"), [
    `<${addressIri(30023, alice.pubkey, "d")}>`,
  ]);
  const reaction = eventToTriples(sign(alice, 7, {
    content: "+",
    tags: [["e", id(1)], ["p", bob.pubkey], ["e", id(2)]],
  }));
  assertEquals(objects(reaction, "reactsTo"), [note(2)]);
  for (const kind of [6, 16]) {
    const repost = eventToTriples(sign(alice, kind, {
      tags: [["e", id(1)], ["e", id(2)]],
    }));
    assertEquals(objects(repost, "reposts"), [note(2)]);
  }
});

Deno.test("kind 1111 (NIP-22)", () => {
  const nt = eventToTriples(sign(alice, 1111, {
    content: "comment",
    tags: [
      ["E", id(1)],
      ["A", `30023:${bob.pubkey}:post`],
      ["e", id(2)],
      ["a", `30023:${bob.pubkey}:post`],
      ["K", "30023"],
    ],
  }));
  assertEquals(objects(nt, "root"), [note(1)]);
  assertEquals(objects(nt, "replyTo"), [note(2)]);
  const address = `<${addressIri(30023, bob.pubkey, "post")}>`;
  assertEquals(objects(nt, "rootAddress"), [address]);
  assertEquals(objects(nt, "replyToAddress"), [address]);
});

Deno.test("kind 0: defensive profile parsing", () => {
  const nt = eventToTriples(sign(alice, 0, {
    content: JSON.stringify({
      name: "alice",
      display_name: "Alice",
      about: "hi\nthere",
      picture: "https://example.com/a.png",
      banner: "javascript:alert(1)",
      website: 5,
      nip05: "alice@example.com",
      lud16: null,
    }),
  }));
  assertEquals(objects(nt, "name"), ['"alice"']);
  assertEquals(objects(nt, "displayName"), ['"Alice"']);
  assertEquals(objects(nt, "about"), ['"hi\\nthere"']);
  assertEquals(objects(nt, "picture"), ["<https://example.com/a.png>"]);
  assertEquals(objects(nt, "banner"), []);
  assertEquals(objects(nt, "website"), []);
  assertEquals(objects(nt, "nip05"), ['"alice@example.com"']);
  assertEquals(objects(nt, "lud16"), []);
  for (const content of ["not json", "[1]", "null", "42", '"str"', "{"]) {
    const bad = eventToTriples(sign(alice, 0, { content }));
    assertEquals(objects(bad, "name"), [], content);
  }
  const lone = eventToTriples(
    sign(alice, 0, { content: '{"name":"a\\ud800"}' }),
  );
  assertEquals(objects(lone, "name"), []);
});

Deno.test("kinds 30023 and 30024: address and article properties", () => {
  const event = sign(alice, 30023, {
    tags: [
      ["d", "my article"],
      ["title", "T"],
      ["summary", "S"],
      ["image", "https://example.com/i.jpg"],
      ["published_at", "1700000000"],
    ],
  });
  const nt = eventToTriples(event);
  assertEquals(objects(nt, "address"), [
    `<${addressIri(30023, alice.pubkey, "my article")}>`,
  ]);
  assertEquals(objects(nt, "title"), ['"T"']);
  assertEquals(objects(nt, "summary"), ['"S"']);
  assertEquals(objects(nt, "image"), ["<https://example.com/i.jpg>"]);
  assertEquals(objects(nt, "publishedAt"), [
    '"1700000000"^^<http://www.w3.org/2001/XMLSchema#integer>',
  ]);
  const draft = eventToTriples(sign(alice, 30024, {
    tags: [["d", "x"], ["title", "Draft"], ["published_at", "soon"]],
  }));
  assertEquals(objects(draft, "title"), ['"Draft"']);
  assertEquals(objects(draft, "publishedAt"), []);
  // No d tag: the identifier is the empty string.
  const noD = eventToTriples(sign(alice, 30023));
  assertEquals(objects(noD, "address"), [
    `<${addressIri(30023, alice.pubkey, "")}>`,
  ]);
  // Replaceable kinds are not given an address triple.
  assertEquals(objects(eventToTriples(sign(alice, 0)), "address"), []);
});

Deno.test("kind 10002: read/write relays, normalized", () => {
  const nt = eventToTriples(sign(alice, 10002, {
    tags: [
      ["r", "wss://Both.example.com"],
      ["r", "wss://read.example.com/", "read"],
      ["r", "wss://write.example.com", "write"],
      ["r", "wss://other.example.com", "weird"],
      ["r", "javascript:alert(1)"],
      ["r", "wss://bad host/"],
    ],
  }));
  assertEquals(objects(nt, "readRelay").sort(), [
    "<wss://both.example.com/>",
    "<wss://read.example.com/>",
  ]);
  assertEquals(objects(nt, "writeRelay").sort(), [
    "<wss://both.example.com/>",
    "<wss://write.example.com/>",
  ]);
});

Deno.test("kind 10063: blossom servers", () => {
  const nt = eventToTriples(sign(alice, 10063, {
    tags: [
      ["server", "https://cdn.example.com/"],
      ["server", "ftp://nope"],
      ["other", "https://ignored.example.com/"],
    ],
  }));
  assertEquals(objects(nt, "blossomServer"), ["<https://cdn.example.com/>"]);
});

Deno.test("parseCoordinate", () => {
  assertEquals(parseCoordinate(`30023:${alice.pubkey}:a:b`), {
    kind: 30023,
    pubkey: alice.pubkey,
    identifier: "a:b",
  });
  assertEquals(parseCoordinate(`70000:${alice.pubkey}:`), undefined);
  assertEquals(parseCoordinate("x"), undefined);
  assertEquals(parseCoordinate(5), undefined);
});

const AWKWARD: [string, string, string[][]][] = [
  ["empty content and tags", "", []],
  ["quotes and backslashes", 'say "hi" \\o/ \\n \\\\', [["t", 'a"b\\c']]],
  ["newlines and tabs", "a\nb\r\nc\td\n\n", [["t", "line\nbreak\ttab"]]],
  ["emoji and RTL", "🦖 \u202eשלום\u202c مرحبا 日本語", [["t", "🦖"]]],
  [
    "control characters",
    "nul\u0000 bell\u0007 esc\u001b del\u007f ls\u2028 ps\u2029",
    [["t", "\u0000\u0001"]],
  ],
  ["tags with empty strings", "x", [["t", ""], ["", ""], ["e", ""], ["x"]]],
  [
    "d tag with spaces and unicode",
    "article",
    [["d", "héllo wörld 🦖 with  spaces"], ["title", ""]],
  ],
  ["JSON-looking content", '{"a":[1,2,"\\u0000"]}', [["t", '["x"]']]],
  ["hostile N-Triples", '" . <urn:a> <urn:b> <urn:c> .\n', [["t", '> "']]],
];

Deno.test("round trip through Oxigraph reconstructs signed events exactly", () => {
  for (const [name, content, tags] of AWKWARD) {
    for (const kind of [1, 3, 30023]) {
      const event = sign(alice, kind, { content, tags });
      const store = new oxigraph.Store();
      store.load(eventToTriples(event), { format: "application/n-triples" });
      const json = store.query(
        `SELECT ?e ?author ?kind ?createdAt ?content ?tags ?sig WHERE {
          ?e <${term("author")}> ?author ; <${term("kind")}> ?kind ;
             <${term("createdAt")}> ?createdAt ; <${term("sig")}> ?sig .
          OPTIONAL { ?e <${term("content")}> ?content }
          OPTIONAL { ?e <${term("tags")}> ?tags }
        }`,
        { results_format: "application/sparql-results+json" },
      ) as string;
      const rows = JSON.parse(json).results.bindings;
      assertEquals(rows.length, 1, name);
      const rebuilt = eventFromBinding(rows[0]);
      assertEquals(rebuilt, event, name);
      assert(verifyEvent(rebuilt), name);
    }
  }
});

Deno.test("the date follows the UTC day of created_at", () => {
  const late = sign(alice, 1, { created_at: 3 * DAY - 1 });
  const early = sign(alice, 1, { created_at: 3 * DAY });
  assertEquals(
    objects(eventToTriples(late), "date")[0].slice(0, 12),
    '"1970-01-03"',
  );
  assertEquals(
    objects(eventToTriples(early), "date")[0].slice(0, 12),
    '"1970-01-04"',
  );
});
