import {
  BlobId,
  FeedId,
  filenameSafeAlphabetRFC3548,
  path,
  sha256Hash,
  toHex,
} from "./util.ts";
import config from "./config.ts";
import { exists } from "https://deno.land/std@0.103.0/fs/exists.ts";

export function getFeedDir(feedKey: FeedId) {
  const feedsDir = path.join(config.dataDir, "feeds");
  return path.join(feedsDir, filenameSafeAlphabetRFC3548(feedKey.base64Key));
}

export async function lastMessage(feedKey: FeedId) {
  try {
    let highest = -1;
    for await (const entry of Deno.readDir(getFeedDir(feedKey))) {
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

function getBlobFileLocation(blobId: BlobId) {
  const blobsDir = path.join(config.dataDir, "blobs");
  const hexString = toHex(blobId);
  const dirName = hexString.substring(0, 2);
  const dir = path.join(blobsDir, dirName);
  const fileName = hexString.substring(2);
  return { dir, fileName };
}

export function hasBlob(blobId: BlobId) {
  const { dir, fileName } = getBlobFileLocation(blobId);
  return exists(path.join(dir, fileName));
}

export async function storeBlob(data: Uint8Array): Promise<BlobId> {
  const blobId = new BlobId(sha256Hash(data));
  const { dir, fileName } = getBlobFileLocation(blobId);
  await Deno.mkdir(dir, { recursive: true });
  const blobFile = await Deno.create(
    path.join(dir, fileName),
  );
  await blobFile.write(data);
  return blobId;
}

export function getBlob(blobId: BlobId): Promise<Uint8Array> {
  const { dir, fileName } = getBlobFileLocation(blobId);
  return Deno.readFile(
    path.join(dir, fileName),
  );
}
