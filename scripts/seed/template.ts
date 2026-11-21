/**
 * Turns event templates into signed events. Placeholders are resolved on the
 * way (see {@link Template}); an event is signed only once the events it refers
 * to are, because their ids are part of it.
 * @module
 */
import { getEventHash, getPublicKey } from "@nostr/tools/pure";
import { neventEncode, npubEncode } from "@nostr/tools/nip19";
// `finalizeEvent` signs with fresh randomness. Signing with a fixed auxiliary
// value keeps every event, including reposts that embed a signed event,
// identical from run to run.
import { schnorr } from "@noble/curves/secp256k1.js";
import { personaKey } from "./keys.ts";
import type { Profile, SignedEvent, Template } from "./model.ts";

/** What the renderer needs from the outside: which blobs have URLs. */
export interface RenderEnv {
  /** The URL of an uploaded blob, or undefined when it is not uploaded. */
  mediaUrl(blobId: string): string | undefined;
}

const PLACEHOLDER = /\{\{(pub|npub|event|nevent|json|media):([^}]+)\}\}/g;
const MEDIA = /\{\{media:([^}]+)\}\}/g;

/**
 * Renders templates on demand and memoizes the result. Keys are looked up in
 * the templates given; an unknown key or a reference cycle is an error.
 */
export class Renderer {
  readonly #templates: ReadonlyMap<string, Template>;
  readonly #env: RenderEnv;
  readonly #done = new Map<string, SignedEvent>();
  readonly #active = new Set<string>();

  constructor(templates: readonly Template[], env: RenderEnv) {
    this.#templates = new Map(templates.map((t) => [t.key, t]));
    if (this.#templates.size !== templates.length) {
      throw new Error("template keys must be unique");
    }
    this.#env = env;
  }

  /** The signed event of the template with this key. */
  event(key: string): SignedEvent {
    const done = this.#done.get(key);
    if (done) return done;
    if (this.#active.has(key)) throw new Error(`reference cycle at ${key}`);
    const template = this.#templates.get(key);
    if (!template) throw new Error(`no template named ${key}`);
    this.#active.add(key);
    const signed = this.#render(template);
    this.#active.delete(key);
    this.#done.set(key, signed);
    return signed;
  }

  #render(t: Template): SignedEvent {
    const content = t.kind === 0 && t.profile
      ? profileContent(t.profile, this.#env)
      : this.#text(dropLines(t.content, this.#env));
    const tags = t.tags.flatMap((tag) => {
      if (tag.some((value) => hasMissingMedia(value, this.#env))) return [];
      return [tag.map((value) => this.#text(value))];
    });
    return signDeterministically(
      { kind: t.kind, created_at: t.createdAt, tags, content },
      personaKey(t.author).secretKey,
    );
  }

  #text(text: string): string {
    return text.replace(PLACEHOLDER, (_whole, kind: string, arg: string) => {
      switch (kind) {
        case "pub":
          return personaKey(arg).pubkey;
        case "npub":
          return npubEncode(personaKey(arg).pubkey);
        case "event":
          return this.event(arg).id;
        case "nevent":
          return neventEncode({ id: this.event(arg).id, relays: [] });
        case "json":
          return JSON.stringify(this.event(arg));
        case "media":
          return this.#env.mediaUrl(arg) ?? "";
        default:
          throw new Error(`unknown placeholder ${kind}`);
      }
    });
  }
}

/** True when a value names a blob that has no URL. */
function hasMissingMedia(value: string, env: RenderEnv): boolean {
  return [...value.matchAll(MEDIA)].some((m) =>
    env.mediaUrl(m[1]) === undefined
  );
}

/** Removes the lines of a text that name a blob without a URL. */
function dropLines(text: string, env: RenderEnv): string {
  return text
    .split("\n")
    .filter((line) => !hasMissingMedia(line, env))
    .join("\n");
}

/** The JSON content of a profile. Blob fields are omitted when not uploaded. */
function profileContent(profile: Profile, env: RenderEnv): string {
  const out: Record<string, string> = { name: profile.name };
  if (profile.display_name !== undefined) {
    out.display_name = profile.display_name;
  }
  if (profile.about !== undefined) out.about = profile.about;
  const picture = profile.picture && env.mediaUrl(profile.picture);
  if (picture) out.picture = picture;
  const banner = profile.banner && env.mediaUrl(profile.banner);
  if (banner) out.banner = banner;
  if (profile.nip05 !== undefined) out.nip05 = profile.nip05;
  if (profile.website !== undefined) out.website = profile.website;
  return JSON.stringify(out);
}

/** The auxiliary randomness of BIP-340 signing; zero makes signatures repeatable. */
const NO_AUX = new Uint8Array(32);

/**
 * Signs an event the way NIP-01 does, with a fixed auxiliary value. The
 * library's `finalizeEvent` signs with fresh randomness, so a repost, which
 * carries the JSON of its target including the signature, would change on
 * every run. Signatures made here verify like any other.
 */
export function signDeterministically(
  template: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  },
  secretKey: Uint8Array,
): SignedEvent {
  const unsigned = { ...template, pubkey: getPublicKey(secretKey) };
  const id = getEventHash(unsigned);
  const sig = schnorr.sign(fromHex(id), secretKey, NO_AUX);
  return {
    id,
    pubkey: unsigned.pubkey,
    created_at: template.created_at,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
    sig: toHex(sig),
  };
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}
