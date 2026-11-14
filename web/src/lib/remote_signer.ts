/**
 * Remote signing with NIP-46 "Nostr Connect": the user's key stays in a signer
 * app (Amber and others); this browser only holds a *client key* of its own and
 * exchanges encrypted kind 24133 events with the signer over a relay.
 *
 * Two ways to connect, both ending in a {@link RemoteConnectionData}:
 * - {@link startNostrConnect}: the client shows a `nostrconnect://` URI (link
 *   or QR code) and the signer answers it.
 * - {@link connectBunker}: the person pastes a `bunker://` address (or a NIP-05
 *   `name@domain`) the signer produced.
 *
 * Afterwards {@link signRemote} signs through the live signer, rebuilding the
 * connection when it was lost, and {@link disconnectRemote} signs out. The
 * module has no UI; it exposes signals ({@link pendingSignatures},
 * {@link signerAuthUrl}, {@link signerState}) for the components to show.
 *
 * Security: the client secret key is stored in localStorage by `session.ts`
 * like the other session data, readable by any script on this origin. It can
 * only ask the signer, which decides per request; it is not the user's key.
 * Nothing here logs decrypted NIP-46 payloads or `nostrconnect://` / `bunker://`
 * secrets.
 *
 * @module
 */
import { computed, signal } from "@preact/signals";
import type { Event, EventTemplate } from "@nostr/tools/core";
import {
  type BunkerPointer,
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
} from "@nostr/tools/nip46";
import { SimplePool } from "@nostr/tools/pool";
import { generateSecretKey, getPublicKey } from "@nostr/tools/pure";
import { bytesToHex, hexToBytes } from "@nostr/tools/utils";

/** What is kept in the browser to reconnect to the signer without asking. */
export interface RemoteConnectionData {
  /** Hex secret key of this browser's connection (not the user's key). */
  clientSecretKey: string;
  /** Hex public key of the remote signer (the "bunker"); may differ from the user's. */
  signerPubkey: string;
  /** Relays that carry the connection. */
  relays: string[];
  /** Hex public key of the user, as answered by `get_public_key`. */
  userPubkey: string;
}

/** Whether the signer answered, as far as this page knows. */
export type SignerState = "idle" | "connecting" | "ready" | "unreachable";

/** A signature that has been asked for and not yet answered. */
export interface PendingSignature {
  id: number;
  /** Plain-words description, such as "a note". */
  what: string;
  startedAt: number;
}

/** A relay people can use when the node is not reachable from their phone. */
export const SUGGESTED_RELAY = "wss://relay.nsec.app/";

/** Name shown by the signer app when it asks about this connection. */
export const CLIENT_NAME = "Scuttlesaurus";

/**
 * How long one request may wait for the signer. The library default is 30 s,
 * which is short when a person has to notice the notification, unlock the
 * phone and tap. 60 s covers that and still fails within a minute when the
 * signer is gone. A signer that asks the person to open an `auth_url` gets the
 * library's longer authorization timeout (5 minutes) instead.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** How long a new `nostrconnect://` link waits for the signer to answer. */
export const CONNECT_WAIT_MS = 5 * 60_000;

/** How long sign-out waits for the signer to acknowledge `logout`. */
const LOGOUT_WAIT_MS = 4_000;

/** How long the background check after a reload waits for a `ping`. */
const PING_WAIT_MS = 10_000;

/**
 * Event kinds this client signs, for the `perms` of the connection URI so that
 * a signer can remember an approval per kind: profile (0), note (1), follow
 * list (3), deletion (5), repost (6), reaction (7), comment (1111), relay list
 * (10002), Blossom authorization (24242), NIP-98 HTTP authorization (27235),
 * article (30023) and draft (30024).
 */
export const SIGNED_KINDS: readonly number[] = [
  0,
  1,
  3,
  5,
  6,
  7,
  1111,
  10002,
  24242,
  27235,
  30023,
  30024,
];

/** The permissions requested from the signer: `sign_event:<kind>` for each. */
export const REQUESTED_PERMISSIONS: readonly string[] = SIGNED_KINDS.map(
  (kind) => `sign_event:${kind}`,
);

