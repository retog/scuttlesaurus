/**
 * The mapping between Nostr events and RDF triples, as specified in
 * `docs/DATA-MODEL.md` ("Mapping an event to triples"). Both directions are
 * pure functions, so they can be tested without a store.
 *
 * @module
 */
import { normalizeURL } from "@nostr/tools/utils";
import type { NostrEvent, SparqlBinding } from "../types.ts";
import {
  addressIri,
  eventIdFromIri,
  eventIri,
  pubkeyFromIri,
  pubkeyIri,
  tagTerm,
  term,
} from "../vocab.ts";
import {
  date,
  integer,
  iri,
  isIriref,
  literal,
  Triples,
  webIri,
} from "./ntriples.ts";

const HEX64 = /^[0-9a-f]{64}$/;

/** Whether `value` is 64 lowercase hex characters. */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/** The parts of an `a` tag coordinate `<kind>:<pubkey>:<d>`. */
export interface Coordinate {
  kind: number;
  pubkey: string;
  identifier: string;
}

/** Parse the value of an `a` tag; undefined unless it is a valid coordinate. */
export function parseCoordinate(value: unknown): Coordinate | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,5}):([0-9a-f]{64}):(.*)$/s.exec(value);
  if (!match) return undefined;
  const kind = Number(match[1]);
  if (kind > 65535) return undefined;
  return { kind, pubkey: match[2], identifier: match[3] };
}

