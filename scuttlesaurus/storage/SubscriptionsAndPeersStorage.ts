import { Address, FeedId, ObservableSet } from "../util.ts";

export default interface SubscriptionsAndPeersStorage {
  subscriptions: ObservableSet<FeedId>;
  peers: ObservableSet<Address>;

  getRating(subscription: FeedId, peer: Address): Promise<number>;
  setRating(subscription: FeedId, peer: Address, rating: number): Promise<void>;
  getPeerRatings(
    subscription: FeedId,
  ): Promise<{ peer: Address; rating: number }[]>;
  getSubscriptionRatings(
    peer: Address,
  ): Promise<{ subscription: FeedId; rating: number }[]>;
}
