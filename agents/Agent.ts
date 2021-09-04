import RpcConnection from "../comm/rpc/RpcConnection.ts";
import { RpcContext } from "../comm/rpc/types.ts";
import { Address, FeedId } from "../util.ts";

/** An object handling a sub-protocol, such as Feeds or Blobs */
export default abstract class Agent {
  constructor(
    public connector: {
      connect(address: Address): Promise<RpcConnection>;
    },
  ) {}
  abstract createRpcContext(feedId: FeedId): RpcContext;

  /** Act on incoming connection */
  abstract incomingConnection(rpcConnection: RpcConnection): Promise<void>;

  /** Performs the self-initiated actions of this Agent. Note that the Agent may handle requests and act on incoming connection even if this method has not been invoked  */
  abstract run(): Promise<void>;
}
