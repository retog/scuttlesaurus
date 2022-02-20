import TransportClient from "./comm/transport/TransportClient.ts";
import TransportServer from "./comm/transport/TransportServer.ts";
import BoxClientInterface from "./comm/box/BoxClientInterface.ts";
import BoxServerInterface from "./comm/box/BoxServerInterface.ts";
import RpcClientInterface from "./comm/rpc/RpcClientInterface.ts";
import RpcServerInterface from "./comm/rpc/RpcServerInterface.ts";
import RpcMethodsHandler from "./comm/rpc/RpcMethodsHandler.ts";
import {
  Address,
  computeMsgHash,
  FeedId,
  fromBase64,
  JSONValue,
  KeyPair,
  log,
  ObservableSet,
  parseAddress,
  parseFeedId,
  sodium,
  toBase64,
  TSEMap,
} from "./util.ts";
import Agent from "./agents/Agent.ts";
import FeedsAgent, { Message } from "./agents/feeds/FeedsAgent.ts";
import BlobsAgent from "./agents/blobs/BlobsAgent.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import BlobsStorage from "./storage/BlobsStorage.ts";
import ConnectionManager from "./agents/ConnectionManager.ts";

const textEncoder = new TextEncoder();

/** A host communicating to peers using the Secure Scuttlebutt protocol.
 *
 * By concrete implementations of this class provide storage layers for the `feeds` and the `blobs`
 * sub-protocols by implementing createFeedsStorage and createBlobsStorage. They also provide the
 * identity key-pair by implementing getClientKeyPair()
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
  /** peers excluded after failures */
  readonly excludedPeers = new ObservableSet<Address>();
  private readonly failingAddresses = new TSEMap<Address, {
    lastFailure: number;
    failureCount: number;
  }>();

  feedsAgent: FeedsAgent | undefined;
  blobsAgent: BlobsAgent | undefined;
  feedsStorage: FeedsStorage;
  blobsStorage: BlobsStorage;
  identity: FeedId;

  constructor(
    readonly config: Config,
  ) {
    this.config.failureRelevanceInterval ??= DURATION.DAY;
    this.identity = new FeedId(this.getClientKeyPair().publicKey);
    this.followees.add(this.identity);
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
    this.feedsStorage = this.createFeedsStorage();
    this.blobsStorage = this.createBlobsStorage();
    this.feedsAgent = new FeedsAgent(
      this.feedsStorage,
      this.followees,
      this.peers,
    );
    this.blobsAgent = new BlobsAgent(this.blobsStorage);
    if (this.feedsAgent) this.agents.add(this.feedsAgent);
    if (this.blobsAgent) this.agents.add(this.blobsAgent);
  }

  protected abstract createFeedsStorage(): FeedsStorage;

  protected abstract createBlobsStorage(): BlobsStorage;

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
      (address: Address, failure: boolean) => {
        if (!failure) {
          this.failingAddresses.delete(address);
        } else {
          const failuresReport = this.failingAddresses.get(address);
          if (failuresReport) {
            if (
              failuresReport.lastFailure +
                  this.config.failureRelevanceInterval! < Date.now()
            ) {
              if (failuresReport.failureCount > 4) {
                this.peers.delete(address);
                this.excludedPeers.add(address);
              } else {
                this.failingAddresses.set(address, {
                  failureCount: failuresReport.failureCount + 1,
                  lastFailure: Date.now(),
                });
              }
            }
          } else {
            this.failingAddresses.set(address, {
              failureCount: 1,
              lastFailure: Date.now(),
            });
          }
        }
      },
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

  async publish(
    content: JSONValue,
  ) {
    const previousSeq = await this.feedsStorage.lastMessage(this.identity);
    const previous = previousSeq > 0
      ? (await this.feedsStorage.getMessage(
        this.identity,
        previousSeq,
      )).key
      : false;
    const sequence = previousSeq + 1;
    const msgValue: JSONValue = {
      previous,
      sequence,
      author: this.identity.toString(),
      timestamp: Date.now(),
      hash: "sha256",
      content,
    };
    if (!previous) {
      delete msgValue.previous;
    }
    this.signMessage(msgValue);
    const hash = computeMsgHash(msgValue);
    const msg: JSONValue = {
      key: `%${toBase64(hash)}.sha256`,
      value: msgValue,
      timestamp: Date.now(),
    };
    this.feedsStorage.storeMessage(this.identity, sequence, msg);
    this.feedsAgent?.fireNewMessageEvent(this.identity, msg as Message);
  }

  private signMessage(
    msgValue: Record<string, unknown>,
  ): Record<string, unknown> {
    const messageData = textEncoder.encode(
      JSON.stringify(msgValue, undefined, 2),
    );
    const signature = sodium.crypto_sign_detached(
      messageData,
      this.getClientKeyPair().privateKey,
    );
    msgValue["signature"] = toBase64(signature) + ".sig.ed25519";
    return msgValue;
  }
}

export type Config = {
  networkIdentifier?: string;
  follow?: string[];
  peers?: string[];
  /** minimum interval between two connection failures to count */
  failureRelevanceInterval?: number;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const DURATION = { SECOND, MINUTE, HOUR, DAY, WEEK };
