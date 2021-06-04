import * as base64 from 'https://denopkg.com/chiefbiiko/base64/mod.ts';
import sodium from 'https://deno.land/x/sodium/sumo.ts';
import { concat } from './util.ts'


await sodium.ready;

export default class SsbHost {
    network_identifier = base64.toUint8Array('1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=')
    clientLongtermKeyPair = sodium.crypto_sign_keypair('uint8array')

    async connect(address: { protocol: string, host: string, port: number, key: string }) {
        const clientEphemeralKeyPair = sodium.crypto_box_keypair("uint8array")
        const conn = await Deno.connect({ hostname: address.host, port: address.port });

        const clientHello = () => {
            const hmac = sodium.crypto_auth(clientEphemeralKeyPair.publicKey, this.network_identifier)
            const clientHelloMessage = new Uint8Array(hmac.length + clientEphemeralKeyPair.publicKey.length)
            clientHelloMessage.set(hmac)
            clientHelloMessage.set(clientEphemeralKeyPair.publicKey, hmac.length)
            return clientHelloMessage
        }
        
        
        
        const authenticate = (server_longterm_pk: Uint8Array,
            shared_secret_ab: Uint8Array, shared_secret_aB: Uint8Array) => {
            // 3. Client authenticate
            const shared_secret_ab_sha256 = sodium.crypto_hash_sha256(shared_secret_ab)
            const msg = concat(this.network_identifier, server_longterm_pk, shared_secret_ab_sha256)
            const detached_signature_A = sodium.crypto_sign_detached(msg, this.clientLongtermKeyPair.privateKey)
            const boxMsg = new Uint8Array(detached_signature_A.length + this.clientLongtermKeyPair.publicKey.length)
            boxMsg.set(detached_signature_A)
            boxMsg.set(this.clientLongtermKeyPair.publicKey, detached_signature_A.length)
            const nonce = new Uint8Array(24)
            const boxKey = sodium.crypto_hash_sha256(concat(this.network_identifier, shared_secret_ab, shared_secret_aB))
            conn.write(sodium.crypto_secretbox_easy(boxMsg, nonce, boxKey))
            return detached_signature_A
        }

        
        const hello = clientHello()
        await conn.write(hello);
        const serverResponse = new Uint8Array(64);
        await conn.read(serverResponse);
        const server_hmac = serverResponse.subarray(0, 32)
        const server_ephemeral_pk = serverResponse.subarray(32, 64)
        const verification = sodium.crypto_auth_verify(server_hmac, server_ephemeral_pk, this.network_identifier)
        const shared_secret_ab = sodium.crypto_scalarmult(
            clientEphemeralKeyPair.privateKey,
            server_ephemeral_pk
        )

        const shared_secret_aB = sodium.crypto_scalarmult(
            clientEphemeralKeyPair.privateKey,
            sodium.crypto_sign_ed25519_pk_to_curve25519(base64.toUint8Array(address.key))
        )
        const server_longterm_pk = base64.toUint8Array(address.key)
        const detached_signature_A = authenticate(server_longterm_pk, shared_secret_ab, shared_secret_aB)

        const shared_secret_Ab = sodium.crypto_scalarmult(
            sodium.crypto_sign_ed25519_sk_to_curve25519(this.clientLongtermKeyPair.privateKey),
            server_ephemeral_pk
        )

        const serverResponse2 = new Uint8Array(80); //why 80?
        await conn.read(serverResponse2);

        const detached_signature_B = sodium.crypto_box_open_easy_afternm(
            serverResponse2,
            new Uint8Array(24),
            sodium.crypto_hash_sha256(
                concat(
                    this.network_identifier,
                    shared_secret_ab,
                    shared_secret_aB,
                    shared_secret_Ab
                )
            )
        )

        const verification2 = sodium.crypto_sign_verify_detached(
            detached_signature_B,
            concat(
                this.network_identifier,
                detached_signature_A,
                this.clientLongtermKeyPair.publicKey,
                sodium.crypto_hash_sha256(shared_secret_ab)
            ),
            server_longterm_pk
        )

        // Respond
        await conn.write(new TextEncoder().encode('pong'))
        conn.close(); //not yet actually
        const connection = {
            hello, serverResponse, verification, serverResponse2, detached_signature_B, verification2
        }
        return connection
    }
}




