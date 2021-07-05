import { BoxConnection } from "./SsbHost.ts";
import { bytes2NumberSigned, bytes2NumberUnsigned } from "./util.ts";

const decoder = new TextDecoder();

export enum RpcBodyType {
  binary = 0b00,
  utf8 = 0b01,
  json = 0b10,
}

export interface ResponseStream {
  read: () => Record<string, unknown>;
}

export default class RPCConnection {
  constructor(public boxConnection: BoxConnection) {
    this.requestCounter = 0;
    const monitorConnection = async () => {
      try {
        while (true) {
          const header = await boxConnection.read(); //readBytes(boxConnection,9);
          if (header.length !== 9) {
            throw new Error("expected 9 header bytes, got " + header);
          }
          const flags = header[0];
          const partOfStream: boolean = !!(flags & 0b1000);
          const endOrError: boolean = !!(flags & 0b100);
          const bodyType: RpcBodyType = flags & 0b11;
          const bodyLength = bytes2NumberUnsigned(header.subarray(1, 5));
          const requestNumber = bytes2NumberSigned(header.subarray(5));
          const body = await boxConnection.read(); //readBytes(boxConnection,9);
          if (body.length !== bodyLength) {
            throw new Error(
              `expected a body of ${bodyLength} bytes, got ${body}`,
            );
          }
          console.log(`got request number ${requestNumber}: ${body}`);
        }
      } catch (e) {
        if (e.name === "Interrupted") {
          // ignore
        } else {
          throw e;
        }
      }
    };
    monitorConnection();
  }
  sendSourceRequest = async (request: {
    name: string[];
    args: Record<string, unknown>[];
  }) => {
    await this.sendRpcMessage({
      name: request.name,
      args: request.args,
      "type": "source",
    }, {
      bodyType: RpcBodyType.json,
      isStream: true,
    });
    //listening to requestNumber * -1 incoming messages
    //shold we this.boxConnection.read before sending request?
    //Yes, to be sure a delayed ending of the write operation doesn't cause incoming packages to get lost. No, all incoming packages are read by rpcconnection
  };
  requestCounter;
  sendRpcMessage = async (
    body: Record<string, unknown> | string | Uint8Array,
    options: {
      isStream?: boolean;
      endOrError?: boolean;
      bodyType: RpcBodyType;
      inReplyTo?: number;
    },
  ) => {
    function isUint8Array(
      v: Record<string, unknown> | string | Uint8Array,
    ): v is Uint8Array {
      return v.constructor.prototype === Uint8Array.prototype;
    }
    function isString(
      v: Record<string, unknown> | string | Uint8Array,
    ): v is string {
      return v.constructor.prototype === String.prototype;
    }
    const payload: Uint8Array = isUint8Array(body)
      ? body
      : isString(body)
      ? new TextEncoder().encode(body)
      : new TextEncoder().encode(JSON.stringify(body));
    const flags = (options.isStream ? 0b1000 : 0) | (options.endOrError
      ? 0b100
      : 0) |
      options.bodyType;
    const requestNumber = options.inReplyTo
      ? options.inReplyTo * -1
      : ++this.requestCounter;
    const header = new Uint8Array(9);
    header[0] = flags;
    header.set(
      new Uint8Array(new Uint32Array([payload.length]).buffer).reverse(),
      1,
    );
    header.set(
      new Uint8Array(new Uint32Array([requestNumber]).buffer).reverse(),
      5,
    );
    //or write twice?
    //const message = concat(header, payload);
    //await this.write(message);
    await this.boxConnection.write(header);
    await this.boxConnection.write(payload);
  };
}