/** Plain-words names of the kinds, for the "waiting" message. */
const KIND_NAMES: Record<number, string> = {
  0: "a profile",
  1: "a note",
  3: "a follow list",
  5: "a deletion",
  6: "a repost",
  7: "a reaction",
  1111: "a comment",
  10002: "a relay list",
  24242: "an upload",
  27235: "a node request",
  30023: "an article",
  30024: "a draft",
};

/** Signatures waiting for the signer. Empty when nothing is outstanding. */
export const pendingSignatures = signal<PendingSignature[]>([]);

/**
 * A page the signer asks the person to open (NIP-46 `auth_url`), or
 * `undefined`. Cleared when the request it belongs to finishes.
 */
export const signerAuthUrl = signal<string | undefined>(undefined);

/** Whether the signer has answered lately. */
export const signerState = signal<SignerState>("idle");

/** Relays and signer of the current remote session; no secret in it. */
export const remoteInfo = signal<
  { relays: string[]; signerPubkey: string } | null
>(null);

/** Whether a remote session is active in this page. */
export const hasRemote = computed(() => remoteInfo.value !== null);

/** An error whose message is meant for the person. */
export class RemoteSignerError extends Error {
  constructor(
    message: string,
    /** Why: the signer said no, did not answer, or the relay is not reachable. */
    readonly reason: "rejected" | "timeout" | "unreachable" | "cancelled",
  ) {
    super(message);
    this.name = "RemoteSignerError";
  }
}

interface Active {
  data: RemoteConnectionData;
  signer?: BunkerSigner;
  pool?: SimplePool;
}

let active: Active | undefined;
let counter = 0;

