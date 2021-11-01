import FeedsStorage from "../FeedsStorage.ts";
import { FeedId, JSONValue } from "../../util.ts";

export class LocalStorageFeedsStorage implements FeedsStorage {
  private storageKey(feedKey: FeedId, position: number) {
    return feedKey.base64Key + "@" + position;
  }

  storeMessage(
    feedKey: FeedId,
    position: number,
    msg: JSONValue,
  ): Promise<void> {
    window.localStorage.setItem(
      this.storageKey(feedKey, position),
      JSON.stringify(msg),
    );
    if (position > this.lastMessageSync(feedKey)) {
      window.localStorage.setItem(
        feedKey.base64Key,
        position.toString(),
      );
    }
    return Promise.resolve();
  }
  getMessage(
    feedKey: FeedId,
    position: number,
  ): Promise<{ key: string; value: JSONValue; timestamp: number }> {
    const jsonMsg = window.localStorage.getItem(
      this.storageKey(feedKey, position),
    );
    if (!jsonMsg) {
      throw new Deno.errors.NotFound();
    }
    return Promise.resolve(JSON.parse(jsonMsg));
  }
  lastMessage(feedKey: FeedId): Promise<number> {
    return Promise.resolve(this.lastMessageSync(feedKey));
  }
  private lastMessageSync(feedKey: FeedId): number {
    const positionStr = window.localStorage.getItem(
      feedKey.base64Key,
    );
    if (positionStr) {
      return parseInt(positionStr);
    } else {
      return 0;
    }
  }
}
