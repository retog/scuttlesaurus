import {
  BlobId,
  exists,
  FeedId,
  filenameSafeAlphabetRFC3548,
  path,
  sha256Hash,
  toHex,
} from "../util.ts";

export default class FsStorage {
  constructor(public readonly dataDir: string) {}

  getFeedDir(feedKey: FeedId) {
    const feedsDir = path.join(this.dataDir, "feeds");
    return path.join(feedsDir, filenameSafeAlphabetRFC3548(feedKey.base64Key));
  }

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

  getBlobFileLocation(blobId: BlobId) {
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
