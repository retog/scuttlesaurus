import * as FSStorage from "./fsStorage.ts";
import {
  computeMsgHash,
  FeedId,
  log,
  parseFeedId,
  path,
  toBase64,
  verifySignature,
} from "./util.ts";
import RPCConnection, { EndOfStream } from "./RPCConnection.ts";
import config from "./config.ts";

const textEncoder = new TextEncoder();
const followeesFile = path.join(config.baseDir, "followees.json");

function getFollowees() {
  try {
    return JSON.parse(Deno.readTextFileSync(followeesFile));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }
}
const subscriptions: string[] = getFollowees();

export async function updateFeed(
  rpcConnection: RPCConnection,
  feedKey: FeedId,
) {
  const messagesAlreadyHere = await FSStorage.lastMessage(feedKey);
  try {
    await updateFeedFrom(
      rpcConnection,
      feedKey,
      messagesAlreadyHere > 0 ? messagesAlreadyHere : 1,
    );
  } catch (error) {
    log.info(`error updating feed ${feedKey}: ${error}`);
  }
}

export async function updateFeedFrom(
  rpcConnection: RPCConnection,
  feedKey: FeedId,
  from: number,
) {
  log.debug(`Updating Feed ${feedKey} from ${from}`);
  const historyStream = await rpcConnection.sendSourceRequest({
    "name": ["createHistoryStream"],
    "args": [{
      "id": `@${feedKey}.ed25519`,
      "seq": from,
    }],
  });
  return (async () => {
    const feedDir = FSStorage.getFeedDir(feedKey);
    await Deno.mkdir(feedDir, { recursive: true });
    try {
      while (true) {
        const msg = await historyStream.read() as {
          value: Record<string, string>;
          key: string;
        };
        const hash = computeMsgHash(msg.value);
        const key = `%${toBase64(hash)}.sha256`;
        if (key !== msg.key) {
          throw new Error(
            "Computed hash doesn't match key " +
              JSON.stringify(msg, undefined, 2),
          );
        }
        if (
          !verifySignature(msg.value as { author: string; signature: string })
        ) {
          throw Error(
            `failed to veriy signature of the message: ${
              JSON.stringify(msg.value, undefined, 2)
            }`,
          );
        }
        const msgFile = await Deno.create(
          feedDir + "/" +
            (msg as { value: Record<string, string> }).value!.sequence! +
            ".json",
        );
        await msgFile.write(
          textEncoder.encode(JSON.stringify(msg, undefined, 2)),
        );
        msgFile.close();
        /*log.info(
                  JSON.stringify(msg, undefined, 2),
                );*/
      }
    } catch (err) {
      if (err instanceof EndOfStream) {
        log.debug(() => `Stream ended for feed ${feedKey}`);
      } else {
        log.error(err);
      }
    }
  })();
}

export function updateFeeds(rpcConnection: RPCConnection) {
  return Promise.all(
    subscriptions.map((feed) => updateFeed(rpcConnection, parseFeedId(feed))),
  );
}
