import { Application, Router, isHttpError, Status } from "https://deno.land/x/oak/mod.ts";
import * as base64 from "https://denopkg.com/chiefbiiko/base64/mod.ts";
import sodium from "https://deno.land/x/sodium/sumo.ts";

const network_identifier = base64.toUint8Array("1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=");

await sodium.ready;

const clientLongtermKeyPair = sodium.crypto_sign_keypair("uint8array")


const clientEphemeralKeyPair = sodium.crypto_box_keypair("uint8array")


const router = new Router();
router
  .get("/", (ctx) => {
    let responseBody = ''
    responseBody += `<h1>SBB Peers</h1>`
    log(JSON.stringify(peerAddresses))
    for (const [host, addresses] of peerAddresses) {
      responseBody += `<li>${host}
        <ul>
          ${addresses.map(v => `<li>${v}<a href="/shake-hands/${v.replaceAll('/','_')}">shake hands</a></li>`)}
        </ul>  
      </li>`
    }
    ctx.response.type = 'html'
    ctx.response.body = responseBody
  })
  .get("/shake-hands/:addressParam", async (ctx) => {
    ctx.response.type = 'html'
    if (!ctx.params.addressParam) {
      ctx.response.status = 400
    } else {
      const addressString = ctx.params.addressParam.replaceAll('_','/')
      const address = parseAddress(addressString)
      const conn = await Deno.connect({ hostname: address.host, port: address.port});
      const hello = clientHello()
      await conn.write(hello);
      const serverResponse = new Uint8Array(64);
      await conn.read(serverResponse);
      const server_hmac = serverResponse.subarray(0, 32)
      const server_ephemeral_pk = serverResponse.subarray(32, 64)
      const verification = sodium.crypto_auth_verify(server_hmac, server_ephemeral_pk, network_identifier)
      const shared_secret_ab = sodium.crypto_scalarmult(
        clientEphemeralKeyPair.privateKey,
        server_ephemeral_pk
      )
      
      const shared_secret_aB = sodium.crypto_scalarmult(
        clientEphemeralKeyPair.privateKey,
        sodium.crypto_sign_ed25519_pk_to_curve25519(base64.toUint8Array(address.key))
      )
      const server_longterm_pk = base64.toUint8Array(address.key)
      const detached_signature_A = authenticate(conn, server_longterm_pk, shared_secret_ab, shared_secret_aB)
      
      const shared_secret_Ab = sodium.crypto_scalarmult(
        sodium.crypto_sign_ed25519_sk_to_curve25519(clientLongtermKeyPair.privateKey),
        server_ephemeral_pk
      )

      const serverResponse2 = new Uint8Array(80); //why 80?
      await conn.read(serverResponse2);

      const detached_signature_B = sodium.crypto_box_open_easy_afternm(
        serverResponse2,
        new Uint8Array(24),
        sodium.crypto_hash_sha256(
          concat(
            network_identifier,
            shared_secret_ab,
            shared_secret_aB,
            shared_secret_Ab
          )
        )
      )

      const verification2 = sodium.crypto_sign_verify_detached(
        detached_signature_B,
        concat(
          network_identifier,
          detached_signature_A,
          clientLongtermKeyPair.publicKey,
          sodium.crypto_hash_sha256(shared_secret_ab)
        ),
        server_longterm_pk
      )

      log('Server - received:', base64.fromUint8Array(serverResponse))
      // Respond
      await conn.write(new TextEncoder().encode('pong'))
      conn.close();
      log(base64.fromUint8Array(clientHello()));
      ctx.response.body = `
      Client id: @${base64.fromUint8Array(clientLongtermKeyPair.publicKey)}.ed25519<p>
      ${JSON.stringify(address)} shaking ${addressString}<p> 
      Sent: ${hello}<p>
      Got: ${serverResponse}<p>
      Verification: ${verification}<p>
      Then got: ${serverResponse2}<p>
      detached_signature_B: ${detached_signature_B}<br/>
      Verification2: ${verification2}<p>
      `;
    }
  });

const app = new Application();

// Logger
app.use(async (ctx, next) => {
  await next();
  const rt = ctx.response.headers.get("X-Response-Time");
  console.log(`${ctx.request.method} ${ctx.request.url} - ${rt}`);
});

// Timing
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  ctx.response.headers.set("X-Response-Time", `${ms}ms`);
});

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.response.body = err.toString()
    if (isHttpError(err)) {
      ctx.response.status = err.status
    } else {
      ctx.response.status = Status.InternalServerError
    }
  }
});

const logMessages: string[] = []

function log(...msg: any[]) {
  logMessages.push(msg.map(o => o.toString()).join(', '))
}


const peerAddresses: Map<string, string[]> = new Map()


const l = Deno.listenDatagram({ port: 8008, hostname: "0.0.0.0", transport: "udp" });
console.log(`Listening on ${(l.addr as Deno.NetAddr).hostname}:${(l.addr as Deno.NetAddr).port}.`);

app.use(router.routes());
app.use(router.allowedMethods());

app.listen({ port: 8000 });


for await (const r of l) {
  const multiAddress = (new TextDecoder()).decode(r[0])
  const addresses = multiAddress.split(';')
  addresses.forEach(log)
  peerAddresses.set((r[1] as Deno.NetAddr).hostname, addresses)
  log(`got UDP packet ${multiAddress} from ${(r[1] as Deno.NetAddr).hostname}:${(r[1] as Deno.NetAddr).port}.`);
}




function clientHello() {
  const hmac = sodium.crypto_auth(clientEphemeralKeyPair.publicKey, network_identifier)
  const clientHelloMessage = new Uint8Array(hmac.length + clientEphemeralKeyPair.publicKey.length)
  clientHelloMessage.set(hmac)
  clientHelloMessage.set(clientEphemeralKeyPair.publicKey, hmac.length)
  return clientHelloMessage
}

function parseAddress(addr: string) {
  const sections = addr.split(':')
  const [protocol, host, portshs, key] = sections
  const port = parseInt(portshs.split('~')[0])
  return {protocol, host, port, key}
}

function concat(...elems : Uint8Array[]) : Uint8Array{
  const result = new Uint8Array(elems.reduce((sum, elem) => sum+(elem.length), 0))
  let pos = 0
  for (const elem of elems) {
    result.set(elem, pos)
    pos += elem.length
  }
  return result
}

function authenticate(conn: Deno.Conn,server_longterm_pk: Uint8Array,
      shared_secret_ab: Uint8Array,shared_secret_aB: Uint8Array) {
  // 3. Client authenticate
  const shared_secret_ab_sha256 = sodium.crypto_hash_sha256(shared_secret_ab)
  const msg  = concat(network_identifier, server_longterm_pk,shared_secret_ab_sha256)
  const detached_signature_A = sodium.crypto_sign_detached(msg, clientLongtermKeyPair.privateKey)
  const boxMsg = new Uint8Array(detached_signature_A.length + clientLongtermKeyPair.publicKey.length)
  boxMsg.set(detached_signature_A)
  boxMsg.set(clientLongtermKeyPair.publicKey, detached_signature_A.length)
  const nonce = new Uint8Array(24)
  const boxKey = sodium.crypto_hash_sha256(concat(network_identifier, shared_secret_ab, shared_secret_aB))
  conn.write(sodium.crypto_secretbox_easy(boxMsg, nonce, boxKey))
  return detached_signature_A
}
