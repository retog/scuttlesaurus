import type { FeedId, JSONValue } from "../util.ts";
import type { Message } from "../agents/feeds/FeedsAgent.ts";

export default interface FeedsStorage {
  /** implementations must throw an error, if a message at that position already exist */
  storeMessage(
    feedKey: FeedId,
    position: number,
    msg: JSONValue,
  ): Promise<void>;

  getMessage(
    feedKey: FeedId,
    position: number,
  ): Promise<Message>;

  /** return the highest sequence number of an available message in the feed */
  lastMessage(feedKey: FeedId): Promise<number>;
}
