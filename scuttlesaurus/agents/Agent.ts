import RpcConnection from "../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../comm/rpc/types.ts";
import { FeedId } from "../util.ts";
import ConnectionManager from "./ConnectionManager.ts";

/** An object handling a sub-protocol, such as Feeds or Blobs */
export default abstract class Agent {
  abstract createRpcContext(feedId: FeedId): RpcContext;

  /** Act on incoming connection */
  abstract incomingConnection(rpcConnection: RpcConnection): Promise<void>;

  /** Act on a connection initiated by another agent */
  abstract outgoingConnection(rpcConnection: RpcConnection): Promise<void>;

  /** Performs the self-initiated actions of this Agent. Note that the Agent may handle requests and act on incoming connection even if this method has not been invoked  */
  abstract run(
    connector: ConnectionManager,
    signal?: AbortSignal,
  ): Promise<void>;
}
