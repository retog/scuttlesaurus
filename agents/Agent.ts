import RpcConnection from "../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../comm/rpc/types.ts";
import { Address, FeedId, log } from "../util.ts";

/** An object handling a sub-protocol, such as Feeds or Blobs */
export default abstract class Agent {
  static agents: Agent[] = [];

  constructor() {
    Agent.agents.push(this);
  }

  abstract createRpcContext(feedId: FeedId): RpcContext;

  /** Act on incoming connection */
  abstract incomingConnection(rpcConnection: RpcConnection): Promise<void>;

  /** Act on a connection initiated by another agent */
  abstract outgoingConnection(rpcConnection: RpcConnection): Promise<void>;

  start(connectorP: {
    connect(address: Address): Promise<RpcConnection>;
  }): Promise<void> {
    // deno-lint-ignore no-this-alias
    const thisAgent = this;
    const connector = {
      async connect(address: Address): Promise<RpcConnection> {
        const con = await connectorP.connect(address);
        Agent.agents.filter((agent) => agent !== thisAgent).forEach(
          async (agent) => {
            try {
              await agent.outgoingConnection(con);
            } catch (error) {
              log.error(
                `Error processing outgoing connection to ${address} by ${agent}: ${error}`,
              );
            }
          },
        );
        return con;
      },
    };
    return this.run(connector);
  }

  /** Performs the self-initiated actions of this Agent. Note that the Agent may handle requests and act on incoming connection even if this method has not been invoked  */
  abstract run(connector: {
    connect(address: Address): Promise<RpcConnection>;
  }): Promise<void>;
}
