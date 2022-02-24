import RankingTableStorage from "../../storage/RankingTableStorage.ts";
import {
  Address,
  delay,
  FeedId,
  log,
  ObservableSet,
  TSESet,
} from "../../util.ts";

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
  tablePromise: Promise<Uint8Array[]>;
  followees: FeedId[];
  followeeLabels: string[];
  peers: Address[];
  peerLabels: string[];
  pendingSave: Promise<void> | null = null;
  constructor(
    private host: {
      peers: ObservableSet<Address>;
      followees: ObservableSet<FeedId>;
    },
    private storage: RankingTableStorage,
  ) {
    const followees = [...host.followees];
    this.followees = followees;
    const followeeLabels = followees.map((v) => v.toString());
    this.followeeLabels = followeeLabels;
    const peers = [...host.peers];
    this.peers = peers;
    const peerLabels = peers.map((v) => v.toString());
    this.peerLabels = peerLabels;
    this.tablePromise = (async () => {
      const table = await (async () => {
        let table: Uint8Array[] | undefined;
        try {
          table = await storage.getFeedPeerRankings();
        } catch (error) {
          log.error(`Error loading peer-rankings: ${error}`);
        }
        if (
          !table ||
          table.length !== followees.length ||
          (table.length > 0 && table[0].length !== peers.length)
        ) {
          table = new Array(followees.length);
          for (let i = 0; i < followees.length; i++) {
            table[i] = new Uint8Array(peers.length);
            for (let j = 0; j < peers.length; j++) {
              table[i][j] = (peers[j].key.toString() === followeeLabels[i])
                ? 255
                : 3;
            }
          }
        }
        return table;
      })();

      host.followees.addRemoveListener((followee) => {
        const pos = followeeLabels.indexOf(followee.toString());
        table.splice(pos, 1);
        followees.splice(pos, 1);
        followeeLabels.splice(pos, 1);
        storage.storeFeedPeerRankings(table);
      });
      host.peers.addRemoveListener((peer) => {
        const pos = peerLabels.indexOf(peer.toString());
        for (let i = 0; i < followees.length; i++) {
          table[i].copyWithin(pos, 1);
          table[i] = table[i].subarray(0, peers.length - 1);
        }
        peers.splice(pos, 1);
        peerLabels.splice(pos, 1);
        storage.storeFeedPeerRankings(table);
      });
      host.followees.addAddListener((followee) => {
        const pos = followees.length;
        followees[pos] = followee;
        followeeLabels[pos] = followee.toString();
        table[pos] = new Uint8Array(peers.length);
        for (let j = 0; j < peers.length; j++) {
          table[pos][j] = (peers[j].key.toString() === followeeLabels[pos])
            ? 255
            : 3;
        }
        storage.storeFeedPeerRankings(table);
      });
      host.peers.addAddListener((peer) => {
        const pos = peers.length;
        peers[pos] = peer;
        peerLabels[pos] = peer.toString();
        for (let i = 0; i < followees.length; i++) {
          const newRow = new Uint8Array(peers.length);
          newRow.set(table[i]);
          newRow[pos] = (peer.key.toString() === followeeLabels[i]) ? 255 : 3;
        }
        storage.storeFeedPeerRankings(table);
      });
      return table as Uint8Array[];
    })();
  }

  async recordSuccess(peer: FeedId, followee: FeedId) {
    const table = await this.tablePromise;
    const peerPositions = new Array<number>();
    for (let i = 0; i < this.peers.length; i++) {
      if (this.peers[i].key.toString() === peer.toString()) {
        peerPositions.push(i);
      }
    }
    const followeePos = this.followeeLabels.indexOf(followee.toString());
    peerPositions.forEach((peerPos) => {
      const currentValue = table[followeePos][peerPos];
      if (currentValue < 0xFF) {
        table[followeePos][peerPos]++; //the reward
        this.saveEventually();
      }
    });
  }

  private saveEventually() {
    if (!this.pendingSave) {
      this.pendingSave = (async () => {
        await delay(5 * 1000);
        await this.storage.storeFeedPeerRankings(await this.tablePromise);
        this.pendingSave = null;
      })();
    }
  }

  async getRecommendation(): Promise<{ peer: Address; followee: FeedId }> {
    const pickFollowee = async () => {
      if (this.followees.length === 0) {
        console.warn("No followees.");
        //return the first we get
        return await new Promise((resolve: (feedId: FeedId) => void) => {
          const listener = (feed: FeedId) => {
            this.host.followees.removeAddListener(listener);
            resolve(feed);
          };
          this.host.followees.addAddListener(listener);
        });
      } else {
        return this.followees[getRandomInt(0, this.followees.length)];
      }
    };
    const followee = await pickFollowee();
    const peer = await this.getPeerFor(followee);
    return { peer, followee };
  }
  async getPeerFor(followee: FeedId): Promise<Address> {
    const table = await this.tablePromise;
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
    const pos = this.followeeLabels.indexOf(followee.toString());
    const peerRatings = table[pos];
    const peerRatingsSum = peerRatings.reduce((sum, value) => sum + value + 1);
    const randomPointer = getRandomInt(0, peerRatingsSum);
    let partialSum = 0;
    for (let i = 0; i < peerRatings.length; i++) {
      partialSum += 1 + peerRatings[i];
      if (partialSum > randomPointer) {
        peerRatings[i] = Math.ceil(peerRatings[i] * 0.9); //recommendation cost
        this.saveEventually();
        return this.peers[i];
      }
    }
    throw new Error("The developer was bad with numbers.");
  }

  async getFolloweesFor(peerKey: FeedId, amount: number) {
    if (amount >= this.followees.length) {
      return this.followees;
    }
    const resultSet = new TSESet<FeedId>();
    while (resultSet.size < amount) {
      const newOne = await this.getFolloweeFor(peerKey);
      resultSet.add(newOne);
    }
    return [...resultSet];
  }

  async getFolloweeFor(peerKey: FeedId): Promise<FeedId> {
    const table = await this.tablePromise;
    const peerPositions = new Array<number>();
    for (let i = 0; i < this.peers.length; i++) {
      if (this.peers[i].key.toString() === peerKey.toString()) {
        peerPositions.push(i);
      }
    }
    if (this.host.followees.size === 0) {
      console.warn("No followee known.");
      //return the first we get
      return await new Promise((resolve) => {
        const listener = (addr: FeedId) => {
          this.host.followees.removeAddListener(listener);
          resolve(addr);
        };
        this.host.followees.addAddListener(listener);
      });
    }
    const pos = peerPositions[getRandomInt(0, peerPositions.length)];
    const followeeRatings = table.map((ratings) => ratings[pos]);
    const followeeRatingsSum = followeeRatings.reduce((sum, value) =>
      sum + value + 1
    );
    const randomPointer = getRandomInt(0, followeeRatingsSum);
    let partialSum = 0;
    for (let i = 0; i < followeeRatings.length; i++) {
      partialSum += 1 + followeeRatings[i];
      if (partialSum > randomPointer) {
        return this.followees[i];
      }
    }
    throw new Error("The developer was bad with numbers.");
  }
}
/** random number greater or equal min, below max */
function getRandomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min) + min);
}
