import {
  Address,
  existsSync,
  FeedId,
  ObservableSet,
  parseAddress,
  parseFeedId,
  path,
} from "../../util.ts";
import AbstractSubscriptionsAndPeersStorage, {
  initialValue,
} from "../AbtractSubscriptionsAndPeersStorage.ts";

export default class LazyFsSubscriptionsAndPeersStorage
  extends AbstractSubscriptionsAndPeersStorage {
  rankingTableFile;
  /** configDir points to a directory with the following files:
   *
   * - subscriptions.json
   * - peers.json
   * - ranking-table.bin
   *
   * The first 4 bytes of `ranking-table.bin` encode the number of peers. The remaining
   * files contains number-of_subscriptions x number-of-peers bytes
   */
  constructor(
    public readonly configDir: string,
  ) {
    const subscriptions = new ObservableSet<FeedId>();
    const peers = new ObservableSet<Address>();
    const subscriptionsFile = path.join(configDir, "subscriptions.json");
    try {
      const subscriptionsFromFile = JSON.parse(
        Deno.readTextFileSync(subscriptionsFile),
      ) as string[];
      subscriptionsFromFile.forEach((feedStr) => {
        subscriptions.add(parseFeedId(feedStr));
      });
    } catch (error) {
      console.debug(`Error reading ${subscriptionsFile}: ${error}`);
    }

    const peersFile = path.join(configDir, "peers.json");

    try {
      const peersFromFile = JSON.parse(Deno.readTextFileSync(peersFile));
      for (const peerStr of peersFromFile) {
        peers.add(parseAddress(peerStr));
      }
    } catch (error) {
      console.debug(`Error reading ${peersFile}: ${error}`);
    }
    const rankingTableFile = path.join(configDir, "ranking-table.bin");
    Deno.mkdirSync(configDir, { recursive: true });
    function getFeedPeerRankings(): Uint8Array[] {
      if (!existsSync(rankingTableFile)) {
        const rankings = []; //Array(subscriptions.size);
        for (const subscription of subscriptions) {
          const row = new Uint8Array(peers.size);
          let i = 0;
          for (const peer of peers) {
            row[i++] = initialValue(subscription, peer);
          }
          rankings.push(row);
        }
        return rankings;
      }
      const { buffer } = Deno.readFileSync(rankingTableFile);
      const rowLengthView = new DataView(buffer, 0, 4);
      const rowLength = rowLengthView.getInt32(0);
      const bytes = new Uint8Array(buffer, 4);
      //why do we get excess data?
      const excessBytes = bytes.length % rowLength;
      const table = new Array((bytes.length - excessBytes) / rowLength);
      for (let i = 0; i < table.length; i++) {
        table[i] = bytes.subarray(i * rowLength, (i + 1) * rowLength);
      }
      return table;
    }
    super(subscriptions, peers, getFeedPeerRankings());
    this.rankingTableFile = rankingTableFile;

    {
      const writeFolloweesFile = () => {
        Deno.writeTextFileSync(
          peersFile,
          JSON.stringify([...subscriptions], undefined, 2),
        );
      };
      subscriptions.addAddListener(writeFolloweesFile);
      subscriptions.addRemoveListener(writeFolloweesFile);
    }
    {
      const writePeersFile = () => {
        Deno.writeTextFileSync(
          peersFile,
          JSON.stringify([...peers], undefined, 2),
        );
      };
      peers.addAddListener(writePeersFile);
      peers.addRemoveListener(writePeersFile);
    }
  }

  loadFeedPeerRankings(): Uint8Array[] {
    throw new Error("Method not implemented.");
  }

  async storeFeedPeerRatings(): Promise<void> {
    const asByteArray = () => {
      if (
        (this.feedPeerRatings.length === 0) ||
        (this.feedPeerRatings[0].length === 0)
      ) {
        return new Uint8Array(0);
      }
      const rowLength = this.feedPeerRatings[0].length;
      //the first 32b contain the row length
      const buffer = new ArrayBuffer(
        4 + this.feedPeerRatings.length * rowLength,
      );
      const rowLengthView = new DataView(buffer, 0, 4);
      rowLengthView.setInt32(0, rowLength);
      const bytes = new Uint8Array(buffer, 4);
      for (let i = 0; i < this.feedPeerRatings.length; i++) {
        bytes.set(this.feedPeerRatings[i], i * rowLength);
      }
      return new Uint8Array(buffer);
    };
    await Deno.writeFile(this.rankingTableFile, asByteArray());
  }
}
