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
  ObservableMap,
  ObservableSet,
  parseAddress,
  parseFeedId,
  sodium,
  toBase64,
} from "./util.ts";
import Agent from "./agents/Agent.ts";
import FeedsAgent, { Message } from "./agents/feeds/FeedsAgent.ts";
import BlobsAgent from "./agents/blobs/BlobsAgent.ts";
import FeedsStorage from "./storage/FeedsStorage.ts";
import BlobsStorage from "./storage/BlobsStorage.ts";
import ConnectionManager from "./agents/ConnectionManager.ts";
import SubscriptionsAndPeersStorage from "./storage/SubscriptionsAndPeersStorage.ts";

const textEncoder = new TextEncoder();

/** A host communicating to peers using the Secure Scuttlebutt protocol.
 *
 * By concrete implementations of this class provide the identity key-pair by implementing
 * getClientKeyPair(). They also provide storage layers for the `feeds` and the `blobs`
 * sub-protocols by implementing createFeedsStorage and createBlobsStorage, as well as a storage for the
 * set of peers and subscriptionns by implementing createSubscriptionsAndPeersStorage
 *
 * Consumers can interact with the default agents via the fields `feedsAgent` and `blobsAgent`.
 *
 * Additional agents or transports can be added to the respective fields before invokig `start`.
 */
export default abstract class ScuttlebuttHost {
  readonly transportClients = new Set<TransportClient>();
  readonly transportServers = new Set<TransportServer>();

  readonly agents = new Set<Agent>();

  /** peers excluded after failures */
  readonly excludedPeers = new ObservableSet<Address>();
  readonly failingPeers = new ObservableMap<Address, {
    lastFailure: number;
    failureCount: number;
  }>();

  feedsAgent: FeedsAgent | undefined;
  blobsAgent: BlobsAgent | undefined;
  feedsStorage: FeedsStorage | undefined;
  subscriptionsAndPeersStorage: SubscriptionsAndPeersStorage;
  blobsStorage: BlobsStorage | undefined;
  identity: FeedId;

  constructor(
    readonly config: Config,
  ) {
    this.config.failureRelevanceInterval ??= DURATION.DAY;
    this.config.outgoingConnections ??= true;
    this.config.storeRankingTable ??= this.config.outgoingConnections;
    this.identity = new FeedId(this.getClientKeyPair().publicKey);
    this.subscriptionsAndPeersStorage = this
      .createSubscriptionsAndPeersStorage();
    this.subscriptionsAndPeersStorage.subscriptions.add(this.identity);
    if (this.config.subscriptions) {
      this.config.subscriptions.forEach((feedIdStr) =>
        this.subscriptionsAndPeersStorage.subscriptions.add(
          parseFeedId(feedIdStr),
        )
      );
    }
    if (this.config.peers) {
      this.config.peers.forEach((addrStr) =>
        this.subscriptionsAndPeersStorage.peers.add(parseAddress(addrStr))
      );
    }
    this.feedsStorage = this.createFeedsStorage();
    this.blobsStorage = this.createBlobsStorage();
    if (this.feedsStorage) {
      this.feedsAgent = new FeedsAgent(
        this.feedsStorage,
        this.subscriptionsAndPeersStorage,
      );
      this.agents.add(this.feedsAgent);
    }
    if (this.blobsStorage) {
      this.blobsAgent = new BlobsAgent(
        this.blobsStorage,
        this.subscriptionsAndPeersStorage.subscriptions,
      );
      this.agents.add(this.blobsAgent);
    }
  }

  protected abstract createFeedsStorage(): FeedsStorage | undefined;

  protected abstract createSubscriptionsAndPeersStorage(): SubscriptionsAndPeersStorage;

  protected abstract createBlobsStorage(): BlobsStorage | undefined;

  protected abstract getClientKeyPair(): KeyPair;

  connectionManager: ConnectionManager | undefined;

  async start(signal?: AbortSignal) {
    console.info(`Starting SSB Host`);
    if (this.transportClients.size + this.transportServers.size === 0) {
      console.warn(
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
          this.failingPeers.delete(address);
        } else {
          const failuresReport = this.failingPeers.get(address);
          if (failuresReport) {
            if (
              failuresReport.lastFailure +
                  this.config.failureRelevanceInterval! < Date.now()
            ) {
              if (failuresReport.failureCount > 4) {
                this.subscriptionsAndPeersStorage.peers.delete(address);
                this.excludedPeers.add(address);
                this.failingPeers.delete(address);
              } else {
                this.failingPeers.set(address, {
                  failureCount: failuresReport.failureCount + 1,
                  lastFailure: Date.now(),
                });
              }
            }
          } else {
            this.failingPeers.set(address, {
              failureCount: 1,
              lastFailure: Date.now(),
            });
          }
        }
      },
    );
    if (this.config.outgoingConnections) {
      agents.forEach(async (agent) => {
        try {
          await agent.run(this.connectionManager!, { signal });
        } catch (error) {
          console.warn(
            `Error starting agent ${agent.constructor.name}: ${error}\n${error.stack}`,
          );
        }
      });
    }

    (async () => {
      for await (
        const rpcConnection of this.connectionManager!.outgoingConnections()
      ) {
        Promise.all(
          agents.map(async (agent) => {
            try {
              await agent.outgoingConnection(rpcConnection, { signal });
            } catch (error) {
              console.warn(
                `Error with agent ${agent.constructor.name} handling incoming connection: ${error}`,
              );
            }
          }),
        );
      }
    })();

    for await (const rpcConnection of this.connectionManager.listen(signal)) {
      Promise.all(
        agents.map(async (agent) => {
          try {
            await agent.incomingConnection(rpcConnection, { signal });
          } catch (error) {
            console.warn(
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
    if (!this.feedsStorage) {
      throw new Error("No feeds storage");
    }
    const previousSeq = await this.feedsStorage.lastMessage(this.identity);
    const previous = previousSeq > 0
      ? (await this.feedsStorage.getMessage(
        this.identity,
        previousSeq,
      )).key
      : null;
    const sequence = previousSeq + 1;
    const msgValue: JSONValue = {
      previous,
      sequence,
      author: this.identity.toString(),
      timestamp: Date.now(),
      hash: "sha256",
      content,
    };
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
  subscriptions?: string[];
  peers?: string[];
  /** minimum interval between two connection failures to count */
  failureRelevanceInterval?: number;
  outgoingConnections?: boolean;
  storeRankingTable?: boolean;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const DURATION = { SECOND, MINUTE, HOUR, DAY, WEEK };
