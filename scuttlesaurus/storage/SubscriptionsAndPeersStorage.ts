import { Address, FeedId, ObservableSet } from "../util.ts";

export default interface SubscriptionsAndPeersStorage {

  subscriptions: ObservableSet<FeedId>,
  peers: ObservableSet<Address>,

  getRating(feedId: FeedId, addr: Address): Promise<number>
  setRating(feedId: FeedId, addr: Address, rating: number): Promise<void>
  getPeerRatings(feed: FeedId): Promise<[{addr: Address, rating: number}]>

}
