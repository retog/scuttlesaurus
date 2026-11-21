/**
 * The types shared by the seed modules: personas, event templates, blobs and
 * the world they make up. Nothing in here does I/O.
 *
 * A template is an event before signing. It may refer to other events, to
 * people and to blobs by placeholder (see `template.ts`), which lets the world
 * be plain deterministic data while the publisher decides which blob URLs
 * exist and which events are signed.
 *
 * @module
 */

/** Where a persona stands relative to the seed owner. */
export type Tier = "owner" | "friend" | "fof" | "stranger" | "muted" | "hub";

/** The register a persona writes in. */
export type Voice = "plain" | "warm" | "dry" | "terse" | "formal";

/** The motif of a generated avatar. */
export type Motif = "figure" | "crescent" | "sun" | "leaf" | "waves" | "hill";

/** Colours and motif of a generated avatar. */
export interface AvatarLook {
  readonly motif: Motif;
  readonly background: string;
  readonly foreground: string;
}

/** A person of the seed world, as the world builder sees them. */
export interface Persona {
  /** Unique, lower case. Keys are derived from it. */
  readonly handle: string;
  /** The profile `name`; unique across the cast. */
  readonly name: string;
  readonly displayName?: string;
  readonly about: string;
  readonly tier: Tier;
  /** Keys of the topics this persona writes about. */
  readonly topics: readonly string[];
  readonly voice: Voice;
  readonly nip05?: string;
  readonly website?: string;
  /** Present when the persona has a profile picture. */
  readonly avatar?: AvatarLook;
  readonly banner: boolean;
  /** The relay URL of the NIP-65 relay list. */
  readonly relay: string;
  /** An older `name` for the persona, shown in an older profile version. */
  readonly previousName?: string;
}

/** A profile (kind 0) before signing. Pictures are blob ids. */
export interface Profile {
  readonly name: string;
  readonly display_name?: string;
  readonly about?: string;
  readonly picture?: string;
  readonly banner?: string;
  readonly nip05?: string;
  readonly website?: string;
}

/**
 * An event before signing. Placeholders in `tags` and `content`:
 *
 * - `{{pub:HANDLE}}` the hex public key of a persona
 * - `{{npub:HANDLE}}` the npub of a persona
 * - `{{event:KEY}}` the id of another template
 * - `{{nevent:KEY}}` the nevent of another template
 * - `{{json:KEY}}` the signed JSON of another template (reposts)
 * - `{{media:BLOB}}` the URL of an uploaded blob
 *
 * A line of `content`, or a tag, that names a blob which is not uploaded is
 * left out.
 */
export interface Template {
  /** Unique within the world; referenced by `{{event:KEY}}`. */
  key: string;
  /** Handle of the persona who signs it. */
  author: string;
  kind: number;
  createdAt: number;
  tags: string[][];
  content: string;
  /** Kind 0 only: the profile the content is built from. */
  profile?: Profile;
}

/** A signed event as the node receives it. */
export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A file to upload to Blossom. */
export interface Blob {
  /** Unique within the world, e.g. `avatar:ada`. */
  id: string;
  /** Handle of the persona who uploads it. */
  owner: string;
  type: string;
  bytes: Uint8Array;
  /** Lower-case hex SHA-256 of `bytes`. */
  sha256: string;
}

/** The whole seed world at one instant. */
export interface World {
  /** Start of the hour the world is built for; all times are relative to it. */
  readonly now: number;
  readonly personas: readonly Persona[];
  /** Current follow list of each persona that follows anybody, by handle. */
  readonly follows: ReadonlyMap<string, readonly string[]>;
  /** Public mute lists (kind 10000), by handle. */
  readonly mutes: ReadonlyMap<string, readonly string[]>;
  readonly templates: readonly Template[];
  readonly blobs: readonly Blob[];
}
