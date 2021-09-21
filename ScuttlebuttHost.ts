import Transport from "./comm/transport/Transport.ts";
import NetTransport from "./comm/transport/NetTransport.ts";
import BoxInterface from "./comm/box/BoxInterface.ts";
import RpcInterface from "./comm/rpc/RpcInterface.ts";
import RpcMethodsHandler from "./comm/rpc/RpcMethodsHandler.ts";
import { FeedId, log } from "./util.ts";
import Agent from "./agents/Agent.ts";
import FeedsAgent from "./agents/feeds/FeedsAgent.ts";
import BlobsAgent from "./agents/blobs/BlobsAgent.ts";

/** A host communicating to peers using the Secure Scuttlebutt protocol */
export default class ScuttlebuttHost {
  readonly transports = new Map<string, Transport>();

  feedsAgent = new FeedsAgent();
  blobsAgent = new BlobsAgent();

  constructor(readonly config: Record<string, unknown>) {
    const options = config.port
      ? {
        port: config.port as number,
      }
      : undefined;
    this.addTransport(
      new NetTransport(options),
    );

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

  addTransport(transport: Transport) {
    this.transports.set(transport.protocol, transport);
  }

  async start() {
    log.info(`Starting SSB Host`);
    const agents: Agent[] = this.getAgents();
    const boxInterface = new BoxInterface([...this.transports.values()]);
    //there are incoming connections, connections established explicitely by user, connections initiated by the feeds- or blobs-subsystem
    //incoming procedures call are handled by a RequestHandler provided by the subsystem for a specific peer
    //subsystem can send request over any connection and are notified on new connectins
    const rpcInterface = new RpcInterface(
      (feedId: FeedId) =>
        new RpcMethodsHandler(
          agents.map((agent) => agent.createRpcContext(feedId)),
        ),
      boxInterface,
    );
    agents.forEach((agent) => agent.start(rpcInterface));
    for await (const rpcConnection of rpcInterface.listen()) {
      Promise.all(
        agents.map((agent) => agent.incomingConnection(rpcConnection)),
      );
    }
  }

  getAgents() {
    return [this.feedsAgent, this.blobsAgent];
  }
}
