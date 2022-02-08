import { BlobId, fromBase64, sha256Hash, toBase64 } from "../../util.ts";
import BlobsStorage from "../BlobsStorage.ts";

export class LocalStorageBlobsStorage implements BlobsStorage {
  hasBlob(blobId: BlobId): Promise<boolean> {
    return Promise.resolve(localStorage.getItem(blobId.toString()) !== null);
  }
  async storeBlob(data: Uint8Array): Promise<BlobId> {
    const blobId = new BlobId(sha256Hash(data));
    await localStorage.setItem(blobId.toString(), toBase64(data));
    return blobId;
  }
  async getBlob(blobId: BlobId): Promise<Uint8Array> {
    const encodedData = localStorage.getItem(blobId.toString());
    if (encodedData === null) {
      throw new Error(`No such blob stored: ${blobId}`);
    }
    return await fromBase64(encodedData);
  }
}
