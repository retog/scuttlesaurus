/**
 * A stand-in NIP-46 remote signer ("Nostr Connect") for developing and testing
 * the web client's remote signing without a phone. It holds a secret key and
 * answers requests over one relay. It is a development tool: it signs
 * whatever it is asked to, without asking anybody.
 *
 * ```
 * deno run -A scripts/fake_signer.ts --nsec nsec1… --connect 'nostrconnect://…'
 * deno run -A scripts/fake_signer.ts --nsec nsec1… --bunker --relay ws://127.0.0.1:7777/
 * ```
 *
 * - `--connect <uri>`: client-initiated flow. Answers the `nostrconnect://`
 *   link the web client shows with a `connect` response carrying its secret,
 *   then serves requests from that client.
 * - `--bunker --relay <url>`: signer-initiated flow. Prints a `bunker://`
 *   address and waits for a client to `connect` with its secret.
 * - `--nsec <nsec|hex>`: the user's key (generated and its npub printed when
 *   omitted). The key that signs the NIP-46 messages is a separate random one,
 *   as real signers have, so that the signer's pubkey differs from the user's;
 *   `--signer-key <nsec|hex>` fixes it (a restarted signer then keeps the
 *   same bunker address).
 * - `--reject`: answer `sign_event` with an error.
 * - `--delay <ms>`: answer every request except `connect` after this delay.
 * - `--auth-url <url>`: answer the first `sign_event` of each client with an
 *   `auth_url` challenge, then complete it two seconds later.
 *
 * Methods: `connect`, `get_public_key`, `ping`, `sign_event`, `logout`. Each
 * request is printed (for `sign_event` the kind and content, which are about
 * to be public); secrets and decrypted payloads otherwise are not. It uses
 * only the primitives of `@nostr/tools`: NIP-44 encryption, `finalizeEvent`
 * and a relay connection.
 *
 * @module
 */
import { parseArgs } from "@std/cli/parse-args";
import { delay } from "@std/async";
import type { Event, EventTemplate } from "@nostr/tools/core";
import * as nip19 from "@nostr/tools/nip19";
import { decrypt, encrypt, getConversationKey } from "@nostr/tools/nip44";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "@nostr/tools/pure";
import { Relay } from "@nostr/tools/relay";
import { bytesToHex, hexToBytes } from "@nostr/tools/utils";

const NOSTR_CONNECT = 24133;

const USAGE =
  `Usage: deno run -A scripts/fake_signer.ts [--nsec <key>] [--signer-key <key>]
         (--connect <nostrconnect://…> | --bunker --relay <ws://…>)
         [--reject] [--delay <ms>] [--auth-url <url>]`;

/** What the signer answers to a request: a result or an error. */
type Answer = { result: string } | { error: string };

interface Options {
  userKey: Uint8Array;
  transportKey: Uint8Array;
  reject: boolean;
  delayMs: number;
  authUrl?: string;
  /** Secret a `connect` must present (bunker flow). */
  bunkerSecret?: string;
}

function parseKey(text: string): Uint8Array {
  if (/^[0-9a-f]{64}$/i.test(text)) return hexToBytes(text.toLowerCase());
  const decoded = nip19.decode(text);
  if (decoded.type !== "nsec") throw new Error("not an nsec");
  return decoded.data;
}

/** One signer instance talking to one relay. */
class FakeSigner {
  readonly #options: Options;
  readonly #relay: Relay;
  readonly #transportPub: string;
  readonly #clients = new Set<string>();
  readonly #challenged = new Set<string>();
  readonly #seen = new Set<string>();

  constructor(relay: Relay, options: Options) {
    this.#relay = relay;
    this.#options = options;
    this.#transportPub = getPublicKey(options.transportKey);
  }

  get transportPubkey(): string {
    return this.#transportPub;
  }

  /** Authorizes a client without a `connect` request (client-initiated flow). */
  authorize(clientPubkey: string): void {
    this.#clients.add(clientPubkey);
  }

  /** Listens for requests addressed to the signer's key. */
  listen(): void {
    this.#relay.subscribe(
      [{
        kinds: [NOSTR_CONNECT],
        "#p": [this.#transportPub],
        since: Math.floor(Date.now() / 1000) - 5,
      }],
      {
        onevent: (event) => void this.#onEvent(event),
      },
    );
  }

