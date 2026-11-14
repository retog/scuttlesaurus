/**
 * Identity: who is using the client and how events get signed.
 *
 * Four modes: `extension` (NIP-07 `window.nostr`), `remote` (a signer app
 * reached over NIP-46 "Nostr Connect"; see `remote_signer.ts`), `local` (a
 * secret key kept in this browser's localStorage, readable by any script on
 * this origin) and `readonly` (a public key only).
 *
 * In `remote` mode the user's secret key is not in the browser at all. What
 * is stored next to the session (localStorage, unencrypted, like a local key)
 * is only what reconnects to the signer: this browser's own client secret key,
 * the signer's pubkey and the relays. The session is restored from it at once
 * on a reload; the connection is re-established in the background and on the
 * first signature.
 *
 * @module
 */
import { computed, signal } from "@preact/signals";
import type { Event, EventTemplate } from "@nostr/tools/core";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "@nostr/tools/pure";
import * as nip19 from "@nostr/tools/nip19";
import { bytesToHex, hexToBytes } from "@nostr/tools/utils";
import { parsePubkey } from "./nostr.ts";
import { publish as publishToRelay } from "./relay.ts";
import {
  disconnectRemote,
  type RemoteConnectionData,
  restoreRemote,
  signRemote,
  warmUpRemote,
} from "./remote_signer.ts";

/** How the current identity signs. */
export type SessionMode = "extension" | "remote" | "local" | "readonly";

/** The logged-in identity. */
export interface Session {
  /** Hex public key. */
  pubkey: string;
  mode: SessionMode;
}

/** The NIP-07 provider interface. */
export interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

const SESSION_KEY = "scuttlesaurus.session";
const SECRET_KEY = "scuttlesaurus.secretKey";
/** NIP-46 reconnect data: the client key (not the user's), signer and relays. */
const REMOTE_KEY = "scuttlesaurus.remote";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: identity lasts for this page view
  }
}

function loadRemote(): RemoteConnectionData | null {
  try {
    const data = JSON.parse(read(REMOTE_KEY) ?? "null") as
      | Partial<RemoteConnectionData>
      | null;
    const hex = /^[0-9a-f]{64}$/;
    if (
      !data || !hex.test(data.clientSecretKey ?? "") ||
      !hex.test(data.signerPubkey ?? "") || !hex.test(data.userPubkey ?? "") ||
      !Array.isArray(data.relays) || data.relays.length === 0 ||
      !data.relays.every((r) => typeof r === "string")
    ) return null;
    return data as RemoteConnectionData;
  } catch {
    return null;
  }
}

function load(): Session | null {
  try {
    const parsed = JSON.parse(read(SESSION_KEY) ?? "null") as Session | null;
    if (!parsed || !/^[0-9a-f]{64}$/.test(parsed.pubkey)) return null;
    if (parsed.mode === "local" && !read(SECRET_KEY)) return null;
    if (!["extension", "remote", "local", "readonly"].includes(parsed.mode)) {
      return null;
    }
    if (parsed.mode === "remote") {
      const remote = loadRemote();
      if (!remote || remote.userPubkey !== parsed.pubkey) return null;
      // Restored at once; the signer is contacted in the background.
      restoreRemote(remote);
      queueMicrotask(() => void warmUpRemote());
    }
    return { pubkey: parsed.pubkey, mode: parsed.mode };
  } catch {
    return null;
  }
}

/** The current identity, or `null`. Persisted in localStorage. */
export const session = signal<Session | null>(load());

/** Whether the current identity can sign events. */
export const canSign = computed(() => {
  const s = session.value;
  return s !== null && s.mode !== "readonly";
});

function setSession(next: Session | null): void {
  session.value = next;
  write(SESSION_KEY, next ? JSON.stringify(next) : null);
}

/** Whether a NIP-07 provider is present in this browser. */
export function hasExtension(): boolean {
  return typeof globalThis.window?.nostr?.getPublicKey === "function";
}

