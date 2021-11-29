import FeedsStorage from "../FeedsStorage.ts";
import { FeedId, JSONValue, NotFoundError } from "../../util.ts";
import type { Message } from "../../agents/feeds/FeedsAgent.ts";

export class LocalStorageFeedsStorage implements FeedsStorage {
  private storageKey(feedKey: FeedId, position: number) {
    return feedKey.base64Key + "@" + position;
  }

  storeMessage(
    feedKey: FeedId,
    position: number,
    msg: JSONValue,
  ): Promise<void> {
    const key = this.storageKey(feedKey, position);
    if (window.localStorage.getItem(key) !== null) {
      throw new Error("Already have message at that position.");
    }
    window.localStorage.setItem(
      key,
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
  ): Promise<Message> {
    const jsonMsg = window.localStorage.getItem(
      this.storageKey(feedKey, position),
    );
    if (!jsonMsg) {
      throw new NotFoundError();
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
