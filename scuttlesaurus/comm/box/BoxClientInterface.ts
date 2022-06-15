//deno-lint-ignore-file camelcase
import {
  Address,
  concat,
  FeedId,
  fromBase64,
  readBytes,
  sodium,
} from "../../util.ts";
import BoxConnection from "./BoxConnection.ts";
import CommClientInterface from "../CommClientInterface.ts";
import TransportClient from "../transport/TransportClient.ts";

/** A peer with an identity and the abity to connect to other peers using the Secure Scuttlebutt Handshake */
export default class BoxClientInterface
  implements CommClientInterface<BoxConnection> {
  id;

  constructor(
    public readonly transports: TransportClient[],
    public readonly keyPair: {
      publicKey: Uint8Array;
      privateKey: Uint8Array;
    },
    public readonly networkIdentifier: Uint8Array = fromBase64(
      "1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=",
    ),
  ) {
    this.id = new FeedId(this.keyPair.publicKey);
  }

  connections: BoxConnection[] = [];

  /** perform handshake as client */
  async connect(
    address: Address,
  ) {
    // deno-lint-ignore no-this-alias
    const _host = this;
    const clientEphemeralKeyPair = sodium.crypto_box_keypair("uint8array");
    const matchingTransports = this.transports.filter((t) =>
      t.protocols.includes(address.protocol)
    );
    if (matchingTransports.length === 0) {
      throw new Error("No transport for " + address.protocol);
    }
    const conn = await Promise.any(matchingTransports.map((t) => {
      return t.connect(address).catch((e) => {
        console.debug(
          `Error connecting with transport ${t.constructor.name}: ${e}`,
        );
        return Promise.reject(e);
      });
    }));

    const clientHello = () => {
      const hmac = sodium.crypto_auth(
        clientEphemeralKeyPair.publicKey,
        this.networkIdentifier,
      );
      return concat(hmac, clientEphemeralKeyPair.publicKey);
    };

    const authenticate = async (
      server_longterm_pk: Uint8Array,
      shared_secret_ab: Uint8Array,
      shared_secret_aB: Uint8Array,
    ) => {
      // 3. Client authenticate
      const shared_secret_ab_sha256 = sodium.crypto_hash_sha256(
        shared_secret_ab,
      );
      const msg = concat(
        this.networkIdentifier,
        server_longterm_pk,
        shared_secret_ab_sha256,
      );
      const detached_signature_A = sodium.crypto_sign_detached(
        msg,
        this.keyPair.privateKey,
      );
      const boxMsg = new Uint8Array(
        detached_signature_A.length +
          this.keyPair.publicKey.length,
      );
      boxMsg.set(detached_signature_A);
      boxMsg.set(
        this.keyPair.publicKey,
        detached_signature_A.length,
      );
      const nonce = new Uint8Array(24);
      const boxKey = sodium.crypto_hash_sha256(
        concat(
          this.networkIdentifier,
          shared_secret_ab,
          shared_secret_aB,
        ),
      );
      await conn.write(sodium.crypto_secretbox_easy(boxMsg, nonce, boxKey));
      return detached_signature_A;
    };

    const hello = clientHello();
    await conn.write(hello);
    const serverResponse = await readBytes(conn, 64);
    const server_hmac = serverResponse.subarray(0, 32);
    const server_ephemeral_pk = serverResponse.subarray(32, 64);
    if (
      !sodium.crypto_auth_verify(
        server_hmac,
        server_ephemeral_pk,
        this.networkIdentifier,
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
      sodium.crypto_sign_ed25519_pk_to_curve25519(address.key),
    );
    const server_longterm_pk = address.key;
    const detached_signature_A = await authenticate(
      server_longterm_pk,
      shared_secret_ab,
      shared_secret_aB,
    );

    const shared_secret_Ab = sodium.crypto_scalarmult(
      sodium.crypto_sign_ed25519_sk_to_curve25519(
        this.keyPair.privateKey,
      ),
      server_ephemeral_pk,
    );

    const serverResponse2 = await readBytes(conn, 80); //msg4 in protocol guide

    const detached_signature_B = sodium.crypto_box_open_easy_afternm(
      serverResponse2,
      new Uint8Array(24),
      sodium.crypto_hash_sha256(
        concat(
          this.networkIdentifier,
          shared_secret_ab,
          shared_secret_aB,
          shared_secret_Ab,
        ),
      ),
    );

    const verification2 = sodium.crypto_sign_verify_detached(
      detached_signature_B,
      concat(
        this.networkIdentifier,
        detached_signature_A,
        this.keyPair.publicKey,
        sodium.crypto_hash_sha256(shared_secret_ab),
      ),
      server_longterm_pk,
    );

    if (!verification2) {
      throw new Error("Verification of the server's second response failed");
    }

    const combinedSharedSecret = sodium.crypto_hash_sha256(
      sodium.crypto_hash_sha256(
        concat(
          this.networkIdentifier,
          shared_secret_ab,
          shared_secret_aB,
          shared_secret_Ab,
        ),
      ),
    );

    const connection = new BoxConnection(
      conn,
      combinedSharedSecret,
      this.keyPair.publicKey,
      server_longterm_pk,
      clientEphemeralKeyPair.publicKey,
      server_ephemeral_pk,
      this.networkIdentifier,
    );
    this.connections.push(connection);
    connection.addEventListener("close", () => {
      console.debug(
        `closed outbound connection to ${connection.peer}, one of ${this.connections.length}`,
      );
      this.connections = this.connections.filter((c) => c !== connection);
    });
    return connection;
  }
}
