// deno-lint-ignore-file camelcase
import sodium from "https://deno.land/x/sodium@0.2.0/sumo.ts";
import { concat, fromBase64, readBytes, toBase64 } from "./util.ts";
import BoxConnection from "./BoxConnection.ts";

await sodium.ready;

export default class SsbHost {
  network_identifier = fromBase64(
    "1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=",
  );
  clientLongtermKeyPair = getClientKeyPair();
  id = "@" +
    toBase64(
      this.clientLongtermKeyPair.publicKey,
    );

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
    const serverResponse = await readBytes(conn, 64);
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
        fromBase64(address.key),
      ),
    );
    const server_longterm_pk = fromBase64(
      address.key,
    );
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

    const connection = new BoxConnection(
      conn,
      serverToClientKey,
      serverToClientNonce,
      clientToServerKey,
      clientToServerNonce,
    );
    this.connections.push(connection);
    return connection;
  }
}

function getClientKeyPair() {
  const secretFileDir = Deno.env.get("HOME") + "/.ssb/";
  const secretFilePath = secretFileDir + "secret";
  try {
    const secret = JSON.parse(Deno.readTextFileSync(secretFilePath));
    return {
      keyType: secret.curve,
      publicKey: fromBase64(
        secret.public.substring(0, secret.public.length - ".ed25519".length),
      ),
      privateKey: fromBase64(
        secret.private.substring(0, secret.private.length - ".ed25519".length),
      ),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      const newKey = sodium.crypto_sign_keypair("uint8array");
      const secret = {
        public: toBase64(newKey.publicKey) + ".ed25519",
        "private": toBase64(newKey.privateKey) + ".ed25519",
        curve: newKey.keyType,
      };
      Deno.mkdirSync(secretFileDir, { recursive: true });
      Deno.writeTextFileSync(
        secretFilePath,
        JSON.stringify(secret, undefined, 2),
      );
      return newKey;
    } else {
      // unexpected error, pass it along
      throw error;
    }
  }
}
