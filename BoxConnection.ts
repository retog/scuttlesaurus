import sodium from "https://deno.land/x/sodium@0.2.0/sumo.ts";
import { concat, readBytes } from "./util.ts";

export default class BoxConnection /*implements Deno.Conn*/ {
  closed = false;
  constructor(
    public conn: Deno.Conn,
    public serverToClientKey: Uint8Array,
    public serverToClientNonce: Uint8Array,
    public clientToServerKey: Uint8Array,
    public clientToServerNonce: Uint8Array,
  ) {
  }

  async readTill(length: number) {
    const chunks: Uint8Array[] = [];
    while (
      chunks.reduce((previous, chunk) => previous + chunk.length, 0) <
        length
    ) {
      chunks.push(await this.read());
    }
    if (
      chunks.reduce((previous, chunk) => previous + chunk.length, 0) >
        length
    ) {
      throw new Error(
        `Requested number of bytes doesn't match the received chunks`,
      );
    }
    return concat(...chunks);
  }

  async read() {
    const headerBox = await readBytes(this.conn, 34);
    const header = sodium.crypto_box_open_easy_afternm(
      headerBox,
      this.serverToClientNonce,
      this.serverToClientKey,
    );
    increment(this.serverToClientNonce);
    const bodyLength = header[0] * 0x100 + header[1];
    const authenticationBodyTag = header.slice(2);
    const encryptedBody = await readBytes(this.conn, bodyLength);
    const decodedBody = sodium.crypto_box_open_easy_afternm(
      concat(authenticationBodyTag, encryptedBody),
      this.serverToClientNonce,
      this.serverToClientKey,
    );
    increment(this.serverToClientNonce);
    return decodedBody;
  }

  async write(message: Uint8Array) {
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
  }
  async close() {
    this.closed = true;
    const byeMessage = sodium.crypto_box_easy_afternm(
      new Uint8Array(18),
      this.clientToServerNonce,
      this.clientToServerKey,
    );
    await this.conn.write(byeMessage);
    this.conn.close();
    //TODO fire close event
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
