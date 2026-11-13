/**
 * The RDF vocabulary and IRI scheme of the Scuttlesaurus graph.
 *
 * This module is the single source of truth for term names and is shared by
 * the server and the web client. The prose description of every term, and of
 * the rules that keep the graph monotonic, lives in `docs/DATA-MODEL.md`.
 *
 * IRI scheme
 * - Vocabulary terms:  `nostr:ontology:<term>`       (prefix `nostr:`)
 * - Tag index terms:   `nostr:ontology:tag:<letter>` (prefix `tag:`)
 * - Public keys:       `nostr:npub1…`   (NIP-21 URI of the NIP-19 npub)
 * - Events:            `nostr:note1…`   (NIP-21 URI of the NIP-19 note id)
 * - Addresses:         `nostr:naddr1…`  (NIP-21 URI of a relay-less naddr)
 * - Blobs:             `urn:sha256:<hex>`
 *
 * @module
 */
import * as nip19 from "@nostr/tools/nip19";

/** Namespace of the vocabulary terms. */
export const NOSTR = "nostr:ontology:";
/** Namespace of the generic single-letter tag index predicates. */
export const TAG = "nostr:ontology:tag:";
export const XSD = "http://www.w3.org/2001/XMLSchema#";
export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

/** SPARQL prologue declaring the prefixes used throughout the code base. */
export const PREFIXES = `PREFIX nostr: <${NOSTR}>
PREFIX tag: <${TAG}>
PREFIX xsd: <${XSD}>
`;

/**
 * Local names of all vocabulary terms. Use `NOSTR + TERMS.author` (or the
 * `term()` helper) rather than string literals so that typos fail to compile.
 */
export const TERMS = {
  // --- every event --------------------------------------------------------
  /** event → pubkey IRI */
  author: "author",
  /** event → xsd:integer */
  kind: "kind",
  /** event → xsd:integer, unix seconds (`created_at`) */
  createdAt: "createdAt",
  /** event → xsd:date, UTC day of `created_at`; index for time windows */
  date: "date",
  /** event → string; omitted when the content is empty */
  content: "content",
  /** event → string, the verbatim JSON `tags` array; omitted when `[]` */
  tags: "tags",
  /** event → string, hex signature */
  sig: "sig",
  /** event → relay IRI the event was first received from */
  seenOn: "seenOn",

  // --- links derived from tags -------------------------------------------
  /** event → event IRI, every `e` tag */
  references: "references",
  /** event → event IRI, every `q` tag */
  quotes: "quotes",
  /** event → address IRI, every `a` tag */
  referencesAddress: "referencesAddress",
  /** event → pubkey IRI, every `p` tag (except kinds 3 and 10000) */
  mentions: "mentions",
  /** reply → event IRI, thread root (NIP-10 / NIP-22) */
  root: "root",
  /** reply → event IRI, direct parent (NIP-10 / NIP-22) */
  replyTo: "replyTo",
  /** reply → address IRI, thread root given as address (NIP-22) */
  rootAddress: "rootAddress",
  /** reply → address IRI, direct parent given as address (NIP-22) */
  replyToAddress: "replyToAddress",
  /** kind 3 event → pubkey IRI (NIP-02) */
  follows: "follows",
  /** kind 10000 event → pubkey IRI (NIP-51 public mutes) */
  mutes: "mutes",
  /** kind 7 event → event IRI (NIP-25) */
  reactsTo: "reactsTo",
  /** kind 6 / 16 event → event IRI (NIP-18) */
  reposts: "reposts",
  /** kind 5 event → event IRI (NIP-09) */
  deletes: "deletes",
  /** kind 5 event → address IRI (NIP-09) */
  deletesAddress: "deletesAddress",
  /** addressable event → address IRI it is a version of */
  address: "address",

  // --- bookkeeping added by the store (still only ever added) -------------
  /** older replaceable/addressable event → the event that replaced it */
  supersededBy: "supersededBy",
  /** event → the kind 5 event of the same author that retracted it */
  deletedBy: "deletedBy",

  // --- kind 0, profile metadata (NIP-01, NIP-24) --------------------------
  name: "name",
  displayName: "displayName",
  about: "about",
  /** → IRI */
  picture: "picture",
  /** → IRI */
  banner: "banner",
  website: "website",
  nip05: "nip05",
  lud16: "lud16",

  // --- kinds 30023 / 30024, long-form content (NIP-23) --------------------
  title: "title",
  summary: "summary",
  /** → IRI */
  image: "image",
  /** → xsd:integer, unix seconds */
  publishedAt: "publishedAt",

  // --- kind 10002 relay list (NIP-65), kind 10063 server list (BUD-03) ----
  /** → relay IRI */
  readRelay: "readRelay",
  /** → relay IRI */
  writeRelay: "writeRelay",
  /** → server IRI */
  blossomServer: "blossomServer",

  // --- blobs (Blossom) -----------------------------------------------------
  /** blob → xsd:integer, bytes */
  blobSize: "blobSize",
  /** blob → string, media type */
  blobType: "blobType",
  /** upload receipt → blob IRI */
  blob: "blob",
  /** upload receipt → pubkey IRI */
  uploadedBy: "uploadedBy",
  /** upload receipt → xsd:integer, unix seconds */
  uploadedAt: "uploadedAt",
  /** upload receipt → xsd:integer, unix seconds; the receipt is void */
  removedAt: "removedAt",
} as const;

