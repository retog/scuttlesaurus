import TransportClient from "./comm/transport/TransportClient.ts";
import TransportServer from "./comm/transport/TransportServer.ts";
import BoxClientInterface from "./comm/box/BoxClientInterface.ts";
import BoxServerInterface from "./comm/box/BoxServerInterface.ts";
import RpcClientInterface from "./comm/rpc/RpcClientInterface.ts";
import RpcServerInterface from "./comm/rpc/RpcServerInterface.ts";
import RpcMethodsHandler from "./comm/rpc/RpcMethodsHandler.ts";
import {
Address,
  FeedId,
  fromBase64,
  KeyPair,
  log,
  ObservableSet,
  parseAddress,
  parseFeedId,
} from "./util.ts";
import Agent from "./agents/Agent.ts";
import FeedsAgent from "./agents/feeds/FeedsAgent.ts";
import BlobsAgent from "./agents/blobs/BlobsAgent.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import BlobsStorage from "./storage/BlobsStorage.ts";
import ConnectionManager from "./agents/ConnectionManager.ts";

/** A host communicating to peers using the Secure Scuttlebutt protocol.
 *
 * By concrete implementations of this class provide Agents for the `feeds` and the `blobs`
 * sub-protocols by impelemnting createFeedsAgent and createBlobsAgent.
 *
 * Consumers can interact with the default agents via the fields `feedsAgent` and `blobsAgent`.
 *
 * Additional agents or transports can be added to the respective fields before invokig `start`.
 */
export default abstract class ScuttlebuttHost {
  readonly transportClients = new Set<TransportClient>();
  readonly transportServers = new Set<TransportServer>();

  readonly agents = new Set<Agent>();

  /** Maintained here as they might be used by several agents */
  readonly followees = new ObservableSet<FeedId>();
  readonly peers = new ObservableSet<Address>();

  feedsAgent: FeedsAgent | undefined;
  blobsAgent: BlobsAgent | undefined;

  constructor(
    readonly config: Config,
  ) {
    if (this.config.follow) {
      this.config.follow.forEach((feedIdStr) =>
        this.followees.add(parseFeedId(feedIdStr))
      );
    }
    if (this.config.peers) {
      this.config.peers.forEach((addrStr) =>
        this.peers.add(parseAddress(addrStr))
      );
    }
    this.feedsAgent = this.createFeedsAgent();
    this.blobsAgent = this.createBlobsAgent();
    if (this.feedsAgent) this.agents.add(this.feedsAgent);
    if (this.blobsAgent) this.agents.add(this.blobsAgent);
  }

  protected createFeedsAgent(): FeedsAgent | undefined {
    const storage = this.createFeedsStorage();
    return new FeedsAgent(
      storage,
      this.followees,
      this.peers,
    );
  }

  protected abstract createFeedsStorage(): FeedsStorage;

  protected abstract createBlobsStorage(): BlobsStorage;

  protected createBlobsAgent(): BlobsAgent | undefined {
    const storage = this.createBlobsStorage();
    return new BlobsAgent(storage);
  }

  protected abstract getClientKeyPair(): KeyPair;

  connectionManager: ConnectionManager | undefined;

  async start() {
    log.info(`Starting SSB Host`);
    if (this.transportClients.size + this.transportServers.size === 0) {
      log.warning(
        "No transport set, this host is unable to communicate with peers.",
      );
    }
    const agents: Agent[] = [...this.agents];
    const boxClientInterface = new BoxClientInterface(
      [...this.transportClients],
      this.getClientKeyPair(),
      this.config.networkIdentifier
        ? fromBase64(this.config.networkIdentifier)
        : undefined,
    );
    const boxServerInterface = new BoxServerInterface(
      [...this.transportServers],
      this.getClientKeyPair(),
      this.config.networkIdentifier
        ? fromBase64(this.config.networkIdentifier)
        : undefined,
    );
    const rpcClientInterface = new RpcClientInterface(
      (feedId: FeedId) =>
        new RpcMethodsHandler(
          agents.map((agent) => agent.createRpcContext(feedId)),
        ),
      boxClientInterface,
    );
    const rpcServerInterface = new RpcServerInterface(
      (feedId: FeedId) =>
        new RpcMethodsHandler(
          agents.map((agent) => agent.createRpcContext(feedId)),
        ),
      boxServerInterface,
    );
    this.connectionManager = new ConnectionManager(
      rpcClientInterface,
      rpcServerInterface,
    );
    agents.forEach(async (agent) => {
      try {
        await agent.start(this.connectionManager!);
      } catch (error) {
        log.warning(
          `Error starting agent ${agent.constructor.name}: ${error}`,
        );
      }
    });

    (async () => {
      for await (
        const rpcConnection of this.connectionManager!.outgoingConnections()
      ) {
        Promise.all(
          agents.map(async (agent) => {
            try {
              await agent.outgoingConnection(rpcConnection);
            } catch (error) {
              log.warning(
                `Error with agent ${agent.constructor.name} handling incoming connection: ${error}`,
              );
            }
          }),
        );
      }
    })();

    for await (const rpcConnection of this.connectionManager.listen()) {
      Promise.all(
        agents.map(async (agent) => {
          try {
            await agent.incomingConnection(rpcConnection);
          } catch (error) {
            log.warning(
              `Error with agent ${agent.constructor.name} handling incoming connection: ${error}`,
            );
          }
        }),
      );
    }
  }
}

export type Config = {
  networkIdentifier?: string;
  follow?: string[];
  peers?: string[];
};
