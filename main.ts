import { Application, Router, isHttpError, Status } from "https://deno.land/x/oak/mod.ts";
import * as base64 from "https://denopkg.com/chiefbiiko/base64/mod.ts";
import SsbHost from './SsbHost.ts'
import { parseAddress } from './util.ts'


const host = new SsbHost()



const router = new Router();
router
  .get("/", (ctx) => {
    let responseBody = ''
    responseBody += `<h1>SBB Peers</h1>`
    log(JSON.stringify(peerAddresses))
    for (const [host, addresses] of peerAddresses) {
      responseBody += `<li>${host}
        <ul>
          ${addresses.map(v => `<li>${v}<a href="/shake-hands/${v.replaceAll('/', '_')}">shake hands</a></li>`)}
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
      const addressString = ctx.params.addressParam.replaceAll('_', '/')
      const address = parseAddress(addressString)      
      const connection = await host.connect(address)

      ctx.response.body = `
      Client id: @${base64.fromUint8Array(host.clientLongtermKeyPair.publicKey)}.ed25519<p>
      ${JSON.stringify(address)} shaking ${addressString}<p> 
      Sent: ${connection.hello}<p>
      Got: ${connection.serverResponse}<p>
      Verification: ${connection.verification}<p>
      Then got: ${connection.serverResponse2}<p>
      detached_signature_B: ${connection.detached_signature_B}<br/>
      Verification2: ${connection.verification2}<p>
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

function log(...msg: {toString: () => string}[]) {
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