/** Log in with the NIP-07 browser extension. Throws if it is missing or refuses. */
export async function loginWithExtension(): Promise<Session> {
  const provider = globalThis.window?.nostr;
  if (!provider) throw new Error("No Nostr extension found in this browser");
  const pubkey = await provider.getPublicKey();
  forgetKeys();
  const next: Session = { pubkey, mode: "extension" };
  setSession(next);
  return next;
}

/**
 * Sign in with a signer app that has just connected (NIP-46, see
 * `remote_signer.ts`). Stores what is needed to reconnect after a reload.
 */
export function loginWithRemote(data: RemoteConnectionData): Session {
  // The connection is already the active one: do not tear it down here.
  write(SECRET_KEY, null);
  write(REMOTE_KEY, JSON.stringify(data));
  const next: Session = { pubkey: data.userPubkey, mode: "remote" };
  setSession(next);
  return next;
}

/** Drop everything stored for a previous identity, ending a remote session. */
function forgetKeys(): void {
  write(SECRET_KEY, null);
  write(REMOTE_KEY, null);
  disconnectRemote();
}

function parseSecretKey(input: string): Uint8Array {
  const value = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return hexToBytes(value.toLowerCase());
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return decoded.data;
  } catch {
    // fall through
  }
  throw new Error("That is not a valid nsec or 64-character hex key");
}

/** Log in with a secret key (nsec or hex); it is kept in localStorage. */
export function loginWithSecretKey(nsecOrHex: string): Session {
  const secret = parseSecretKey(nsecOrHex);
  const next: Session = { pubkey: getPublicKey(secret), mode: "local" };
  forgetKeys();
  write(SECRET_KEY, bytesToHex(secret));
  setSession(next);
  return next;
}

/**
 * Generate a fresh identity and log in with it. Returns the nsec, which the
 * user must be told to save: it is shown nowhere else.
 */
export function createIdentity(): {
  nsec: string;
  npub: string;
  pubkey: string;
} {
  const secret = generateSecretKey();
  const session = loginWithSecretKey(bytesToHex(secret));
  return {
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(session.pubkey),
    pubkey: session.pubkey,
  };
}

/** Browse as somebody else without signing: npub, nprofile or hex. */
export function loginReadOnly(npubOrHex: string): Session {
  const pubkey = parsePubkey(npubOrHex);
  if (!pubkey) throw new Error("That is not a valid npub or public key");
  forgetKeys();
  const next: Session = { pubkey, mode: "readonly" };
  setSession(next);
  return next;
}

/**
 * The `nsec` of a key kept in this browser, for the person to copy. `undefined`
 * unless the current identity is a local key.
 */
export function revealSecretKey(): string | undefined {
  if (session.value?.mode !== "local") return undefined;
  const secret = read(SECRET_KEY);
  if (!secret) return undefined;
  return nip19.nsecEncode(hexToBytes(secret));
}

/**
 * Forget the identity: a locally stored secret key, or a signer app
 * connection (the signer is told with NIP-46 `logout` in the background and
 * this browser's client key is discarded).
 */
export function logout(): void {
  forgetKeys();
  setSession(null);
}

/** Sign an event template as the current identity. */
export async function signEvent(template: EventTemplate): Promise<Event> {
  const current = session.value;
  if (!current || current.mode === "readonly") {
    throw new Error("Sign in with a key to do this");
  }
  if (current.mode === "extension") {
    const provider = globalThis.window?.nostr;
    if (!provider) throw new Error("The Nostr extension is not available");
    const event = await provider.signEvent(template);
    if (event.pubkey !== current.pubkey) {
      throw new Error("The extension signed with a different key");
    }
    return event;
  }
  if (current.mode === "remote") {
    return await signRemote(template, current.pubkey);
  }
  const secret = read(SECRET_KEY);
  if (!secret) throw new Error("The stored secret key is missing");
  return finalizeEvent(template, hexToBytes(secret));
}

/** Sign `template` and publish it to the node's relay. Returns the event. */
export async function publish(template: EventTemplate): Promise<Event> {
  const event = await signEvent(template);
  await publishToRelay(event);
  return event;
}
