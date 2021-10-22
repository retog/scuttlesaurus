import { concat, FeedId, isZero, log, readBytes, sodium } from "../../util.ts";

export default class BoxConnection extends EventTarget
  implements Deno.Reader, Deno.Writer, Deno.Closer {
  closed = false;
  serverToClientKey: Uint8Array;
  clientToServerKey: Uint8Array;
  serverToClientNonce: Uint8Array;
  clientToServerNonce: Uint8Array;
  peer: FeedId;
  constructor(
    public conn: Deno.Reader & Deno.Writer & Deno.Closer,
    combinedSharedSecret: Uint8Array,
    ourLongTermPublicKey: Uint8Array,
    theirLongTermPublicKey: Uint8Array,
    ourEphemeralPublicKey: Uint8Array,
    theirEphemeralTermPublicKey: Uint8Array,
    networkIdentifier: Uint8Array,
  ) {
    super();
    this.peer = new FeedId(theirLongTermPublicKey);
    this.serverToClientKey = sodium.crypto_hash_sha256(
      concat(
        combinedSharedSecret,
        ourLongTermPublicKey,
      ),
    );

    this.clientToServerKey = sodium.crypto_hash_sha256(
      concat(
        combinedSharedSecret,
        theirLongTermPublicKey,
      ),
    );

    this.serverToClientNonce = sodium.crypto_auth(
      ourEphemeralPublicKey,
      networkIdentifier,
    ).slice(0, 24);
    this.clientToServerNonce = sodium.crypto_auth(
      theirEphemeralTermPublicKey,
      networkIdentifier,
    ).slice(0, 24);
  }

  pendingData: Uint8Array | null = null;

  async read(p: Uint8Array): Promise<number | null> {
    if (!this.pendingData) {
      const chunk = await this.readChunk();
      if (chunk === null) {
        return null;
      }
      if (!this.pendingData) {
        this.pendingData = chunk;
      } else {
        //race condition
        this.pendingData = concat(this.pendingData, chunk);
      }
    }
    //TODO merge metods to avoid copying data
    if (this.pendingData.length < p.length) {
      p.set(this.pendingData);
      const result = this.pendingData.length;
      this.pendingData = null;
      return result;
    } else {
      p.set(this.pendingData.subarray(0, p.length));
      this.pendingData = this.pendingData.subarray(p.length);
      return p.length;
    }
  }

  /** Gets the next chunk (box/body) of data*/
  async readChunk() {
    try {
      const headerBox = await readBytes(this.conn, 34);
      const header = sodium.crypto_box_open_easy_afternm(
        headerBox,
        this.serverToClientNonce,
        this.serverToClientKey,
      );
      increment(this.serverToClientNonce);
      if (isZero(header)) {
        //they said goodbye
        this.close();
        return null;
      }
      const bodyLength = header[0] * 0x100 + header[1];
      const authenticationBodyTag = header.slice(2);
      const encryptedBody = await readBytes(this.conn, bodyLength);
      const decodedBody = sodium.crypto_box_open_easy_afternm(
        concat(authenticationBodyTag, encryptedBody),
        this.serverToClientNonce,
        this.serverToClientKey,
      );
      increment(this.serverToClientNonce);
      //log.debug("Read " + decodedBody);
      return decodedBody;
    } catch (error) {
      if (!this.closed) {
        this.close();
      }
      if (error.message.startsWith("End of reader")) {
        log.info("End of reader, closing.");
      }
      throw error;
    }
  }

  async write(message: Uint8Array) {
    //log.debug("Writing " + message);
    const headerNonce = new Uint8Array(this.clientToServerNonce);
    increment(this.clientToServerNonce);
    const bodyNonce = new Uint8Array(this.clientToServerNonce);
    increment(this.clientToServerNonce);
    const encryptedMessage = sodium.crypto_box_easy_afternm(
      message,
      bodyNonce,
      this.clientToServerKey,
    );
    const messageLengh = message.length;
    const messageLenghUiA = new Uint8Array([
      messageLengh >> 8,
      messageLengh & 0xFF,
    ]);
    const authenticationBodyTag = encryptedMessage.slice(0, 16);
    const encryptedHeader = sodium.crypto_box_easy_afternm(
      concat(messageLenghUiA, authenticationBodyTag),
      headerNonce,
      this.clientToServerKey,
    );

    await this.conn.write(concat(encryptedHeader, encryptedMessage.slice(16)));
    return messageLengh;
  }
  async close() {
    if (this.closed) {
      log.warning(`Connection closed already.`);
      return;
    }
    this.closed = true;
    this.dispatchEvent(new CustomEvent("close"));
    const byeMessage = sodium.crypto_box_easy_afternm(
      new Uint8Array(18),
      this.clientToServerNonce,
      this.clientToServerKey,
    );
    try {
      await this.conn.write(byeMessage);
    } catch (error) {
      log.debug(`Failed at properly bidding goodbye: ${error}`);
    }
    this.conn.close();
  }
}

function increment(bytes: Uint8Array) {
  let pos = bytes.length - 1;
  while (true) {
    bytes[pos]++;
    if (bytes[pos] === 0) {
      pos--;
      if (pos < 0) {
        return;
      }
    } else {
      return;
    }
  }
}
