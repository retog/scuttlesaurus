/**
 * A wrapper around an RPC connection that keeps track of issued feed requests and incoming responses.
 * This class allows to set a timeout on responses so that connections that do provide new messages are closed.
 */

import RpcConnection from "../../comm/rpc/RpcConnection.ts";
import FeedsStorage from "../../storage/FeedsStorage.ts";
import {
  computeMsgHash,
  delay,
  FeedId,
  fromBase64,
  log,
  sodium,
  toBase64,
} from "../../util.ts";
import { Message } from "./FeedsAgent.ts";

const textEncoder = new TextEncoder();

export class FeedsConnection {
  syncingFeeds: FeedId[] = [];
  timeoutClockStart = Date.now();
  timeoutMonitor?: Promise<unknown>;

  constructor(
    public rpcConnection: RpcConnection,
    opts?: {
      signal?: AbortSignal;
      newMessageTimeout?: number;
    },
  ) {
    if (opts?.newMessageTimeout) {
      this.timeoutMonitor = (async () => {
        try {
          while (!opts?.signal?.aborted && Date.now() < this.timeoutClockStart+opts?.newMessageTimeout!) {
            await delay(opts?.newMessageTimeout!, {
              signal: opts?.signal,
            });
          }
        } catch(_error) {
          //aborted
        }
        rpcConnection.boxConnection.close();
      })();
    }
  }

  async syncFeed(
    feedId: FeedId,
    store: FeedsStorage,
    fireNewMessageEvent: (f: FeedId, m: Message) => void,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    this.timeoutClockStart = Date.now();
    const from = await store.lastMessage(feedId) + 1;
    let expectedSequence = from;
    for await (
      const msg of this.getFeed(feedId, from, opts?.signal)
    ) {
      if (expectedSequence !== msg.value.sequence) {
        throw new Error(
          `Expected sequence ${expectedSequence} but got ${msg.value.sequence}`,
        );
      }
      expectedSequence++;
      const hash = computeMsgHash(msg.value);
      const key = `%${toBase64(hash)}.sha256`;
      if (key !== msg.key) {
        throw new Error(
          "Computed hash doesn't match key " +
            JSON.stringify(msg, undefined, 2),
        );
      }
      if (
        !verifySignature(msg.value)
      ) {
        throw Error(
          `failed to verify signature of the message: ${
            JSON.stringify(msg.value, undefined, 2)
          }`,
        );
      }
      if (msg.value.sequence > 1) {
        const previousMessage = await store.getMessage(
          feedId,
          msg.value.sequence - 1,
        );
        if (previousMessage.key !== msg.value.previous) {
          throw new Error(
            `Broken Crypto-Chain in ${feedId} at ${msg.value.sequence}`,
          );
        }
      }

      try {
        await store.storeMessage(
          feedId,
          msg.value.sequence,
          msg,
        );
        fireNewMessageEvent(feedId, msg);
        this.timeoutClockStart = Date.now();
      } catch (e) {
        log.debug(`Storing message: ${e}`);
      }
    }
    log.debug(() => `Stream ended for feed ${feedId}`);
  }

  private async *getFeed(feedId: FeedId, from: number, signal?: AbortSignal) {
    this.syncingFeeds.push(feedId);
    const baseIterable = await this.rpcConnection.sendSourceRequest({
      "name": ["createHistoryStream"],
      "args": [{
        "id": feedId.toString(),
        "sequence": from,
        "live": true,
      }],
    }, signal) as AsyncIterable<Message>;
    for await (const msg of baseIterable) {
      yield msg;
    }
    console.warn("Live stream ended");
  }
}

export function verifySignature(msg: { author: string; signature?: string }) {
  if (!msg.signature) {
    throw Error("no signature in messages");
  }
  const signatureString = msg.signature;
  const signature = fromBase64(
    signatureString.substring(
      0,
      signatureString.length - ".sig.ed25519".length,
    ),
  );
  const authorsPubkicKey = fromBase64(
    msg.author.substring(1, msg.author.length - ".ed25519".length),
  );
  delete msg.signature;
  const verifyResult = sodium.crypto_sign_verify_detached(
    signature,
    textEncoder.encode(JSON.stringify(msg, undefined, 2)),
    authorsPubkicKey,
  );
  msg.signature = signatureString;
  return verifyResult;
}