function describeRelays(relays: string[]): string {
  return relays.map((r) => r.replace(/^wss?:\/\//, "").replace(/\/$/, ""))
    .join(", ");
}

/** Whether a host name is this machine: `localhost`, `*.localhost`, 127.x, ::1. */
export function isLoopbackHost(host: string): boolean {
  const bracketed = host.match(/^\[([^\]]*)\]/);
  const name = (bracketed ? bracketed[1] : host.replace(/:\d+$/, ""))
    .toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") ||
    name === "::1" || /^127(\.\d{1,3}){3}$/.test(name) || name === "0.0.0.0";
}

/**
 * Normalizes what a person typed as a relay into a `ws://` or `wss://` URL, or
 * returns `undefined`. A bare host gets `wss://`; `http(s)://` is converted.
 */
export function normalizeRelayInput(input: string): string | undefined {
  let text = input.trim();
  if (!text) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `wss://${text}`;
  text = text.replace(/^http(s?):\/\//i, "ws$1://");
  try {
    const url = new URL(text);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
    if (!url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** What to offer for the relay of a `nostrconnect://` link. */
export interface RelayChoice {
  /** The relay to use without asking, or `undefined` when the person must choose. */
  relay: string | undefined;
  /** Why the person must choose: this page is not reachable from another device. */
  reason?: string;
}

/**
 * The default relay for a client-initiated connection: this node's own relay
 * (`relayUrl` of `/api/status`). When the page is opened on `localhost` or a
 * loopback address a signer on another device cannot reach it, so there is no
 * default and the person has to enter a relay.
 */
export function chooseRelay(
  nodeRelayUrl: string | undefined,
  pageHost: string,
): RelayChoice {
  const loopback = isLoopbackHost(pageHost) ||
    (nodeRelayUrl !== undefined &&
      isLoopbackHost(new URL(nodeRelayUrl.replace(/^ws/, "http")).host));
  if (loopback || !nodeRelayUrl) {
    return {
      relay: undefined,
      reason: loopback
        ? "This page was opened on this machine (localhost), so a signer on " +
          "your phone cannot reach this node's relay. Enter a relay that both " +
          "can reach."
        : "This node's relay address is not known. Enter a relay both can reach.",
    };
  }
  return { relay: normalizeRelayInput(nodeRelayUrl) ?? nodeRelayUrl };
}

function newPool(): SimplePool {
  // Reconnect and ping keep the subscription for answers alive on a phone
  // that switches networks; the library re-subscribes after a reconnect.
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  // The pool closes a relay after 20 s without an operation of its own, even
  // with a subscription open. We wait for a person to tap in a signer app, so
  // the answer would then be lost; keep the connection until we close it.
  pool.idleTimeout = 0;
  return pool;
}

/** A `nostrconnect://` connection attempt waiting for the signer. */
export interface PendingConnection {
  /** The `nostrconnect://` URI to show as a link and a QR code. Contains the secret. */
  uri: string;
  /** Settles when the signer has answered and the user's key is known. */
  done: Promise<RemoteConnectionData>;
  /** Gives up and discards the connection key. */
  cancel(): void;
}

/**
 * Starts the client-initiated flow of NIP-46 on `relay`: generates a fresh
 * client key and a secret, builds the URI asking for permission to sign the
 * kinds in {@link SIGNED_KINDS}, and waits for the signer's `connect` answer.
 * Then asks `get_public_key` (the signer's key is not necessarily the user's).
 * `done` rejects with a {@link RemoteSignerError} when cancelled or the signer
 * does not answer within {@link CONNECT_WAIT_MS}.
 */
export function startNostrConnect(relay: string): PendingConnection {
  const clientSecret = generateSecretKey();
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientSecret),
    relays: [relay],
    secret,
    perms: [...REQUESTED_PERMISSIONS],
    name: CLIENT_NAME,
    url: globalThis.location.origin,
  });
  const abort = new AbortController();
  const pool = newPool();
  let cancelled = false;
  signerState.value = "connecting";

  const done = (async () => {
    let signer: BunkerSigner | undefined;
    try {
      signer = await BunkerSigner.fromURI(
        clientSecret,
        uri,
        {
          pool,
          timeout: REQUEST_TIMEOUT_MS,
          onauth: showAuthUrl,
          // The relays stay the ones in the link and in storage.
          skipSwitchRelays: true,
        },
        abort.signal,
      );
      const userPubkey = await signer.getPublicKey();
      const data: RemoteConnectionData = {
        clientSecretKey: bytesToHex(clientSecret),
        signerPubkey: signer.bp.pubkey,
        relays: signer.bp.relays,
        userPubkey: checkedPubkey(userPubkey),
      };
      adopt({ data, signer, pool });
      return data;
    } catch (error) {
      await signer?.close().catch(() => {});
      pool.close([relay]);
      signerState.value = active ? "ready" : "idle";
      if (cancelled) throw new RemoteSignerError("Cancelled.", "cancelled");
      if (abort.signal.aborted) {
        throw new RemoteSignerError(
          "No signer answered the link in five minutes. Check that the " +
            `signer app is online and uses the relay ${
              describeRelays([relay])
            }, then try again.`,
          "timeout",
        );
      }
      throw explain(error, [relay], "connect");
    }
  })();
  // Wait limit, as `fromURI` takes an abort signal rather than both.
  const timer = setTimeout(() => abort.abort(), CONNECT_WAIT_MS);
  done.then(() => clearTimeout(timer), () => clearTimeout(timer));

  return {
    uri,
    done,
    cancel() {
      cancelled = true;
      abort.abort();
    },
  };
}

/**
 * Connects with a `bunker://` address or a NIP-05 `name@domain` the signer
 * produced (signer-initiated flow): the relays come from the address and the
 * browser connects to them directly. Sends `connect` with the permissions in
 * {@link REQUESTED_PERMISSIONS}, then `get_public_key`.
 */
export async function connectBunker(
  input: string,
  options: { signal?: AbortSignal } = {},
): Promise<RemoteConnectionData> {
  const text = input.trim();
  if (!/^bunker:\/\//i.test(text) && !/^[^\s@]+@[^\s@]+$/.test(text)) {
    throw new RemoteSignerError(
      "That is not a bunker address. It starts with bunker:// or looks like name@domain.",
      "rejected",
    );
  }
  let pointer: BunkerPointer | null;
  try {
    pointer = await parseBunkerInput(text);
  } catch {
    pointer = null;
  }
  if (!pointer || !/^[0-9a-f]{64}$/.test(pointer.pubkey)) {
    throw new RemoteSignerError(
      "Could not read that address. Copy it again from your signer app.",
      "rejected",
    );
  }
  const relays = pointer.relays.map(normalizeRelayInput).filter((r) =>
    r !== undefined
  );
  if (relays.length === 0) {
    throw new RemoteSignerError(
      "That address names no relay, so there is nowhere to reach the signer.",
      "rejected",
    );
  }
  const clientSecret = generateSecretKey();
  const pool = newPool();
  signerState.value = "connecting";
  let signer: BunkerSigner | undefined;
  try {
    signer = BunkerSigner.fromBunker(
      clientSecret,
      { pubkey: pointer.pubkey, relays, secret: pointer.secret },
      { pool, timeout: REQUEST_TIMEOUT_MS, onauth: showAuthUrl },
    );
    // NIP-46 `connect`: [signer pubkey, secret, permissions]. The library's
    // own connect() cannot send the permissions.
    const sending = signer.sendRequest("connect", [
      pointer.pubkey,
      pointer.secret ?? "",
      REQUESTED_PERMISSIONS.join(","),
    ]);
    const aborted = new Promise<never>((_, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new RemoteSignerError("Cancelled.", "cancelled")),
        { once: true },
      );
    });
    await Promise.race([sending, aborted]);
    const userPubkey = await signer.getPublicKey();
    const data: RemoteConnectionData = {
      clientSecretKey: bytesToHex(clientSecret),
      signerPubkey: pointer.pubkey,
      relays,
      userPubkey: checkedPubkey(userPubkey),
    };
    adopt({ data, signer, pool });
    return data;
  } catch (error) {
    await signer?.close().catch(() => {});
    pool.close(relays);
    signerState.value = active ? "ready" : "idle";
    if (error instanceof RemoteSignerError) throw error;
    throw explain(error, relays, "connect");
  }
}

