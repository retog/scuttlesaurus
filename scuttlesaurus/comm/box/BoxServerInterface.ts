//deno-lint-ignore-file camelcase
import {
  combine,
  concat,
  FeedId,
  fromBase64,
  log,
  readBytes,
  sodium,
} from "../../util.ts";
import BoxConnection from "./BoxConnection.ts";
import CommServerInterface from "../CommServerInterface.ts";

/** A peer with an identity and the abity to connect to other peers using the Secure Scuttlebutt Handshake */
export default class BoxServerInterface
  implements CommServerInterface<BoxConnection> {
  id;

  constructor(
    public readonly transports: CommServerInterface<
      Deno.Reader & Deno.Writer & Deno.Closer
    >[],
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

  /** perform handshake as server */
  async acceptConnection(
    conn: Deno.Reader & Deno.Writer & Deno.Closer,
  ): Promise<BoxConnection> {
    const serverEphemeralKeyPair = sodium.crypto_box_keypair("uint8array");
    const clientHello = await readBytes(conn, 64);
    const client_hmac = clientHello.subarray(0, 32);
    const client_ephemeral_pk = clientHello.subarray(32, 64);
    if (
      !sodium.crypto_auth_verify(
        client_hmac,
        client_ephemeral_pk,
        this.networkIdentifier,
      )
    ) {
      throw new Error("Verification of the client's hello failed");
    }
    const serverHello = concat(
      sodium.crypto_auth(
        serverEphemeralKeyPair.publicKey,
        this.networkIdentifier,
      ),
      serverEphemeralKeyPair.publicKey,
    );
    await conn.write(serverHello);
    const shared_secret_ab = sodium.crypto_scalarmult(
      serverEphemeralKeyPair.privateKey,
      client_ephemeral_pk,
    );

    const shared_secret_aB = sodium.crypto_scalarmult(
      sodium.crypto_sign_ed25519_sk_to_curve25519(
        this.keyPair.privateKey,
      ),
      client_ephemeral_pk,
    );

    const msg3 = await readBytes(conn, 112);

    const msg3_plaintext = sodium.crypto_secretbox_open_easy(
      msg3,
      new Uint8Array(24),
      sodium.crypto_hash_sha256(
        concat(
          this.networkIdentifier,
          shared_secret_ab,
          shared_secret_aB,
        ),
      ),
    );

    if (msg3_plaintext.length !== 96) {
      throw Error("Invalid message length");
    }

    const detached_signature_A = msg3_plaintext.subarray(0, 64);
    const client_longterm_pk = msg3_plaintext.subarray(64, 96);

    const verification3 = sodium.crypto_sign_verify_detached(
      detached_signature_A,
      concat(
        this.networkIdentifier,
        this.keyPair.publicKey,
        sodium.crypto_hash_sha256(shared_secret_ab),
      ),
      client_longterm_pk,
    );
    if (!verification3) {
      throw new Error("Verification of the client's third message failed");
    }

    const shared_secret_Ab = sodium.crypto_scalarmult(
      serverEphemeralKeyPair.privateKey,
      sodium.crypto_sign_ed25519_pk_to_curve25519(client_longterm_pk),
    );
    const detached_signature_B = sodium.crypto_sign_detached(
      concat(
        this.networkIdentifier,
        detached_signature_A,
        client_longterm_pk,
        sodium.crypto_hash_sha256(shared_secret_ab),
      ),
      this.keyPair.privateKey,
    );
    const completionMsg = sodium.crypto_secretbox_easy(
      detached_signature_B,
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
    await conn.write(completionMsg);

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
      client_longterm_pk,
      serverEphemeralKeyPair.publicKey,
      client_ephemeral_pk,
      this.networkIdentifier,
    );
    this.connections.push(connection);
    connection.addEventListener("close", () => {
      log.debug(
        `closed incoming connection, one of ${this.connections.length}`,
      );
      this.connections = this.connections.filter((c) => c !== connection);
    });
    return connection;
  }

  async *listen(signal?: AbortSignal) {
    const iterator = combine(
      ...this.transports.map((i) => i.listen(signal)),
    );
    try {
      for await (
        const conn of {
          [Symbol.asyncIterator]: () => iterator,
        }
      ) {
        try {
          const boxConnection = await this.acceptConnection(conn);
          signal?.addEventListener("abort", () => {
            boxConnection.close();
          }, { once: true });
          yield boxConnection;
        } catch (error) {
          log.warning(
            `Error with incoming connection with remote ${
              JSON.stringify(
                (conn as unknown as { remoteAddr: unknown }).remoteAddr!,
              )
            }: ${error}\n${error.stack}`,
          );
        }
      }
    } catch (error) {
      log.warning(`iterating over combined transports: ${error}`);
    }
  }
}
