import { BoxConnection } from "./SsbHost.ts";
import { bytes2NumberSigned, bytes2NumberUnsigned } from "./util.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export enum RpcBodyType {
  binary = 0b00,
  utf8 = 0b01,
  json = 0b10,
}

export interface ResponseStream {
  read: () => Record<string, unknown>;
}

export type Header = {
  partOfStream: boolean;
  endOrError: boolean;
  bodyType: RpcBodyType;
  bodyLength: number;
  requestNumber: number;
};

export class EndOfStream extends Error {
  constructor() {
    super("Stream ended");
  }
}

export interface RequestHandler {
  handleSourceRequest: (
    name: string[],
    args: Record<string, string>[],
  ) => AsyncIterator<Record<string, unknown> | string | Uint8Array>;
}

function parseHeader(
  header: Uint8Array,
): Header {
  const flags = header[0];
  const partOfStream = !!(flags & 0b1000);
  const endOrError = !!(flags & 0b100);
  const bodyType: RpcBodyType = flags & 0b11;
  const bodyLength = bytes2NumberUnsigned(header.subarray(1, 5));
  const requestNumber = bytes2NumberSigned(header.subarray(5));
  return { partOfStream, endOrError, bodyType, bodyLength, requestNumber };
}

/** parses a message according to bodyType */
const parse = (message: Uint8Array, bodyType: RpcBodyType) =>
  (bodyType === RpcBodyType.json
    ? JSON.parse(textDecoder.decode(message))
    : bodyType === RpcBodyType.utf8
    ? textDecoder.decode(message)
    : message) as Record<string, unknown> | string | Uint8Array;

export default class RPCConnection {
  constructor(
    public boxConnection: BoxConnection,
    public requestHandler: RequestHandler,
  ) {
    this.requestCounter = 0;
    const monitorConnection = async () => {
      try {
        while (true) {
          const headerBytes = await boxConnection.read(); //readBytes(boxConnection,9);
          if (headerBytes.length !== 9) {
            throw new Error("expected 9 headerBytes bytes, got " + headerBytes);
          }
          const header = parseHeader(headerBytes);
          const body = await boxConnection.readTill(header.bodyLength); //readBytes(boxConnection,9);
          if (body.length !== header.bodyLength) {
            throw new Error(
              `expected a body of length ${header.bodyLength} but got ${body.length}`,
            );
          }
          if (header.requestNumber < 0) {
            const listener = this.responseStreamListeners.get(
              -header.requestNumber,
            );
            if (!listener) {
              throw new Error(
                `Got request with unexpected number ${header.requestNumber}`,
              );
            }
            listener(body, header);
          } else {
            //TODO handle incoming requests
            console.log(
              `got request number ${header.requestNumber}: ${
                textDecoder.decode(body)
              }`,
            );
            const request = JSON.parse(textDecoder.decode(body));
            if (this.requestHandler) {
              if (request.type === "source") {
                const responseIterator = this.requestHandler
                  .handleSourceRequest(request.name, request.args);
                (async () => {
                  for await (
                    const value of {
                      [Symbol.asyncIterator]: () => responseIterator,
                    }
                  ) {
                    console.log("sending back", value);
                    this.sendRpcMessage(value, {
                      isStream: true,
                      inReplyTo: header.requestNumber,
                    });
                  }
                })();
              }
            }
          }
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
  private responseStreamListeners: Map<
    number,
    ((message: Uint8Array, header: Header) => void)
  > = new Map();
  sendSourceRequest = async (request: {
    name: string[];
    args: unknown;
  }) => {
    const requestNumber = await this.sendRpcMessage({
      name: request.name,
      args: request.args,
      "type": "source",
    }, {
      bodyType: RpcBodyType.json,
      isStream: true,
    });
    const buffer: unknown[] = [];
    const bufferer = (message: Uint8Array, header: Header) => {
      if (!header.endOrError) {
        buffer.push(parse(message, header.bodyType));
      }
    };
    this.responseStreamListeners.set(requestNumber, bufferer);
    return { //TODO return AsyncIterator instead
      read: () => {
        if (buffer.length > 0) {
          return Promise.resolve(buffer.shift());
        } else {
          return new Promise<Record<string, unknown> | string | Uint8Array>(
            (resolve, reject) => {
              this.responseStreamListeners.set(
                requestNumber,
                (message: Uint8Array, header: Header) => {
                  if (!header.endOrError) {
                    this.responseStreamListeners.set(requestNumber, bufferer);
                    resolve(parse(message, header.bodyType));
                  } else {
                    const endMessage = textDecoder.decode(message);
                    if (endMessage === "true") {
                      reject(new EndOfStream());
                    } else {
                      reject(new Error(endMessage));
                    }
                  }
                },
              );
            },
          );
        }
      },
    };
  };
  sendAsyncRequest = async (request: {
    name: string[];
    args: unknown;
  }) => {
    const requestNumber = await this.sendRpcMessage({
      name: request.name,
      args: request.args,
      "type": "async",
    }, {
      bodyType: RpcBodyType.json,
      isStream: false,
    });
    return new Promise((resolve, reject) => {
      this.responseStreamListeners.set(
        requestNumber,
        (message: Uint8Array, header: Header) => {
          this.responseStreamListeners.delete(requestNumber);
          if (!header.endOrError) {
            resolve(parse(message, header.bodyType));
          } else {
            reject(new Error(textDecoder.decode(message)));
          }
        },
      );
    });
  };
  requestCounter;
  private sendRpcMessage = async (
    body: Record<string, unknown> | string | Uint8Array,
    options: {
      isStream?: boolean;
      endOrError?: boolean;
      bodyType?: RpcBodyType;
      inReplyTo?: number;
    } = {},
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
    const getPayload = () => {
      if (isUint8Array(body)) {
        if (!options.bodyType) options.bodyType = RpcBodyType.binary;
        return body;
      }
      if (isString(body)) {
        if (!options.bodyType) options.bodyType = RpcBodyType.utf8;
        return textEncoder.encode(body);
      }
      if (!options.bodyType) options.bodyType = RpcBodyType.json;
      return textEncoder.encode(JSON.stringify(body));
    };
    const payload: Uint8Array = getPayload();
    const flags = (options.isStream ? 0b1000 : 0) | (options.endOrError
      ? 0b100
      : 0) |
      options.bodyType!;
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
    //const message = concat(headerBytes, payload);
    //await this.write(message);
    await this.boxConnection.write(header);
    await this.boxConnection.write(payload);
    return requestNumber;
  };
}