function checkedPubkey(value: string): string {
  const pubkey = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new RemoteSignerError(
      "The signer did not return a valid public key.",
      "rejected",
    );
  }
  return pubkey;
}

function showAuthUrl(url: string): void {
  // Only an http(s) page may be offered as a link.
  signerAuthUrl.value = /^https?:\/\//i.test(url) ? url : undefined;
}

function adopt(next: Active): void {
  active = next;
  remoteInfo.value = {
    relays: next.data.relays,
    signerPubkey: next.data.signerPubkey,
  };
  signerState.value = "ready";
}

/**
 * Makes `data` (read back from storage after a page reload) the active remote
 * session without contacting the signer. The connection is built on the first
 * signature, or by {@link warmUpRemote}.
 */
export function restoreRemote(data: RemoteConnectionData): void {
  if (active?.data.clientSecretKey === data.clientSecretKey) return;
  active = { data };
  remoteInfo.value = { relays: data.relays, signerPubkey: data.signerPubkey };
  signerState.value = "idle";
}

/**
 * Connects to the relay in the background after a reload and sends a `ping`,
 * so that a signer that cannot be reached shows up before the first
 * signature. Never throws; the result is {@link signerState}.
 */
export async function warmUpRemote(): Promise<void> {
  const current = active;
  if (!current || signerState.value === "ready") return;
  signerState.value = "connecting";
  try {
    const signer = ensureSigner(current);
    await withTimeout(signer.ping(), PING_WAIT_MS);
    if (active === current) signerState.value = "ready";
  } catch {
    if (active === current) signerState.value = "unreachable";
  }
}

function ensureSigner(current: Active): BunkerSigner {
  if (current.signer) return current.signer;
  current.pool = newPool();
  current.signer = BunkerSigner.fromBunker(
    hexToBytes(current.data.clientSecretKey),
    {
      pubkey: current.data.signerPubkey,
      relays: current.data.relays,
      secret: null,
    },
    { pool: current.pool, timeout: REQUEST_TIMEOUT_MS, onauth: showAuthUrl },
  );
  return current.signer;
}

