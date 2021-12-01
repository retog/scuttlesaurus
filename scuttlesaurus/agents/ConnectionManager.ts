import { Address } from "../util.ts";
import CommClientInterface from "../comm/CommClientInterface.ts";
import CommServerInterface from "../comm/CommServerInterface.ts";
import RpcConnection from "../comm/rpc/RpcConnection.ts";

export default class ConnectionManager
  implements CommServerInterface<RpcConnection> {
  /** key is base64 of FeedId */
  private connections = new Map<string, WeakRef<RpcConnection>>();

  constructor(
    private rpcClientInterface: CommClientInterface<RpcConnection>,
    private rpcServerInterface: CommServerInterface<RpcConnection>,
  ) {
  }

  private notifyOutgoingConnection = (_conn: RpcConnection) => {
    //nobody listening, and we ignore
  };
  protected newConnection(conn: RpcConnection) {
    this.connections.set(
      conn.boxConnection.peer.base64Key,
      new WeakRef(conn),
    );
  }

  async *listen(): AsyncIterable<RpcConnection> {
    for await (const conn of this.rpcServerInterface.listen()) {
      this.newConnection(conn);
      yield conn;
    }
  }

  async *outgoingConnections() {
    while (true) {
      yield await new Promise((resolve: (_: RpcConnection) => void) => {
        this.notifyOutgoingConnection = resolve;
      });
    }
  }

  async connect(addr: Address): Promise<RpcConnection> {
    const conn = await this.rpcClientInterface.connect(addr);
    this.newConnection(conn);
    this.notifyOutgoingConnection(conn);
    return conn;
  }

  /**
   * returns a new or existing connection to the peer in the given address
   */
  async getConnectionWith(addr: Address): Promise<RpcConnection> {
    const conn = this.connections.get(addr.key.base64Key)?.deref();
    if (conn && !conn.boxConnection.closed) {
      return conn;
    } else {
      return await this.connect(addr);
    }
  }

  async reset() {
    for (const connRef of this.connections.values()) {
      const conn = connRef.deref();
      if (conn) {
        await conn.boxConnection.close()
      }
    }
  }
}
