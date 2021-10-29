import {
  BlobId,
  exists,
  FeedId,
  filenameSafeAlphabetRFC3548,
  JSONValue,
  path,
  sha256Hash,
  toHex,
} from "../util.ts";

import BlobsStorage from "./BlobsStorage.ts";
import FeedsStorage from "./FeedsStorage.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export default class FsStorage implements BlobsStorage, FeedsStorage {
  constructor(public readonly dataDir: string) {}

  private getFeedDir(feedKey: FeedId) {
    const feedsDir = path.join(this.dataDir, "feeds");
    return path.join(feedsDir, filenameSafeAlphabetRFC3548(feedKey.base64Key));
  }

  async storeMessage(feedKey: FeedId, position: number, msg: JSONValue) {
    const dir = this.getFeedDir(feedKey);
    const fileName = path.join(
      dir,
      position + ".json",
    );
    await Deno.mkdir(dir, { recursive: true });
    Deno.writeFile(
      fileName,
      textEncoder.encode(JSON.stringify(msg, undefined, 2)),
    );
  }
  async getMessage(feedKey: FeedId, position: number) {
    const dir = this.getFeedDir(feedKey);
    const fileName = path.join(
      dir,
      position + ".json",
    );
    const msgBytes = await Deno.readFile(
      path.join(dir, fileName),
    );
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
