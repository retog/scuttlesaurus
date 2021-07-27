import * as FSStorage from "./fsStorage.ts";
import { computeMsgHash, toBase64, verifySignature } from "./util.ts";
import RPCConnection, { EndOfStream } from "./RPCConnection.ts";

const textEncoder = new TextEncoder();
const configDir = Deno.env.get("HOME") + "/.ssb/";
const followeesFile = configDir + "followees.json";

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
  feedKey: string,
) {
  console.log(`Updating Feed ${feedKey}`);
  const messagesAlreadyHere = await FSStorage.lastMessage(feedKey);
  const historyStream = await rpcConnection.sendSourceRequest({
    "name": ["createHistoryStream"],
    "args": [{
      "id": `@${feedKey}.ed25519`,
      "seq": messagesAlreadyHere > 0 ? messagesAlreadyHere : 1,
    }],
  });
  return (async () => {
    const feedDir = FSStorage.getFeedDir(feedKey);
    await Deno.mkdir(feedDir, { recursive: true });
    while (true) {
      try {
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
        /*console.log(
                  JSON.stringify(msg, undefined, 2),
                );*/
      } catch (err) {
        if (err instanceof EndOfStream) {
          console.error("Stream ended");
        } else {
          console.error(err);
        }
      }
    }
  })();
}

export function updateFeeds(rpcConnection: RPCConnection) {
  function strip(feedId: string) {
    if (feedId.startsWith("@") && feedId.endsWith(".ed25519")) {
      return feedId.substring(1, feedId.length - 8);
    } else {
      console.log(feedId + " doesn't seems to be dressed");
      return feedId;
    }
  }
  return Promise.all(
    subscriptions.map((feed) => updateFeed(rpcConnection, strip(feed))),
  );
}