/** Address IRI of a coordinate, or undefined if it cannot be encoded. */
export function coordinateIri(coordinate: Coordinate): string | undefined {
  try {
    const value = addressIri(
      coordinate.kind,
      coordinate.pubkey,
      coordinate.identifier,
    );
    return isIriref(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the kind is replaceable (NIP-01): 0, 3 and 10000–19999. */
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/** Whether the kind is addressable (NIP-01): 30000–39999. */
export function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** Whether the kind is ephemeral (NIP-01): 20000–29999. */
export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/** Value of the first `d` tag, or `""`. */
export function dTagValue(event: Pick<NostrEvent, "tags">): string {
  return event.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

/** The coordinate of a replaceable or addressable event, else undefined. */
export function eventCoordinate(event: NostrEvent): Coordinate | undefined {
  if (isAddressable(event.kind)) {
    return {
      kind: event.kind,
      pubkey: event.pubkey,
      identifier: dTagValue(event),
    };
  }
  if (isReplaceable(event.kind)) {
    return { kind: event.kind, pubkey: event.pubkey, identifier: "" };
  }
  return undefined;
}

/** Relay IRI of a URL, normalized, or undefined if it is not a usable relay URL. */
export function relayIri(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return webIri(normalizeURL(url));
  } catch {
    return undefined;
  }
}

const P = (name: Parameters<typeof term>[0]) => iri(term(name));

function firstTag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name && t.length > 1)?.[1];
}

/** NIP-10 `root` and parent ids of a kind 1 event, per the DATA-MODEL table. */
export function nip10Thread(
  tags: string[][],
): { root?: string; reply?: string } {
  const eTags = tags.filter((t) => t[0] === "e" && isHex64(t[1]));
  const marker = (t: string[]) =>
    t[3] === "root" || t[3] === "reply" || t[3] === "mention"
      ? t[3]
      : undefined;
  const rootMarked = eTags.find((t) => marker(t) === "root");
  const replyMarked = eTags.find((t) => marker(t) === "reply");
  const unmarked = eTags.filter((t) => marker(t) === undefined);
  const root = rootMarked ?? unmarked[0];
  const reply = replyMarked ??
    (rootMarked ? rootMarked : unmarked[unmarked.length - 1]);
  return { root: root?.[1], reply: reply?.[1] };
}

/** Add the kind 0 properties parsed from the profile JSON (NIP-01, NIP-24). */
function addProfile(out: Triples, e: string, content: string): void {
  let profile: unknown;
  try {
    profile = JSON.parse(content);
  } catch {
    return;
  }
  if (typeof profile !== "object" || profile === null) return;
  const fields = profile as Record<string, unknown>;
  const strings: [string, Parameters<typeof term>[0]][] = [
    ["name", "name"],
    ["display_name", "displayName"],
    ["about", "about"],
    ["website", "website"],
    ["nip05", "nip05"],
    ["lud16", "lud16"],
  ];
  for (const [key, name] of strings) {
    const value = fields[key];
    if (typeof value === "string" && value.isWellFormed()) {
      out.add(e, P(name), literal(value));
    }
  }
  for (
    const [key, name] of [["picture", "picture"], ["banner", "banner"]] as const
  ) {
    const value = webIri(fields[key]);
    if (value) out.add(e, P(name), iri(value));
  }
}

/** Add the NIP-23 properties of kinds 30023 and 30024. */
function addArticle(out: Triples, e: string, tags: string[][]): void {
  const title = firstTag(tags, "title");
  if (title !== undefined) out.add(e, P("title"), literal(title));
  const summary = firstTag(tags, "summary");
  if (summary !== undefined) out.add(e, P("summary"), literal(summary));
  const image = webIri(firstTag(tags, "image"));
  if (image) out.add(e, P("image"), iri(image));
  const published = firstTag(tags, "published_at");
  if (published !== undefined && /^\d{1,15}$/.test(published)) {
    out.add(e, P("publishedAt"), integer(Number(published)));
  }
}

/**
 * Serialize an event as the N-Triples of DATA-MODEL "Mapping an event to
 * triples". The caller must have validated the event (hex id, pubkey and
 * signature, well-formed strings). Hostile tag values never produce invalid
 * output: values that are not valid link targets only yield the tag index
 * triple. The signature triple is written last so that a log truncated in the
 * middle of a batch leaves an event without `nostr:sig`, which readers ignore.
 */
export function eventToTriples(
  event: NostrEvent,
  options: { seenOn?: string } = {},
): string {
  const out = new Triples();
  const e = iri(eventIri(event.id));
  const author = iri(pubkeyIri(event.pubkey));
  const { kind, tags } = event;

  out.add(e, P("author"), author);
  out.add(e, P("kind"), integer(kind));
  out.add(e, P("createdAt"), integer(event.created_at));
  out.add(e, P("date"), date(event.created_at));
  if (event.content !== "") out.add(e, P("content"), literal(event.content));
  if (tags.length > 0) out.add(e, P("tags"), literal(JSON.stringify(tags)));
  const seenOn = options.seenOn === undefined
    ? undefined
    : relayIri(options.seenOn);
  if (seenOn) out.add(e, P("seenOn"), iri(seenOn));

  const eventTarget = (value: unknown) =>
    isHex64(value) ? iri(eventIri(value)) : undefined;
  const addressTarget = (value: unknown) => {
    const coordinate = parseCoordinate(value);
    const target = coordinate && coordinateIri(coordinate);
    return target ? iri(target) : undefined;
  };
  const pubkeyTarget = (value: unknown) =>
    isHex64(value) ? iri(pubkeyIri(value)) : undefined;

  const pPredicate = kind === 3
    ? P("follows")
    : kind === 10000
    ? P("mutes")
    : P("mentions");

  for (const tag of tags) {
    const [name, value] = tag;
    if (typeof name !== "string" || tag.length < 2) continue;
    if (/^[a-zA-Z]$/.test(name)) {
      out.add(e, iri(tagTerm(name)), literal(value));
    }
    switch (name) {
      case "e": {
        const target = eventTarget(value);
        if (target) {
          out.add(e, P("references"), target);
          if (kind === 5) out.add(e, P("deletes"), target);
        }
        break;
      }
      case "q": {
        const target = eventTarget(value);
        if (target) out.add(e, P("quotes"), target);
        break;
      }
      case "a": {
        const target = addressTarget(value);
        if (target) {
          out.add(e, P("referencesAddress"), target);
          if (kind === 5) out.add(e, P("deletesAddress"), target);
        }
        break;
      }
      case "p": {
        const target = pubkeyTarget(value);
        if (target) out.add(e, pPredicate, target);
        break;
      }
    }
  }

  if (kind === 7 || kind === 6 || kind === 16) {
    const last = [...tags].reverse().find((t) => t[0] === "e" && t.length > 1);
    const target = eventTarget(last?.[1]);
    if (target) out.add(e, P(kind === 7 ? "reactsTo" : "reposts"), target);
  }

  if (kind === 1) {
    const { root, reply } = nip10Thread(tags);
    if (root) out.add(e, P("root"), iri(eventIri(root)));
    if (reply) out.add(e, P("replyTo"), iri(eventIri(reply)));
  } else if (kind === 1111) {
    const root = eventTarget(firstTag(tags, "E"));
    if (root) out.add(e, P("root"), root);
    const parent = eventTarget(firstTag(tags, "e"));
    if (parent) out.add(e, P("replyTo"), parent);
    const rootAddress = addressTarget(firstTag(tags, "A"));
    if (rootAddress) out.add(e, P("rootAddress"), rootAddress);
    const parentAddress = addressTarget(firstTag(tags, "a"));
    if (parentAddress) out.add(e, P("replyToAddress"), parentAddress);
  }

  if (isAddressable(kind)) {
    const address = coordinateIri({
      kind,
      pubkey: event.pubkey,
      identifier: dTagValue(event),
    });
    if (address) out.add(e, P("address"), iri(address));
  }

  if (kind === 0) addProfile(out, e, event.content);
  if (kind === 30023 || kind === 30024) addArticle(out, e, tags);
  if (kind === 10002) {
    for (const tag of tags) {
      if (tag[0] !== "r") continue;
      const relay = relayIri(tag[1]);
      if (!relay) continue;
      const marker = tag[2];
      if (marker === undefined || marker === "" || marker === "read") {
        out.add(e, P("readRelay"), iri(relay));
      }
      if (marker === undefined || marker === "" || marker === "write") {
        out.add(e, P("writeRelay"), iri(relay));
      }
    }
  }
  if (kind === 10063) {
    for (const tag of tags) {
      const server = tag[0] === "server" ? webIri(tag[1]) : undefined;
      if (server) out.add(e, P("blossomServer"), iri(server));
    }
  }

  out.add(e, P("sig"), literal(event.sig));
  return out.toString();
}

/**
 * Rebuild an event from a result row with the variables `e`, `author`,
 * `kind`, `createdAt`, `sig` and optionally `content` and `tags` — the inverse
 * of {@link eventToTriples}. The signature of the result is valid exactly if
 * the stored event was.
 */
export function eventFromBinding(binding: SparqlBinding): NostrEvent {
  return {
    id: eventIdFromIri(binding.e.value),
    pubkey: pubkeyFromIri(binding.author.value),
    created_at: Number(binding.createdAt.value),
    kind: Number(binding.kind.value),
    tags: binding.tags ? JSON.parse(binding.tags.value) : [],
    content: binding.content?.value ?? "",
    sig: binding.sig.value,
  };
}
