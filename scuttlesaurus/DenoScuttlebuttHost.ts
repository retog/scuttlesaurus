import {
  Application,
  Context,
  Router,
} from "https://deno.land/x/oak@v10.2.0/mod.ts";
import ScuttlebuttHost, { Config as ParentConfig } from "./ScuttlebuttHost.ts";
import TransportClient from "./comm/transport/TransportClient.ts";
import TransportServer from "./comm/transport/TransportServer.ts";
import NetTransport from "./comm/transport/net/NetTransport.ts";
import {
  parseAddress,
  parseFeedId,
  parseKeyPair,
  path,
  serializeKeyPair,
  sodium,
} from "./util.ts";
import WsTransportClient from "./comm/transport/ws/WsTransportClient.ts";
import WsTransportServer from "./comm/transport/ws/WsTransportServer.ts";
import FsStorage from "./storage/fs/FsStorage.ts";
import SubscriptionsAndPeersStorage from "./storage/SubscriptionsAndPeersStorage.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import BlobsStorage from "./storage/BlobsStorage.ts";
import LazyFsSubscriptionsAndPeersStorage from "./storage/fs/LazyFsSubscriptionsAndPeersStorage.ts";

/** A ScuttlebutHost with features avialable in a Deno enviornment such as File and Network access.
 *
 * By default instances of this class provide implementations (Agents) for the `feeds` and the `blobs`
 * sub-protocols with a file based storage. These can be configured with an object passed to the construcutor.
 *
 * Additional agents or transports can be added to the respective fields before invokig `start`.
 */
export default class DenoScuttlebuttHost extends ScuttlebuttHost {
  readonly transportClients = new Set<TransportClient>();
  readonly transportServers = new Set<TransportServer>();
  readonly webEndpoints: Record<
    string,
    { application: Application; router: Router }
  > = {};

  constructor(
    readonly config: {
      transport?: { net?: Deno.ListenOptions; ws?: { web: Array<string> } };
      autoConnectLocalPeers?: boolean;
      acceptIncomingConnections?: boolean;
      baseDir: string;
      dataDir?: string;
      web?: {
        control?: Deno.ListenOptions;
        access?: Deno.ListenOptions;
      };
    } & ParentConfig,
  ) {
    config.dataDir ??= path.join(config.baseDir, "data/");

    super(config);
    const exludedPeersFile = path.join(config.baseDir, "excluded-peers.json");
    try {
      const peersFromFile = JSON.parse(
        Deno.readTextFileSync(exludedPeersFile),
      );
      peersFromFile.forEach((addr: string) =>
        this.excludedPeers.add(parseAddress(addr))
      );
    } catch (error) {
      console.debug(`Error reading ${exludedPeersFile}: ${error}`);
    }
    const failingPeersFile = path.join(config.baseDir, "failing-peers.json");
    try {
      const failingPeersFromFile = JSON.parse(
        Deno.readTextFileSync(failingPeersFile),
      );
      failingPeersFromFile.forEach((entry: [string, {
        lastFailure: number;
        failureCount: number;
      }]) => {
        this.failingPeers.set(parseAddress(entry[0]), entry[1]);
      });
    } catch (error) {
      console.debug(`Error reading ${exludedPeersFile}: ${error}`);
    }

    {
      const writeExcludedPeersFile = () => {
        Deno.writeTextFileSync(
          exludedPeersFile,
          JSON.stringify([...this.excludedPeers], undefined, 2),
        );
      };
      this.excludedPeers.addAddListener(writeExcludedPeersFile);
      this.excludedPeers.addRemoveListener(writeExcludedPeersFile);
    }
    {
      const writeFailingPeersFile = () => {
        Deno.writeTextFileSync(
          failingPeersFile,
          JSON.stringify([...this.failingPeers], undefined, 2),
        );
      };
      this.failingPeers.addAddListener(writeFailingPeersFile);
      this.failingPeers.addRemoveListener(writeFailingPeersFile);
    }
  }

