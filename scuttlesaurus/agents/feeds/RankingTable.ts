import SubscriptionsAndPeersStorage from "../../storage/SubscriptionsAndPeersStorage.ts";
import { Address, FeedId, ObservableSet, TSESet } from "../../util.ts";

/* Table followees/peers: every time we get feed contents from a peer the respective tuple gets points.
  * Whenever we recommend a tuple this costs some points.
  * Problem 1: FeedAgent knows ID but not the full address -> reward all addresses with that ID
  * Problem 2: This penalizes peers with only few feeds
  * -> they shoul remain in top in the peers for this followee
  *
  * Attempt:
  * - Sucess gives 1 point per message
  * - recommendation costs 10%
  */
export default class RankingTable {
  constructor(
    private host: {
      peers: ObservableSet<Address>;
      followees: ObservableSet<FeedId>;
    },
    private storage: SubscriptionsAndPeersStorage,
    public opts?: { signal?: AbortSignal },
  ) {
  }

  async recordSuccess(peer: FeedId, subscription: FeedId) {
    //get all addresses with peer as key
    const peerAddresses: Address[] = [];
    this.storage.peers.forEach((peerAddress) => {
      if (peerAddress.key.toString() === peer.toString()) {
        peerAddresses.push(peerAddress);
      }
    });
    for (const peerAddress of peerAddresses) {
      const currentRating = await this.storage.getRating(
        subscription,
        peerAddress,
      );
      if (currentRating < 0xFF) {
        this.storage.setRating(subscription, peerAddress, currentRating + 1);
      }
    }
  }

  async getRecommendation(): Promise<{ peer: Address; followee: FeedId }> {
    const pickFollowee = async () => {
      if (this.storage.subscriptions.size === 0) {
        console.warn("No subscriptions.");
        //return the first we get
        return await new Promise((resolve: (feedId: FeedId) => void) => {
          const listener = (feed: FeedId) => {
            this.storage.subscriptions.removeAddListener(listener);
            resolve(feed);
          };
          this.storage.subscriptions.addAddListener(listener);
        });
      } else {
        const chosenPos = getRandomInt(0, this.storage.subscriptions.size);
        return getPosIn(this.storage.subscriptions, chosenPos);
      }
    };
    const followee = await pickFollowee();
    const peer = await this.getPeerFor(followee);
    return { peer, followee };
  }
  async getPeerFor(followee: FeedId): Promise<Address> {
    if (this.host.peers.size === 0) {
      console.warn("No peer known.");
      //return the first we get
      return await new Promise((resolve) => {
        const listener = (addr: Address) => {
          this.host.peers.removeAddListener(listener);
          resolve(addr);
        };
        this.host.peers.addAddListener(listener);
      });
    }

    const peerRatings = await this.storage.getPeerRatings(followee);
    const peerRatingsSum = peerRatings.map((e) => e.rating).reduce((
      sum,
      value,
    ) => sum + value + 1);
    const randomPointer = getRandomInt(0, peerRatingsSum);
    let partialSum = 0;
    for (let i = 0; i < peerRatings.length; i++) {
      partialSum += 1 + peerRatings[i].rating;
      if (partialSum > randomPointer) {
        const origRating = peerRatings[i].rating;
        const newRating = Math.ceil(origRating * 0.9); //recommendation cost
        this.storage.setRating(followee, peerRatings[i].peer, newRating);
        return peerRatings[i].peer;
      }
    }
    throw new Error("The developer was bad with numbers.");
  }

  async getFolloweesFor(peerKey: FeedId, amount: number) {
    const resultSet = new TSESet<FeedId>();
    if (amount > this.storage.subscriptions.size) {
      amount = this.storage.subscriptions.size;
    }
    while (resultSet.size < amount) {
      const newOne = await this.getFolloweeFor(peerKey);
      resultSet.add(newOne);
    }
    return [...resultSet];
  }

  async getFolloweeFor(peerKey: FeedId): Promise<FeedId> {
    if (this.storage.subscriptions.size === 0) {
      console.warn("No followee known.");
      //return the first we get
      return await new Promise((resolve) => {
        const listener = (addr: FeedId) => {
          this.storage.subscriptions.removeAddListener(listener);
          resolve(addr);
        };
        this.storage.subscriptions.addAddListener(listener);
      });
    }
    //get all addresses with peer as key
    const peerAddresses: Address[] = [];
    this.storage.peers.forEach((peerAddress) => {
      if (peerAddress.key.toString() === peerKey.toString()) {
        peerAddresses.push(peerAddress);
      }
    });
    if (peerAddresses.length === 0) {
      return getPosIn(
        this.storage.subscriptions,
        getRandomInt(0, this.storage.subscriptions.size),
      );
    }
    const peerAddress = peerAddresses[getRandomInt(0, peerAddresses.length)];
    const ratings = await this.storage.getSubscriptionRatings(peerAddress);
    const followeeRatingsSum = ratings.map((e) => e.rating).reduce((
      sum,
      value,
    ) => sum + value + 1);
    const randomPointer = getRandomInt(0, followeeRatingsSum);
    let partialSum = 0;
    for (let i = 0; i < ratings.length; i++) {
      partialSum += 1 + ratings[i].rating;
      if (partialSum > randomPointer) {
        return ratings[i].subscription;
      }
    }
    throw new Error("The developer was bad with numbers.");
  }
}
/** random number greater or equal min, below max */
function getRandomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min) + min);
}
function getPosIn<T>(iterable: Iterable<T>, position: number): T {
  let pos = 0;
  for (const entry of iterable) {
    if (pos++ === position) return entry;
  }
  throw new Error("Out of bounds");
}