async function dropSigner(current: Active): Promise<void> {
  const { signer, pool } = current;
  current.signer = undefined;
  current.pool = undefined;
  await signer?.close().catch(() => {});
  pool?.close(current.data.relays);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`nostr-tools/nip46: timeout after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Library failures that mean the request never left this page. */
const SEND_FAILURE = /failed to send|not open anymore|no relay was tried/i;

/** Library failures that mean the connection to the relay was lost or never came up. */
const CONNECTION_LOST =
  /subscription to the remote signer was closed|subscription closed before connection/i;

/** Turns a library or signer error into one that explains itself. */
function explain(
  error: unknown,
  relays: string[],
  doing: "sign" | "connect",
): RemoteSignerError {
  if (error instanceof RemoteSignerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const where = describeRelays(relays);
  if (/timeout after/i.test(message)) {
    return new RemoteSignerError(
      doing === "sign"
        ? `Your signer app did not answer in ${
          REQUEST_TIMEOUT_MS / 1000
        } seconds. Open it, check that it is running and online (relay ${where}), then try again.`
        : `The signer did not answer in ${
          REQUEST_TIMEOUT_MS / 1000
        } seconds. Check the address and that the signer is online, then try again.`,
      "timeout",
    );
  }
  if (/nip46: signer was closed/i.test(message)) {
    return new RemoteSignerError("Signing was cancelled.", "cancelled");
  }
  if (SEND_FAILURE.test(message) || CONNECTION_LOST.test(message)) {
    return new RemoteSignerError(
      doing === "sign" && CONNECTION_LOST.test(message)
        ? `The connection to the relay ${where} was lost while waiting for ` +
          "your signer app. Try again."
        : `Cannot reach the relay ${where} that connects to your signer app. ` +
          "Check your connection and try again.",
      "unreachable",
    );
  }
  if (/requires auth/i.test(message)) {
    return new RemoteSignerError(
      "Your signer needs you to sign in on its page first.",
      "rejected",
    );
  }
  if (/improperly signed/i.test(message)) {
    return new RemoteSignerError(
      "The signer returned an event with a bad signature, so it was not used.",
      "rejected",
    );
  }
  // Anything else is the signer's own refusal.
  const reason = message.replace(/^nostr-tools\/nip46:\s*/, "").trim();
  return new RemoteSignerError(
    doing === "sign"
      ? `Your signer app did not sign this${reason ? `: ${reason}` : "."}`
      : `The signer refused the connection${reason ? `: ${reason}` : "."}`,
    "rejected",
  );
}

/**
 * Signs `template` through the remote signer as `expectedPubkey`. Shows the
 * wait in {@link pendingSignatures}. When the request could not be sent (the
 * connection went stale, say after the page slept) the signer is rebuilt and
 * the request sent once more. When the connection was lost while waiting, the
 * signer is rebuilt for the next attempt but the request is not repeated, so
 * the person is not asked twice. Throws a {@link RemoteSignerError}.
 */
export async function signRemote(
  template: EventTemplate,
  expectedPubkey: string,
): Promise<Event> {
  const current = active;
  if (!current) {
    throw new RemoteSignerError(
      "The connection to your signer app is not set up. Sign in again.",
      "unreachable",
    );
  }
  const entry: PendingSignature = {
    id: ++counter,
    what: KIND_NAMES[template.kind] ?? `an event of kind ${template.kind}`,
    startedAt: Date.now(),
  };
  pendingSignatures.value = [...pendingSignatures.value, entry];
  try {
    let event: Event;
    try {
      event = await ensureSigner(current).signEvent(template);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (CONNECTION_LOST.test(message)) await dropSigner(current);
      if (!SEND_FAILURE.test(message)) throw error;
      // The request did not leave this page (a stale connection after the
      // page slept, say): reconnect once and send it again. The signer has
      // not seen it, so the person is not asked twice.
      await dropSigner(current);
      event = await ensureSigner(current).signEvent(template);
    }
    if (event.pubkey !== expectedPubkey) {
      throw new RemoteSignerError(
        "The signer signed with a different key than the one you signed in with.",
        "rejected",
      );
    }
    if (active === current) signerState.value = "ready";
    return event;
  } catch (error) {
    const explained = explain(error, current.data.relays, "sign");
    if (active === current && explained.reason === "unreachable") {
      signerState.value = "unreachable";
    }
    throw explained;
  } finally {
    pendingSignatures.value = pendingSignatures.value.filter((p) =>
      p.id !== entry.id
    );
    if (pendingSignatures.value.length === 0) signerAuthUrl.value = undefined;
  }
}

/**
 * Ends the remote session: forgets it at once, then (without making the
 * caller wait) tells the signer with NIP-46 `logout`, closes the connection and
 * drops the client key. The signer may not know `logout`; that is not an error.
 */
export function disconnectRemote(): void {
  const current = active;
  active = undefined;
  remoteInfo.value = null;
  signerState.value = "idle";
  signerAuthUrl.value = undefined;
  if (!current) return;
  void (async () => {
    try {
      await withTimeout(ensureSigner(current).logout(), LOGOUT_WAIT_MS);
    } catch {
      // not acknowledged: the connection is closed below anyway
    }
    await dropSigner(current);
  })();
}