export type Term = keyof typeof TERMS;

/** Full IRI of a vocabulary term. */
export function term(name: Term): string {
  return NOSTR + TERMS[name];
}

/** Full IRI of the index predicate for a single-letter tag such as `e`. */
export function tagTerm(letter: string): string {
  if (!/^[a-zA-Z]$/.test(letter)) {
    throw new Error(`Not a single-letter tag name: ${letter}`);
  }
  return TAG + letter;
}

const HEX64 = /^[0-9a-f]{64}$/;

function assertHex64(value: string, what: string): void {
  if (!HEX64.test(value)) {
    throw new Error(`Invalid ${what}: ${value}`);
  }
}

/** `nostr:npub1…` IRI for a hex public key. */
export function pubkeyIri(pubkey: string): string {
  assertHex64(pubkey, "public key");
  return "nostr:" + nip19.npubEncode(pubkey);
}

/** `nostr:note1…` IRI for a hex event id. */
export function eventIri(id: string): string {
  assertHex64(id, "event id");
  return "nostr:" + nip19.noteEncode(id);
}

/**
 * `nostr:naddr1…` IRI for an addressable (or replaceable) event coordinate.
 * The naddr carries no relay hints, which makes the IRI canonical.
 */
export function addressIri(
  kind: number,
  pubkey: string,
  identifier: string,
): string {
  assertHex64(pubkey, "public key");
  return "nostr:" + nip19.naddrEncode({ kind, pubkey, identifier });
}

/** Address IRI for the value of an `a` tag (`<kind>:<pubkey>:<d>`), if valid. */
export function addressIriFromCoordinate(
  coordinate: string,
): string | undefined {
  const match = /^(\d+):([0-9a-f]{64}):(.*)$/s.exec(coordinate);
  if (!match) return undefined;
  return addressIri(Number(match[1]), match[2], match[3]);
}

/** `urn:sha256:<hex>` IRI for a blob. */
export function blobIri(sha256: string): string {
  assertHex64(sha256, "sha256 hash");
  return "urn:sha256:" + sha256;
}

function decode(iri: string, type: string): unknown {
  if (!iri.startsWith("nostr:")) {
    throw new Error(`Not a nostr: IRI: ${iri}`);
  }
  const decoded = nip19.decode(iri.slice("nostr:".length));
  if (decoded.type !== type) {
    throw new Error(`Expected ${type} IRI but got ${decoded.type}: ${iri}`);
  }
  return decoded.data;
}

/** Hex public key of a `nostr:npub1…` IRI. */
export function pubkeyFromIri(iri: string): string {
  return decode(iri, "npub") as string;
}

/** Hex event id of a `nostr:note1…` IRI. */
export function eventIdFromIri(iri: string): string {
  return decode(iri, "note") as string;
}

/** Coordinate of a `nostr:naddr1…` IRI. */
export function addressFromIri(
  iri: string,
): { kind: number; pubkey: string; identifier: string } {
  const { kind, pubkey, identifier } = decode(iri, "naddr") as {
    kind: number;
    pubkey: string;
    identifier: string;
  };
  return { kind, pubkey, identifier };
}

/** Hex hash of a `urn:sha256:<hex>` IRI. */
export function blobHashFromIri(iri: string): string {
  const hash = iri.replace(/^urn:sha256:/, "");
  assertHex64(hash, "blob IRI");
  return hash;
}
