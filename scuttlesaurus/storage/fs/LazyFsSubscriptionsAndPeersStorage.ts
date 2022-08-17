import { path } from "../../util.ts";
import AbstractSubscriptionsAndPeersStorage from "../AbtractSubscriptionsAndPeersStorage.ts";

export default class LazyFsSubscriptionsAndPeersStorage
  extends AbstractSubscriptionsAndPeersStorage {
  

  rankingTableFile;
  /** dataDir points to a directory with the following files:
   *
   * - subscriptions.json
   * - peers.json
   * - ranking-table.bin
   *
   * The first 4 bytes of `ranking-table.bin` encode the number of peers. The remaining
   * files contains number-of_subscriptions x number-of-peers bytes
   */
  constructor(
    public readonly dataDir: string,
  ) {
    const rankingTableFile = path.join(dataDir, "ranking-table.bin");
    Deno.mkdirSync(dataDir, { recursive: true });
    function getFeedPeerRankings(): Uint8Array[] {
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
    super(getFeedPeerRankings());
    this.rankingTableFile = rankingTableFile;
  }

  loadFeedPeerRankings(): Uint8Array[] {
    throw new Error("Method not implemented.");
  }

  async storeFeedPeerRatings(): Promise<void> {
    const asByteArray = () => {
      if ((this.feedPeerRatings.length === 0) || (this.feedPeerRatings[0].length === 0)) {
        return new Uint8Array(0);
      }
      const rowLength = this.feedPeerRatings[0].length;
      //the first 32b contain the row length
      const buffer = new ArrayBuffer(4 + this.feedPeerRatings.length * rowLength);
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