  async start(signal?: AbortSignal) {
    const initializeCommonRoutes = (router: Router) => {
      router.get("/whoami", (ctx: Context) => {
        ctx.response.body = JSON.stringify({
          feedId: this.identity,
        });
      });
    };
    const initializeWebEndpoints = (
      endpointConfigs: Record<string, Deno.ListenOptions>,
    ) => {
      for (const endpointName in endpointConfigs) {
        const endpoint = {
          application: new Application(),
          router: new Router(),
        };
        endpoint.application.use(endpoint.router.routes());
        endpoint.application.use(endpoint.router.allowedMethods());
        endpoint.application.listen({
          ...endpointConfigs[endpointName],
          signal,
        }).catch((
          e: unknown,
        ) => console.error(`Error with web endpoint ${endpointName}: ${e}`));
        initializeCommonRoutes(endpoint.router);
        this.webEndpoints[endpointName] = endpoint;
      }
    };
    if (this.config.web) {
      initializeWebEndpoints(this.config.web);
    }
    const initializeControlRoutes = (router: Router) => {
      router.get("/config", (ctx: Context) => {
        ctx.response.body = JSON.stringify(this.config);
      });
      router.post("/peers", async (ctx: Context) => {
        const { value } = ctx.request.body({ type: "json" });
        const { address, action } = await value;
        if (action === "remove") {
          this.subscriptionsAndPeersStorage.peers.delete(parseAddress(address));
          ctx.response.body = "Removed peer";
        } else {
          this.subscriptionsAndPeersStorage.peers.add(parseAddress(address));
          ctx.response.body = "Added peer";
        }
      });
      router.get("/peers", (ctx: Context) => {
        ctx.response.body = JSON.stringify([
          ...this.subscriptionsAndPeersStorage.peers,
        ]);
      });
      router.get("/excluded-peers", (ctx: Context) => {
        ctx.response.body = JSON.stringify([...this.excludedPeers]);
      });
      router.post("/followees", async (ctx: Context) => {
        const { value } = ctx.request.body({ type: "json" });
        const { id, action } = await value;
        if (action === "remove") {
          this.subscriptionsAndPeersStorage.subscriptions.delete(
            parseFeedId(id),
          );
          ctx.response.body = "Removed followee";
        } else {
          this.subscriptionsAndPeersStorage.subscriptions.add(parseFeedId(id));
          ctx.response.body = "Added followee";
        }
      });
      router.get("/followees", (ctx: Context) => {
        ctx.response.body = JSON.stringify([
          ...this.subscriptionsAndPeersStorage.subscriptions,
        ]);
      });
    };
    if (this.webEndpoints.control) {
      initializeControlRoutes(this.webEndpoints.control.router);
    }
    if (this.config.transport?.net) {
      this.transportClients.add(
        new NetTransport(this.config.transport?.net),
      );
      this.transportServers.add(
        new NetTransport(this.config.transport?.net),
      );
    }
    if (this.config.transport?.ws) {
      this.transportClients.add(
        new WsTransportClient(),
      );
      this.config.transport.ws.web ??= [];
      this.config.transport.ws.web.forEach((endpointName) => {
        this.transportServers.add(
          new WsTransportServer(this.webEndpoints[endpointName].application),
        );
      });
    }
    if (this.config.autoConnectLocalPeers) {
      /*  for await (const peer of udpPeerDiscoverer) {
        if (
          JSON.stringify(peerAddresses.get(peer.hostname)) !==
            JSON.stringify(peer.addresses)
        ) {
          peerAddresses.set(peer.hostname, peer.addresses);
          console.log(peer.addresses);
          //TODO check if bcm already has connection to peer, otherwise connect.
        }
      }
      */
    }
    await super.start(signal);
  }

  protected createFeedsStorage(): FeedsStorage | undefined {
    return new FsStorage(this.config.dataDir!);
  }

  protected createSubscriptionsAndPeersStorage(): SubscriptionsAndPeersStorage {
    return new LazyFsSubscriptionsAndPeersStorage(this.config.dataDir!);
  }

  protected createBlobsStorage(): BlobsStorage | undefined {
    return new FsStorage(this.config.dataDir!);
  }

  protected getClientKeyPair() {
    return getClientKeyPair(this.config.baseDir);
  }
}

function getClientKeyPair(baseDir: string) {
  const secretFilePath = path.join(baseDir, "secret");
  try {
    const secretText = Deno.readTextFileSync(secretFilePath);
    return parseKeyPair(secretText);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      const newKey = sodium.crypto_sign_keypair("uint8array");
      Deno.mkdirSync(baseDir, { recursive: true });
      Deno.writeTextFileSync(
        secretFilePath,
        serializeKeyPair(newKey),
      );
      return newKey;
    } else {
      // unexpected error, pass it along
      throw error;
    }
  }
}
