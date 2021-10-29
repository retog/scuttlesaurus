import type { FeedId, JSONValue } from "../util.ts";

export default interface FeedsStorage {
  storeMessage(
    feedKey: FeedId,
    position: number,
    msg: JSONValue,
  ): Promise<void>;

  getMessage(
    feedKey: FeedId,
    position: number,
  ): Promise<{ key: string; value: JSONValue; timestamp: number }>;

  /** return the highest sequence number of an available message in the feed */
  lastMessage(feedKey: FeedId): Promise<number>;
}
