import SubscriptionsAndPeersStorage from "./SubscriptionsAndPeersStorage.ts";
import { Address, FeedId, ObservableSet } from "../util.ts";

export default abstract class AbstractSubscriptionsAndPeersStorage implements SubscriptionsAndPeersStorage {

  subscriptions = new ObservableSet<FeedId>();
  peers = new ObservableSet<Address>();
  protected feedPeerRanking: Uint8Array[];

  constructor(initialSubscriptions: Iterable<FeedId>, initialPeers: Iterable<Address>) {
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
    this.peers.delete = (address: Address) => {
      let pos = 0;
      for (const peer of this.peers) {
        if (peer.toString() === address.toString()) {
          break;
        }
        pos++;
      }

        for (let i = 0; i < followees.length; i++) {
          table[i].copyWithin(pos, 1);
          table[i] = table[i].subarray(0, peers.length - 1);
        }
        peers.splice(pos, 1);
        peerLabels.splice(pos, 1);
        this.saveEventually();
      //problem: getFeedPeerRankings is async and delete is not
      return false;
    }
  }

  getRating(feedId: FeedId, addr: Address): Promise<number>
  setRating(feedId: FeedId, addr: Address, rating: number): Promise<void>
  getPeerRatings(feed: FeedId): Promise<[{addr: Address, rating: number}]>

  /** A table indicating how likely a peer has a feed */
  storeFeedPeerRankings(table: Uint8Array[]): Promise<void>;

  abstract loadFeedPeerRankings(): Uint8Array[];
}
