/**
 * Identity: who is using the client and how events get signed.
 *
 * Three modes: `extension` (NIP-07 `window.nostr`), `local` (a secret key kept
 * in this browser's localStorage, readable by any script on this origin) and
 * `readonly` (a public key only).
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

/** How the current identity signs. */
export type SessionMode = "extension" | "local" | "readonly";

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

function load(): Session | null {
  try {
    const parsed = JSON.parse(read(SESSION_KEY) ?? "null") as Session | null;
    if (!parsed || !/^[0-9a-f]{64}$/.test(parsed.pubkey)) return null;
    if (parsed.mode === "local" && !read(SECRET_KEY)) return null;
    if (!["extension", "local", "readonly"].includes(parsed.mode)) return null;
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
  write(SECRET_KEY, null);
  const next: Session = { pubkey, mode: "extension" };
  setSession(next);
  return next;
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
  write(SECRET_KEY, null);
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

/** Forget the identity (and a locally stored secret key). */
export function logout(): void {
  write(SECRET_KEY, null);
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
