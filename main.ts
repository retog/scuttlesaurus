import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import * as ed from 'https://deno.land/x/ed25519/mod.ts';
import * as base64 from "https://denopkg.com/chiefbiiko/base64/mod.ts";
//https://github.com/denosaurs/sodium/blob/master/API.md
import sodium from "https://deno.land/x/sodium/basic.ts";

const privateKey = ed.utils.randomPrivateKey();
const publicKey = await ed.getPublicKey(privateKey);


await sodium.ready;

const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();

let res = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
let [state_out, header] = [res.state, res.header];
let c1 = sodium.crypto_secretstream_xchacha20poly1305_push(
  state_out,
  sodium.from_string("message 1"),
  null,
  sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
);
let c2 = sodium.crypto_secretstream_xchacha20poly1305_push(
  state_out,
  sodium.from_string("message 2"),
  null,
  sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
);

let state_in = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
  header,
  key,
);
let r1 = sodium.crypto_secretstream_xchacha20poly1305_pull(state_in, c1);
let [m1, tag1] = [sodium.to_string(r1.message), r1.tag];
let r2 = sodium.crypto_secretstream_xchacha20poly1305_pull(state_in, c2);
let [m2, tag2] = [sodium.to_string(r2.message), r2.tag];

console.log(m1);
console.log(m2);

const router = new Router();
router
  .get("/", (ctx) => {
    /*l.send(clientHello(),{
    port: 8008,
    hostname: '192.168.1.6',
    transport: "udp" 
  })*/
    /*const conn = await Deno.connect({ hostname: "192.168.1.6", port: 8008 });
    await conn.write(clientHello());
    const buf = new Uint8Array(1024);
    await conn.read(buf);
    log('Server - received:', base64.fromUint8Array(buf))
    // Respond
    await conn.write(new TextEncoder().encode('pong'))
    conn.close();
    log(base64.fromUint8Array(clientHello()));*/
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
    /*`
    ${logMessages.join('\n')}
    Hello World! By @${base64.fromUint8Array(publicKey)}.ed25519 and also ${base64.fromUint8Array(key)}`;*/
  })
  .get("/shake-hands/:addressParam", async (context) => {
    if (!context.params.addressParam) {
      context.response.status = 400
    } else {
      const addressString = context.params.addressParam.replaceAll('_','/')
      const address = parseAddress(addressString)
      const conn = await Deno.connect({ hostname: address.host, port: address.port});
      await conn.write(clientHello());
      const buf = new Uint8Array(1024);
      await conn.read(buf);
      log('Server - received:', base64.fromUint8Array(buf))
      // Respond
      await conn.write(new TextEncoder().encode('pong'))
      conn.close();
      log(base64.fromUint8Array(clientHello()));
      context.response.body = `${JSON.stringify(address)} shaking ${addressString} `;
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
  const client_ephemeral_pk = sodium.crypto_auth_keygen();
  const network_identifier = base64.toUint8Array("1KHLiKZvAvjbY1ziZEHMXawbCEIM6qwjCDm3VYRan/s=");
  const hmac = sodium.crypto_auth(client_ephemeral_pk, network_identifier)
  const clientHelloMessage = new Uint8Array(hmac.length + client_ephemeral_pk.length)
  clientHelloMessage.set(hmac)
  clientHelloMessage.set(client_ephemeral_pk, hmac.length)
  return clientHelloMessage
}

function parseAddress(addr: string) {
  const sections = addr.split(':')
  const [protocol, host, portshs, key] = sections
  const port = parseInt(portshs.split('~')[0])
  return {protocol, host, port, key}
}