  /** Sends a response (or a first message) to `clientPubkey`. */
  async send(clientPubkey: string, payload: object): Promise<void> {
    const key = getConversationKey(this.#options.transportKey, clientPubkey);
    const event = finalizeEvent({
      kind: NOSTR_CONNECT,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", clientPubkey]],
      content: encrypt(JSON.stringify(payload), key),
    }, this.#options.transportKey);
    await this.#relay.publish(event);
  }

  async #onEvent(event: Event): Promise<void> {
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    let request: { id?: string; method?: string; params?: string[] };
    try {
      const key = getConversationKey(this.#options.transportKey, event.pubkey);
      request = JSON.parse(decrypt(event.content, key));
    } catch {
      return; // not for us, or garbage
    }
    const { id, method, params = [] } = request;
    if (typeof id !== "string" || typeof method !== "string") return;
    const who = event.pubkey.slice(0, 8);

    if (method !== "connect" && this.#options.delayMs > 0) {
      console.log(
        `[${who}] ${method}: answering in ${this.#options.delayMs} ms`,
      );
      await delay(this.#options.delayMs);
    }

    const answer = await this.#answer(event.pubkey, method, params, who, id);
    if (answer) await this.send(event.pubkey, { id, ...answer });
  }

  async #answer(
    client: string,
    method: string,
    params: string[],
    who: string,
    id: string,
  ): Promise<Answer | undefined> {
    const userPub = getPublicKey(this.#options.userKey);
    if (method === "connect") {
      const secret = this.#options.bunkerSecret;
      if (secret !== undefined && params[1] !== secret) {
        console.log(`[${who}] connect: refused (wrong or missing secret)`);
        return { error: "invalid secret" };
      }
      this.#clients.add(client);
      const perms = params[2] ? ` permissions: ${params[2]}` : "";
      console.log(`[${who}] connect: accepted${perms}`);
      return { result: params[1] || "ack" };
    }
    if (!this.#clients.has(client)) {
      console.log(`[${who}] ${method}: refused (client not connected)`);
      return { error: "not connected" };
    }
    switch (method) {
      case "ping":
        console.log(`[${who}] ping`);
        return { result: "pong" };
      case "get_public_key":
        console.log(`[${who}] get_public_key`);
        return { result: userPub };
      case "logout":
        console.log(`[${who}] logout: client forgotten`);
        this.#clients.delete(client);
        return { result: "ack" };
      case "sign_event": {
        let template: EventTemplate;
        try {
          template = JSON.parse(params[0]);
        } catch {
          return { error: "invalid event" };
        }
        const content = template.content.length > 60
          ? `${template.content.slice(0, 60)}…`
          : template.content;
        console.log(
          `[${who}] sign_event kind ${template.kind} ${
            JSON.stringify(content)
          }`,
        );
        if (this.#options.authUrl && !this.#challenged.has(client)) {
          this.#challenged.add(client);
          console.log(`[${who}] sign_event: asking for auth_url first`);
          await this.send(client, {
            id,
            result: "auth_url",
            error: this.#options.authUrl,
          });
          await delay(2000);
        }
        if (this.#options.reject) {
          console.log(`[${who}] sign_event: rejected`);
          return { error: "rejected by the user" };
        }
        const signed = finalizeEvent(template, this.#options.userKey);
        return { result: JSON.stringify(signed) };
      }
      default:
        console.log(`[${who}] ${method}: not supported`);
        return { error: `method ${method} is not supported` };
    }
  }
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ["nsec", "signer-key", "connect", "relay", "delay", "auth-url"],
    boolean: ["bunker", "reject", "help"],
  });
  if (args.help || (!args.connect && !args.bunker)) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  if (args.connect && args.bunker) {
    console.error("fake_signer: choose --connect or --bunker, not both");
    return 2;
  }
  const userKey = args.nsec ? parseKey(args.nsec) : generateSecretKey();
  const transportKey = args["signer-key"]
    ? parseKey(args["signer-key"])
    : generateSecretKey();
  const options: Options = {
    userKey,
    transportKey,
    reject: args.reject,
    delayMs: args.delay ? Number(args.delay) : 0,
    authUrl: args["auth-url"] || undefined,
  };
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    console.error("fake_signer: --delay needs a number of milliseconds");
    return 2;
  }
  console.log(`signing as ${nip19.npubEncode(getPublicKey(userKey))}`);
  console.log(
    `signer key ${
      getPublicKey(transportKey).slice(0, 8)
    }… (differs from the user's)`,
  );

  let relayUrl: string;
  let clientPubkey: string | undefined;
  let connectSecret: string | undefined;
  if (args.connect) {
    let uri: URL;
    try {
      uri = new URL(args.connect);
    } catch {
      console.error("fake_signer: --connect needs a nostrconnect:// URI");
      return 2;
    }
    if (uri.protocol !== "nostrconnect:") {
      console.error("fake_signer: --connect needs a nostrconnect:// URI");
      return 2;
    }
    clientPubkey = uri.hostname || uri.pathname.replace(/^\/+/, "");
    connectSecret = uri.searchParams.get("secret") ?? undefined;
    const relays = uri.searchParams.getAll("relay");
    if (!/^[0-9a-f]{64}$/.test(clientPubkey) || !relays.length) {
      console.error("fake_signer: the URI has no client pubkey or relay");
      return 2;
    }
    relayUrl = relays[0];
    console.log(
      `requested permissions: ${uri.searchParams.get("perms") ?? "(none)"}`,
    );
  } else {
    if (!args.relay) {
      console.error("fake_signer: --bunker needs --relay <url>");
      return 2;
    }
    relayUrl = args.relay;
    options.bunkerSecret = bytesToHex(
      crypto.getRandomValues(new Uint8Array(8)),
    );
  }

  const relay = await Relay.connect(relayUrl);
  const closed = new Promise<void>((resolve) =>
    relay.onclose = () => resolve()
  );
  const signer = new FakeSigner(relay, options);
  signer.listen();
  console.log(`connected to ${relayUrl}`);

  if (clientPubkey) {
    signer.authorize(clientPubkey);
    await signer.send(clientPubkey, {
      id: crypto.randomUUID(),
      result: connectSecret,
    });
    console.log("answered the nostrconnect link; waiting for requests");
  } else {
    const url = new URL(`bunker://${signer.transportPubkey}`);
    url.searchParams.append("relay", relayUrl);
    url.searchParams.set("secret", options.bunkerSecret!);
    console.log(`bunker address: ${url.href}`);
    console.log("waiting for a client to connect");
  }
  await closed;
  console.error("fake_signer: the relay closed the connection");
  return 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
