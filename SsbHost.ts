// deno-lint-ignore-file camelcase
import * as base64 from "https://denopkg.com/chiefbiiko/base64/mod.ts";
import sodium from "https://deno.land/x/sodium@0.2.0/sumo.ts";
import { concat, readBytes } from "./util.ts";

await sodium.ready;

interface BoxConnection {
  read: () => Promise<Uint8Array>;
  readTill: (length: number) => Promise<Uint8Array>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Uint8Array>;
  write: (message: Uint8Array) => Promise<void>;
  close: () => void;
}

export type { BoxConnection };

export default class SsbHost {
  network_identifier = base64.toUint8Array(
    "1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=",
  );
  clientLongtermKeyPair = sodium.crypto_sign_keypair("uint8array");
  id = "@" + base64.fromUint8Array(this.clientLongtermKeyPair.publicKey);

  connections: BoxConnection[] = [];

  async connect(
    address: { protocol: string; host: string; port: number; key: string },
  ) {
    // deno-lint-ignore no-this-alias
    const _host = this;
    const clientEphemeralKeyPair = sodium.crypto_box_keypair("uint8array");
    const conn = await Deno.connect({
      hostname: address.host,
      port: address.port,
    });

    const clientHello = () => {
      const hmac = sodium.crypto_auth(
        clientEphemeralKeyPair.publicKey,
        this.network_identifier,
      );
      const clientHelloMessage = new Uint8Array(
        hmac.length + clientEphemeralKeyPair.publicKey.length,
      );
      clientHelloMessage.set(hmac);
      clientHelloMessage.set(clientEphemeralKeyPair.publicKey, hmac.length);
      return clientHelloMessage;
    };

    const authenticate = (
      server_longterm_pk: Uint8Array,
      shared_secret_ab: Uint8Array,
      shared_secret_aB: Uint8Array,
    ) => {
      // 3. Client authenticate
      const shared_secret_ab_sha256 = sodium.crypto_hash_sha256(
        shared_secret_ab,
      );
      const msg = concat(
        this.network_identifier,
        server_longterm_pk,
        shared_secret_ab_sha256,
      );
      const detached_signature_A = sodium.crypto_sign_detached(
        msg,
        this.clientLongtermKeyPair.privateKey,
      );
      const boxMsg = new Uint8Array(
        detached_signature_A.length +
          this.clientLongtermKeyPair.publicKey.length,
      );
      boxMsg.set(detached_signature_A);
      boxMsg.set(
        this.clientLongtermKeyPair.publicKey,
        detached_signature_A.length,
      );
      const nonce = new Uint8Array(24);
      const boxKey = sodium.crypto_hash_sha256(
        concat(this.network_identifier, shared_secret_ab, shared_secret_aB),
      );
      conn.write(sodium.crypto_secretbox_easy(boxMsg, nonce, boxKey));
      return detached_signature_A;
    };

    const hello = clientHello();
    await conn.write(hello);
    const serverResponse = await readBytes(conn,64) 
    const server_hmac = serverResponse.subarray(0, 32);
    const server_ephemeral_pk = serverResponse.subarray(32, 64);
    if (
      !sodium.crypto_auth_verify(
        server_hmac,
        server_ephemeral_pk,
        this.network_identifier,
      )
    ) {
      throw new Error("Verification of the server's first response failed");
    }
    const shared_secret_ab = sodium.crypto_scalarmult(
      clientEphemeralKeyPair.privateKey,
      server_ephemeral_pk,
    );

    const shared_secret_aB = sodium.crypto_scalarmult(
      clientEphemeralKeyPair.privateKey,
      sodium.crypto_sign_ed25519_pk_to_curve25519(
        base64.toUint8Array(address.key),
      ),
    );
    const server_longterm_pk = base64.toUint8Array(address.key);
    const detached_signature_A = authenticate(
      server_longterm_pk,
      shared_secret_ab,
      shared_secret_aB,
    );

    const shared_secret_Ab = sodium.crypto_scalarmult(
      sodium.crypto_sign_ed25519_sk_to_curve25519(
        this.clientLongtermKeyPair.privateKey,
      ),
      server_ephemeral_pk,
    );

    const serverResponse2 = await readBytes(conn, 80); //msg4 in protocol guide

    const detached_signature_B = sodium.crypto_box_open_easy_afternm(
      serverResponse2,
      new Uint8Array(24),
      sodium.crypto_hash_sha256(
        concat(
          this.network_identifier,
          shared_secret_ab,
          shared_secret_aB,
          shared_secret_Ab,
        ),
      ),
    );

    const verification2 = sodium.crypto_sign_verify_detached(
      detached_signature_B,
      concat(
        this.network_identifier,
        detached_signature_A,
        this.clientLongtermKeyPair.publicKey,
        sodium.crypto_hash_sha256(shared_secret_ab),
      ),
      server_longterm_pk,
    );

    if (!verification2) {
      throw new Error("Verification of the server's second response failed");
    }

    const serverToClientKey = sodium.crypto_hash_sha256(
      concat(
        sodium.crypto_hash_sha256(sodium.crypto_hash_sha256(
          concat(
            this.network_identifier,
            shared_secret_ab,
            shared_secret_aB,
            shared_secret_Ab,
          ),
        )),
        this.clientLongtermKeyPair.publicKey,
      ),
    );

    const clientToServerKey = sodium.crypto_hash_sha256(
      concat(
        sodium.crypto_hash_sha256(sodium.crypto_hash_sha256(
          concat(
            this.network_identifier,
            shared_secret_ab,
            shared_secret_aB,
            shared_secret_Ab,
          ),
        )),
        server_longterm_pk,
      ),
    );

    const network_identifier = this.network_identifier;
    const serverToClientNonce = sodium.crypto_auth(
      clientEphemeralKeyPair.publicKey,
      network_identifier,
    ).slice(0, 24);
    const clientToServerNonce = sodium.crypto_auth(
      server_ephemeral_pk,
      network_identifier,
    ).slice(0, 24);

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
    const connection = {
      closed: false,
      hello,
      serverResponse,
      serverResponse2,
      detached_signature_B,
      async *[Symbol.asyncIterator]() {
        while (!this.closed) {
          const nextValue = await this.read();
          if (nextValue.length > 0) {
            yield nextValue;
          }
        }
      },
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
      },
      async read() {
        const headerBox = await readBytes(conn, 34);
        const header = sodium.crypto_box_open_easy_afternm(
          headerBox,
          serverToClientNonce,
          serverToClientKey,
        );
        increment(serverToClientNonce);
        const bodyLength = header[0] * 0x100 + header[1];
        const authenticationBodyTag = header.slice(2);
        const encryptedBody = await readBytes(conn, bodyLength);
        const decodedBody = sodium.crypto_box_open_easy_afternm(
          concat(authenticationBodyTag, encryptedBody),
          serverToClientNonce,
          serverToClientKey,
        );
        increment(serverToClientNonce);
        return decodedBody;
      },
      async write(message: Uint8Array) {
        const headerNonce = new Uint8Array(clientToServerNonce);
        increment(clientToServerNonce);
        const bodyNonce = new Uint8Array(clientToServerNonce);
        increment(clientToServerNonce);
        const encryptedMessage = sodium.crypto_box_easy_afternm(
          message,
          bodyNonce,
          clientToServerKey,
        );
        const messageLengh = message.length;
        const messageLenghUiA = new Uint8Array([
          messageLengh >> 8,
          messageLengh % 0xFF,
        ]);
        const authenticationBodyTag = encryptedMessage.slice(0, 16);
        const encryptedHeader = sodium.crypto_box_easy_afternm(
          concat(messageLenghUiA, authenticationBodyTag),
          headerNonce,
          clientToServerKey,
        );

        await conn.write(concat(encryptedHeader, encryptedMessage.slice(16)));
      },
      async close() {
        this.closed = true;
        const byeMessage = sodium.crypto_box_easy_afternm(
          new Uint8Array(18),
          clientToServerNonce,
          clientToServerKey,
        );

        await conn.write(byeMessage);
        conn.close();
        _host.connections = _host.connections.filter((e) => e !== this);
      },
    };
    this.connections.push(connection);
    return connection;
  }
}
