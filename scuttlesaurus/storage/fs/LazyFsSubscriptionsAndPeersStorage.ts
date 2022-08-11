import { path } from "../../util.ts";
import SubscriptionsAndPeersStorage from "../SubscriptionsAndPeersStorage.ts";
import { Address, FeedId } from "../util.ts";

export default class LazyFsSubscriptionsAndPeersStorage implements SubscriptionsAndPeersStorage {

  //redundant store?
  //order: adding/sorted?
  feedList: FeedId[]
  peerList: Address[]

  rankingTableFile;
  constructor(public readonly dataDir: string) {
    this.rankingTableFile = path.join(dataDir, "ranking-table.bin");
    Deno.mkdirSync(dataDir, { recursive: true });
  }

  private async storeFeedPeerRankings(table: Uint8Array[]): Promise<void> {
    const asByteArray = () => {
      if ((table.length === 0) || (table[0].length === 0)) {
        return new Uint8Array(0);
      }
      const rowLength = table[0].length;
      //the first 32b contain the row length
      const buffer = new ArrayBuffer(4 + table.length * rowLength);
      const rowLengthView = new DataView(buffer, 0, 4);
      rowLengthView.setInt32(0, rowLength);
      const bytes = new Uint8Array(buffer, 4);
      for (let i = 0; i < table.length; i++) {
        bytes.set(table[i], i * rowLength);
      }
      return new Uint8Array(buffer);
    };
    await Deno.writeFile(this.rankingTableFile, asByteArray());
  }

  private async getFeedPeerRankings(): Promise<Uint8Array[]> {
    const { buffer } = await Deno.readFile(this.rankingTableFile);
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

  getRating(feedId: FeedId, addr: Address): Promise<number>
  setRating(feedId: FeedId, addr: Address, rating: number): Promise<void>
  getPeerRatings(feed: FeedId): Promise<[{addr: Address, rating: number}]>

  /** A table indicating how likely a peer has a feed */
  storeFeedPeerRankings(table: Uint8Array[]): Promise<void>;

  getFeedPeerRankings(): Promise<Uint8Array[]>;
}
