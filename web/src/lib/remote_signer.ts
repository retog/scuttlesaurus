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
  createNostrConnectURI,
  parseBunkerInput,
} from "@nostr/tools/nip46";
import {
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "@nostr/tools/pure";
import { bytesToHex, hexToBytes } from "@nostr/tools/utils";
import { Nip46Channel, Nip46Error } from "./nip46_channel.ts";

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

/**
 * The steps of the connection in plain words, newest last, for the person to
 * read on a phone when something does not work: relay connected, subscribed,
 * a message arrived, why it could not be read, signer connected. It holds no
 * secrets and no decrypted payloads.
 */
export const connectionLog = signal<string[]>([]);

let logStart = Date.now();

function logStep(text: string): void {
  const seconds = Math.round((Date.now() - logStart) / 1000);
  connectionLog.value = [...connectionLog.value, `+${seconds}s ${text}`]
    .slice(-40);
}

function resetLog(): void {
  logStart = Date.now();
  connectionLog.value = [];
}

/**
 * Set while a `nostrconnect://` link waits and the page was away for longer
 * than relays keep an answer: nothing arrived, and an answer sent meanwhile
 * may be lost, so the person is told to start again.
 */
export const connectGap = signal<string | undefined>(undefined);

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
  channel?: Nip46Channel;
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
 * returns `undefined`. `http(s)://` is converted. A bare host gets `wss://`,
 * except where that cannot work: an IP address, `localhost`, or the host of
 * this page when the page itself is served without TLS get `ws://`.
 */
export function normalizeRelayInput(
  input: string,
  page: { protocol: string; host: string } | undefined = globalThis.location,
): string | undefined {
  let text = input.trim();
  if (!text) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/?#]/)[0].toLowerCase();
    const name = host.replace(/:\d+$/, "");
    const plain = isLoopbackHost(host) ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
      name.startsWith("[") ||
      (page?.protocol === "http:" && host === page.host.toLowerCase());
    text = `${plain ? "ws" : "wss"}://${text}`;
  }
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

/** A `nostrconnect://` connection attempt waiting for the signer. */
export interface PendingConnection {
  /** The `nostrconnect://` URI to show as a link and a QR code. Contains the secret. */
  uri: string;
  /** Settles when the signer has answered and the user's key is known. */
  done: Promise<RemoteConnectionData>;
  /** Gives up and discards the connection key. */
  cancel(): void;
}

/** How long to try before saying the relay cannot be reached at all. */
const UNREACHABLE_AFTER_MS = 10_000;

/**
 * Starts the client-initiated flow of NIP-46 on `relay`: generates a fresh
 * client key and a secret, builds the URI asking for permission to sign the
 * kinds in {@link SIGNED_KINDS}, and waits for the signer's `connect` answer
 * (its `result` must be the secret). The wait survives the browser being in
 * the background while the signer app is in front: see `nip46_channel.ts`.
 * Then asks `get_public_key` (the signer's key is not necessarily the user's).
 * `done` rejects with a {@link RemoteSignerError} when cancelled, when the relay
 * cannot be reached, or when no signer answers within {@link CONNECT_WAIT_MS}.
 */
export function startNostrConnect(relay: string): PendingConnection {
  resetLog();
  connectGap.value = undefined;
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
  const channel = new Nip46Channel({
    clientSecret,
    relays: [relay],
    log: logStep,
    onAuth: showAuthUrl,
    onGap: (seconds) => {
      connectGap.value =
        `Nothing arrived while this page was away for ${seconds} seconds, and an answer sent in that time may be lost. If the app says it is connected, start again.`;
    },
  });
  const abort = new AbortController();
  let endedBy: "cancel" | "unreachable" | "timeout" | undefined;
  const end = (reason: typeof endedBy) => {
    endedBy ??= reason;
    abort.abort();
  };
  signerState.value = "connecting";
  channel.start();
  const waitTimer = setTimeout(() => end("timeout"), CONNECT_WAIT_MS);
  // Only time with the page in front counts: while the signer app is in
  // front the browser may hold the socket back, which says nothing about the
  // relay.
  let reachTimer: ReturnType<typeof setTimeout> | undefined;
  const armReachTimer = () => {
    clearTimeout(reachTimer);
    if (globalThis.document?.visibilityState === "hidden") return;
    const armedAt = Date.now();
    reachTimer = setTimeout(() => {
      if (channel.everConnected) return;
      // A timer that fires late was held back while the page was suspended.
      if (Date.now() - armedAt > UNREACHABLE_AFTER_MS + 2_000) armReachTimer();
      else end("unreachable");
    }, UNREACHABLE_AFTER_MS);
  };
  armReachTimer();
  globalThis.document?.addEventListener("visibilitychange", armReachTimer);

  const done = (async () => {
    try {
      const signerPubkey = await channel.awaitConnect(secret, abort.signal);
      const userPubkey = await channel.request(
        "get_public_key",
        [],
        REQUEST_TIMEOUT_MS,
      );
      const data: RemoteConnectionData = {
        clientSecretKey: bytesToHex(clientSecret),
        signerPubkey,
        relays: [relay],
        userPubkey: checkedPubkey(userPubkey),
      };
      adopt({ data, channel });
      return data;
    } catch (error) {
      channel.close();
      signerState.value = active ? "ready" : "idle";
      if (endedBy === "cancel") {
        throw new RemoteSignerError("Cancelled.", "cancelled");
      }
      if (endedBy === "unreachable") {
        throw new RemoteSignerError(
          `Cannot reach the relay ${relay} that carries the link. ` +
            "Check your connection, or use another relay.",
          "unreachable",
        );
      }
      if (endedBy === "timeout") {
        throw new RemoteSignerError(
          "No signer answered the link in five minutes. Check that the " +
            `signer app is online and uses the relay ${
              describeRelays([relay])
            }, then try again. The details below show what arrived.`,
          "timeout",
        );
      }
      throw explain(error, [relay], "connect");
    } finally {
      clearTimeout(waitTimer);
      clearTimeout(reachTimer);
      globalThis.document?.removeEventListener(
        "visibilitychange",
        armReachTimer,
      );
      connectGap.value = undefined;
    }
  })();

  return { uri, done, cancel: () => end("cancel") };
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
  const relays = pointer.relays.map((r) => normalizeRelayInput(r)).filter((r) =>
    r !== undefined
  );
  if (relays.length === 0) {
    throw new RemoteSignerError(
      "That address names no relay, so there is nowhere to reach the signer.",
      "rejected",
    );
  }
  resetLog();
  const clientSecret = generateSecretKey();
  const channel = new Nip46Channel({
    clientSecret,
    relays,
    peer: pointer.pubkey,
    log: logStep,
    onAuth: showAuthUrl,
  });
  signerState.value = "connecting";
  channel.start();
  const aborted = new Promise<never>((_, reject) => {
    options.signal?.addEventListener(
      "abort",
      () => reject(new RemoteSignerError("Cancelled.", "cancelled")),
      { once: true },
    );
  });
  aborted.catch(() => {});
  try {
    // NIP-46 `connect`: [signer pubkey, secret, permissions].
    await Promise.race([
      channel.request(
        "connect",
        [pointer.pubkey, pointer.secret ?? "", REQUESTED_PERMISSIONS.join(",")],
        REQUEST_TIMEOUT_MS,
      ),
      aborted,
    ]);
    logStep("signer connected");
    const userPubkey = await Promise.race([
      channel.request("get_public_key", [], REQUEST_TIMEOUT_MS),
      aborted,
    ]);
    const data: RemoteConnectionData = {
      clientSecretKey: bytesToHex(clientSecret),
      signerPubkey: pointer.pubkey,
      relays,
      userPubkey: checkedPubkey(userPubkey),
    };
    adopt({ data, channel });
    return data;
  } catch (error) {
    channel.close();
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
    await ensureChannel(current).request("ping", [], PING_WAIT_MS);
    if (active === current) signerState.value = "ready";
  } catch {
    if (active === current) signerState.value = "unreachable";
  }
}

function ensureChannel(current: Active): Nip46Channel {
  if (!current.channel) {
    resetLog();
    current.channel = new Nip46Channel({
      clientSecret: hexToBytes(current.data.clientSecretKey),
      relays: current.data.relays,
      peer: current.data.signerPubkey,
      log: logStep,
      onAuth: showAuthUrl,
    });
    current.channel.start();
  }
  return current.channel;
}

/** Turns a channel or signer error into one that explains itself. */
function explain(
  error: unknown,
  relays: string[],
  doing: "sign" | "connect",
): RemoteSignerError {
  if (error instanceof RemoteSignerError) return error;
  const where = describeRelays(relays);
  if (error instanceof Nip46Error) {
    switch (error.kind) {
      case "timeout":
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
      case "send":
        return new RemoteSignerError(
          `Cannot reach the relay ${where} that connects to your signer app. ` +
            "Check your connection and try again.",
          "unreachable",
        );
      case "closed":
        return new RemoteSignerError("Signing was cancelled.", "cancelled");
      case "rejected": {
        const reason = error.message.trim();
        return new RemoteSignerError(
          doing === "sign"
            ? `Your signer app did not sign this${reason ? `: ${reason}` : "."}`
            : `The signer refused the connection${
              reason ? `: ${reason}` : "."
            }`,
          "rejected",
        );
      }
    }
  }
  return new RemoteSignerError(
    error instanceof Error ? error.message : String(error),
    "rejected",
  );
}

/**
 * Signs `template` through the remote signer as `expectedPubkey`. Shows the
 * wait in {@link pendingSignatures}. The request is sent once and never
 * resent: if the connection drops or the page is in the background meanwhile,
 * the channel reconnects and picks the answer up from the relay (see
 * `nip46_channel.ts`), so the person is not asked twice. Throws a
 * {@link RemoteSignerError}.
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
    const raw = await ensureChannel(current).request(
      "sign_event",
      [JSON.stringify(template)],
      REQUEST_TIMEOUT_MS,
    );
    let event: Event;
    try {
      event = JSON.parse(raw) as Event;
    } catch {
      throw new RemoteSignerError(
        "The signer returned something that is not an event.",
        "rejected",
      );
    }
    if (!verifyEvent(event)) {
      throw new RemoteSignerError(
        "The signer returned an event with a bad signature, so it was not used.",
        "rejected",
      );
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
      await ensureChannel(current).request("logout", [], LOGOUT_WAIT_MS);
    } catch {
      // not acknowledged: the connection is closed below anyway
    }
    current.channel?.close();
  })();
}
