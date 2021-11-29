import type { BlobId } from "../util.ts";

export default interface BlobsStorage {
  hasBlob(blobId: BlobId): Promise<boolean>;

  storeBlob(data: Uint8Array): Promise<BlobId>;

  getBlob(blobId: BlobId): Promise<Uint8Array>;
}
