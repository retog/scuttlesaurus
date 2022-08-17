import SubscriptionsAndPeersStorage from "./SubscriptionsAndPeersStorage.ts";
import { Address, FeedId, ObservableSet } from "../util.ts";

export default abstract class AbstractSubscriptionsAndPeersStorage
  implements SubscriptionsAndPeersStorage {
  subscriptions = new ObservableSet<FeedId>();
  peers = new ObservableSet<Address>();

  constructor(protected feedPeerRatings: Uint8Array[]) {

    //new peer or subscription -> enlarge table
    //remove peer or subscription -> look up pos -> removes row/column
    const origPeerDelete = this.peers.delete;
    this.peers.delete = (address: Address) => {
      let pos = 0;
      let found = false;
      for (const peer of this.peers) {
        if (peer.toString() === address.toString()) {
          found = true;
          break;
        }
        pos++;
      }
      if (!found) {
        return false;
      }
      for (let i = 0; i < this.subscriptions.size; i++) {
        this.feedPeerRatings[i].copyWithin(pos, pos + 1);
        this.feedPeerRatings[i] = this.feedPeerRatings[i].subarray(
          0,
          this.peers.size - 1,
        );
      }
      this.storeFeedPeerRatings();
      return origPeerDelete.apply(this.peers, [address]);
    };
    const origPeerAdd = this.peers.add;
    this.peers.add = (address: Address) => {
      let i = 0;
      for (const subscription of this.subscriptions) {
        const newRow = new Uint8Array(this.feedPeerRatings[i].length + 1);
        newRow.set(this.feedPeerRatings[i]);
        newRow[this.feedPeerRatings[i].length] = this.initialValue(
          subscription,
          address,
        );
        this.feedPeerRatings[i++] = newRow;
      }
      this.storeFeedPeerRatings();
      return origPeerAdd.apply(this.peers, [address]);
    };
    const origSubscriptionsDelete = this.subscriptions.delete;
    this.subscriptions.delete = (subscription: FeedId) => {
      const pos = findIn(this.subscriptions, subscription);
      this.feedPeerRatings.splice(pos, 1);
      this.storeFeedPeerRatings();
      return origSubscriptionsDelete.apply(this.subscriptions, [subscription]);
    };
    const origSubscriptionsAdd = this.subscriptions.add;
    this.subscriptions.add = (subscription: FeedId) => {
      const newRow = new Uint8Array(this.peers.size + 1);
      let colNr = 0;
      for (const peer of this.peers) {
        newRow[colNr++] = this.initialValue(subscription, peer);
      }
      this.feedPeerRatings.push(newRow);
      this.storeFeedPeerRatings();
      return origSubscriptionsAdd.apply(this.subscriptions, [subscription]);
    };
  }
  initialValue(subscription: FeedId, peer: Address): number {
    return peer.key.toString() === subscription.toString() ? 255 : 3;
  }

  async getRating(subscription: FeedId, peer: Address): Promise<number> {
    const feedPos = await findIn(this.subscriptions, subscription);
    const addrPos = findIn(this.peers, peer);
    return this.feedPeerRatings[feedPos][addrPos];
  }
  async setRating(
    subscription: FeedId,
    peer: Address,
    rating: number,
  ): Promise<void> {
    const feedPos = await findIn(this.subscriptions, subscription);
    const addrPos = findIn(this.peers, peer);
    this.feedPeerRatings[feedPos][addrPos] = rating;
  }
  async getPeerRatings(
    feed: FeedId,
  ): Promise<{ peer: Address; rating: number }[]> {
    const feedPos = await findIn(this.subscriptions, feed);
    const feedRow = this.feedPeerRatings[feedPos];
    const result = [];
    let rowPos = 0;
    for (const peer of this.peers) {
      result[rowPos] = {
        peer,
        rating: feedRow[rowPos],
      };
      rowPos++;
    }
    return result;
  }

  async getSubscriptionRatings(
    peer: Address,
  ): Promise<{ subscription: FeedId; rating: number }[]> {
    const peerPos = await findIn(this.peers, peer);
    const peerCol = this.feedPeerRatings.map((ratings) => ratings[peerPos]);
    const result = [];
    let colPos = 0;
    for (const subscription of this.subscriptions) {
      result[colPos] = {
        subscription,
        rating: peerCol[colPos],
      };
      colPos++;
    }
    return result;
  }

  /** Invoked when feedPeerRatings has been modified: The rows are subscriptions, the cols peers*/
  abstract storeFeedPeerRatings(): Promise<void>;

}

function findIn<T extends { toString: () => string }>(
  values: Iterable<T>,
  value: T,
): number {
  let pos = 0;
  let found = false;
  for (const peer of values) {
    if (peer.toString() === value.toString()) {
      found = true;
      break;
    }
    pos++;
  }
  if (found) {
    return pos;
  } else {
    return -1;
  }
}
