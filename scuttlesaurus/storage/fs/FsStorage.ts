import {
  BlobId,
  exists,
  FeedId,
  JSONValue,
  path,
  sha256Hash,
  toFilenameSafeAlphabet,
  toHex,
  writeAll,
} from "../../util.ts";

import BlobsStorage from "../BlobsStorage.ts";
import FeedsStorage from "../FeedsStorage.ts";
import RankingTableStorage from "../RankingTableStorage.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export default class FsStorage
  implements BlobsStorage, FeedsStorage, RankingTableStorage {
  rankingTableFile;
  constructor(public readonly dataDir: string) {
    this.rankingTableFile = path.join(dataDir, "ranking-table.bin");
    Deno.mkdirSync(dataDir, { recursive: true });
  }

  async storeFeedPeerRankings(table: Uint8Array[]): Promise<void> {
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

  async getFeedPeerRankings(): Promise<Uint8Array[]> {
    const { buffer } = await Deno.readFile(this.rankingTableFile);
    const rowLengthView = new DataView(buffer, 0, 4);
    const rowLength = rowLengthView.getInt32(0);
    const bytes = new Uint8Array(buffer, 4);
    //why do we get excess data?
    const excessBytes = bytes.length % rowLength
    const table = new Array((bytes.length - excessBytes) / rowLength);
    for (let i = 0; i < table.length; i++) {
      table[i] = bytes.subarray(i * rowLength, (i+1) * rowLength);
    }
    return table;
  }

  private getFeedDir(feedKey: FeedId) {
    const feedsDir = path.join(this.dataDir, "feeds");
    return path.join(feedsDir, toFilenameSafeAlphabet(feedKey.base64Key));
  }

  async storeMessage(feedKey: FeedId, position: number, msg: JSONValue) {
    const dir = this.getFeedDir(feedKey);
    const fileName = path.join(
      dir,
      position + ".json",
    );
    await Deno.mkdir(dir, { recursive: true });
    const file = await Deno.open(fileName, { createNew: true, write: true });
    await writeAll(file, textEncoder.encode(JSON.stringify(msg, undefined, 2)));
    Deno.close(file.rid);
  }
  async getMessage(feedKey: FeedId, position: number) {
    const dir = this.getFeedDir(feedKey);
    const fileName = path.join(
      dir,
      position + ".json",
    );
    const msgBytes = await Deno.readFile(fileName);
    return JSON.parse(textDecoder.decode(msgBytes));
  }

  /** return the highest sequence number of an available message in the feed */
  async lastMessage(feedKey: FeedId) {
    try {
      let highest = -1;
      for await (const entry of Deno.readDir(this.getFeedDir(feedKey))) {
        const seq = parseInt(
          entry.name.substring(0, entry.name.length - ".json".length),
        );
        if (seq > highest) {
          highest = seq;
        }
      }
      return highest;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // file or directory does not exist
        return 0;
      } else {
        // unexpected error, maybe permissions, pass it along
        throw error;
      }
    }
  }

  private getBlobFileLocation(blobId: BlobId) {
    const blobsDir = path.join(this.dataDir, "blobs");
    const hexString = toHex(blobId);
    const dirName = hexString.substring(0, 2);
    const dir = path.join(blobsDir, dirName);
    const fileName = hexString.substring(2);
    return { dir, fileName };
  }

  hasBlob(blobId: BlobId) {
    const { dir, fileName } = this.getBlobFileLocation(blobId);
    return exists(path.join(dir, fileName));
  }

  async storeBlob(data: Uint8Array): Promise<BlobId> {
    const blobId = new BlobId(sha256Hash(data));
    const { dir, fileName } = this.getBlobFileLocation(blobId);
    await Deno.mkdir(dir, { recursive: true });
    Deno.writeFile(path.join(dir, fileName), data);
    return blobId;
  }

  getBlob(blobId: BlobId): Promise<Uint8Array> {
    const { dir, fileName } = this.getBlobFileLocation(blobId);
    return Deno.readFile(
      path.join(dir, fileName),
    );
  }
}
