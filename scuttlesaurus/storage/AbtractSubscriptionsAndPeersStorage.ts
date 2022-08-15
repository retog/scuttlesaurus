import SubscriptionsAndPeersStorage from "./SubscriptionsAndPeersStorage.ts";
import { Address, FeedId, ObservableSet } from "../util.ts";

export default abstract class AbstractSubscriptionsAndPeersStorage
  implements SubscriptionsAndPeersStorage {
  subscriptions = new ObservableSet<FeedId>();
  peers = new ObservableSet<Address>();
  protected feedPeerRanking: Uint8Array[];

  constructor(
    initialSubscriptions: Iterable<FeedId>,
    initialPeers: Iterable<Address>,
  ) {
    for (const subscription of initialSubscriptions) {
      this.subscriptions.add(subscription);
    }
    for (const peer of initialPeers) {
      this.peers.add(peer);
    }
    this.feedPeerRanking = this.loadFeedPeerRankings();
    //observer:
    //new peer or subscription -> enlarge table
    //remover peer or subscription -> how to know pos? -> overwrite delete, so that it removes row/column
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
        this.feedPeerRanking[i].copyWithin(pos, pos + 1);
        this.feedPeerRanking[i] = this.feedPeerRanking[i].subarray(
          0,
          this.peers.size - 1,
        );
      }
      return origPeerDelete.apply(this.peers, [address]);
    };
    const origPeerAdd = this.peers.add;
    this.peers.add = (address: Address) => {
      for (let i = 0; i < this.subscriptions.size; i++) {
        const newRow = new Uint8Array(this.feedPeerRanking[i].length + 1);
        newRow.set(this.feedPeerRanking[i]);
        this.feedPeerRanking[i] = newRow;
      }
      return origPeerAdd.apply(this.peers, [address]);
    };
    const origSubscriptionsDelete = this.subscriptions.delete;
    this.subscriptions.delete = (subscription: FeedId) => {
      const pos = findIn(this.subscriptions, subscription);
      this.feedPeerRanking.splice(pos, 1);
      return origSubscriptionsDelete.apply(this.subscriptions, [subscription]);
    };
    const origSubscriptionsAdd = this.subscriptions.add;
    this.subscriptions.add = (subscription: FeedId) => {
      const newRow = new Uint8Array(this.peers.size + 1);
      let colNr = 0;
      for (const peer of this.peers) {
        newRow[colNr++] = this.initialValue(subscription, peer);
      }
      this.feedPeerRanking.push(newRow);
      return origSubscriptionsAdd.apply(this.subscriptions, [subscription]);
    };
  }
  initialValue(subscription: FeedId, peer: Address): number {
    return peer.key.toString() === subscription.toString() ? 255 : 3;
  }

  async getRating(subscription: FeedId, peer: Address): Promise<number> {
    const feedPos = await findIn(this.subscriptions, subscription);
    const addrPos = findIn(this.peers, peer);
    return this.feedPeerRanking[feedPos][addrPos];
  }
  async setRating(
    subscription: FeedId,
    peer: Address,
    rating: number,
  ): Promise<void> {
    const feedPos = await findIn(this.subscriptions, subscription);
    const addrPos = findIn(this.peers, peer);
    this.feedPeerRanking[feedPos][addrPos] = rating;
  }
  async getPeerRatings(
    feed: FeedId,
  ): Promise<{ peer: Address; rating: number }[]> {
    const feedPos = await findIn(this.subscriptions, feed);
    const feedRow = this.feedPeerRanking[feedPos];
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
    const peerCol = this.feedPeerRanking.map((ratings) => ratings[peerPos]);
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

  /** A table indicating how likely a peer has a feed: The rows are subscriptions, the cols peers*/
  abstract storeFeedPeerRankings(table: Uint8Array[]): Promise<void>;

  /**
   * Loads a table indicating how likely a peer has a feed
   */
  abstract loadFeedPeerRankings(): Uint8Array[];
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
