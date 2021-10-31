import ScuttlebuttHost, { Config as ParentConfig } from "./ScuttlebuttHost.ts";
import TransportClient from "./comm/transport/TransportClient.ts";
import TransportServer from "./comm/transport/TransportServer.ts";
import NetTransport from "./comm/transport/net/NetTransport.ts";
import {
  fromBase64,
  log,
  path,
  sodium,
  toBase64,
} from "./util.ts";
import Agent from "./agents/Agent.ts";
import FeedsAgent from "./agents/feeds/FeedsAgent.ts";
import BlobsAgent from "./agents/blobs/BlobsAgent.ts";
import WsTransportClient from "./comm/transport/ws/WsTransportClient.ts";
import WsTransportServer from "./comm/transport/ws/WsTransportServer.ts";
import FsStorage from "./storage/FsStorage.ts";

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

  readonly agents = new Set<Agent>();

  feedsAgent: FeedsAgent;
  blobsAgent: BlobsAgent;

  constructor(
    readonly config: {
      transport?: { net?: { port: number }; ws?: { port: number } };
      autoConnectLocalPeers?: boolean;
      acceptIncomingConnections?: boolean;
      baseDir: string;
      dataDir: string;
    } & ParentConfig,
  ) {
    
    const followeesFile = path.join(config.baseDir, "followees.json");
    try {
      const followStrings = JSON.parse(
        Deno.readTextFileSync(followeesFile),
      );
      config.follow = config.follow
        ? config.follow.concat(followStrings)
        : followStrings;
    } catch (error) {
      log.debug(`Error reading ${followeesFile}: ${error}`);
    }

    const peersFile = path.join(config.baseDir, "peers.json");

    try {
      const peersFromFile = JSON.parse(Deno.readTextFileSync(peersFile));
      config.peers = config.peers
        ? config.peers.concat(peersFromFile)
        : peersFromFile;
    } catch (error) {
      log.debug(`Error reading ${peersFile}: ${error}`);
    }
    super(config);
    this.feedsAgent = this.createFeedsAgent();
    this.blobsAgent = this.createBlobsAgent();
    this.agents.add(this.feedsAgent);
    this.agents.add(this.blobsAgent);
    if (config.transport?.net) {
      this.transportClients.add(
        new NetTransport(config.transport?.net),
      );
      this.transportServers.add(
        new NetTransport(config.transport?.net),
      );
    }
    if (config.transport?.ws) {
      this.transportClients.add(
        new WsTransportClient(),
      );
      this.transportServers.add(
        new WsTransportServer(config.transport?.ws),
      );
    }
    if (config.autoConnectLocalPeers) {
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

  }
  protected createFeedsStorage() {
    return new FsStorage(this.config.dataDir);
  }

  protected createBlobsStorage() {
    return new FsStorage(this.config.dataDir);
  }

  protected getClientKeyPair() {
    return getClientKeyPair(this.config.baseDir);
  }
}

function getClientKeyPair(baseDir: string) {
  const secretFilePath = path.join(baseDir, "secret");
  try {
    const secretText = Deno.readTextFileSync(secretFilePath);
    const secretTextNoComments = secretText.split("\n").filter((line) =>
      line.charAt(0) !== "#"
    ).join("\n");
    const secret = JSON.parse(secretTextNoComments);
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
      Deno.mkdirSync(baseDir, { recursive: true });
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
