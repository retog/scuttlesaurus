import BoxConnection from "./BoxConnection.ts";
import {
  bytes2NumberSigned,
  bytes2NumberUnsigned,
  concat,
  delay,
  isZero,
  log,
  readBytes,
} from "./util.ts";

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

let lastAnswer = Date.now();
let lastActivity = Date.now();

export default class RPCConnection {
  constructor(
    public boxConnection: BoxConnection,
    public requestHandler: RequestHandler,
    {
      answerTimeout = 30,
      activityTimeout = 10,
    }: {
      answerTimeout?: number;
      activityTimeout?: number;
    } = {},
  ) {
    this.requestCounter = 0;
    const monitorConnection = async () => {
      try {
        while (!this.boxConnection.closed) {
          const headerBytes = await readBytes(boxConnection, 9);
          lastActivity = Date.now();
          if (isZero(headerBytes)) {
            log.debug("They said godbye.");
            break;
          }
          const header = parseHeader(headerBytes);
          if (header.bodyLength === 0) {
            throw new Error("Got RPC message with lentgh 0.");
          }
          const body = await readBytes(boxConnection, header.bodyLength);
          lastActivity = Date.now();
          if (header.requestNumber < 0) {
            const listener = this.responseStreamListeners.get(
              -header.requestNumber,
            );
            if (!listener) {
              throw new Error(
                `Got request with unexpected number ${header.requestNumber}`,
              );
            }
            lastAnswer = Date.now();
            listener(body, header);
          } else {
            const parse = () => {
              const decoded = textDecoder.decode(body);
              try {
                return JSON.parse(decoded);
              } catch (error) {
                log.error(
                  `Parsing ${decoded} in request ${JSON.stringify(header)}`,
                );
                throw error;
              }
            };
            const request = parse();
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
                    log.debug(() => "sending back " + JSON.stringify(value));
                    try {
                      await this.sendRpcMessage(value, {
                        isStream: true,
                        inReplyTo: header.requestNumber,
                      });
                    } catch (error) {
                      log.error(
                        `Error sending back ${JSON.stringify(value)}: ${error}`,
                      );
                    }
                  }
                })();
              } else {
                log.info(
                  `Request type ${request.type} not yet supported. Ignoring request number ${header.requestNumber}: ${
                    textDecoder.decode(body)
                  }`,
                );
              }
            } else {
              log.info(
                `No handler to handle request number ${header.requestNumber}: ${
                  textDecoder.decode(body)
                }`,
              );
            }
          }
        }
      } catch (e) {
        if (boxConnection.closed) {
          log.info("Connection closed");
        } else {
          if ((e.name === "Interrupted") || (e.name === "ConnectionReset")) {
            // ignore
            log.info(`RPCConnection ${e.name}`);
          } else {
            throw e;
          }
        }
      }
    };
    monitorConnection();
    const checkTimeout = async () => {
      while (!this.boxConnection.closed) {
        await delay(5000);
        const timeSinceRead = Date.now() - lastAnswer;
        if (timeSinceRead > answerTimeout * 1000) {
          log.info(
            `RPCConnection readTimeout: ${timeSinceRead /
              1000} seconds since last response was received.`,
          );
          this.boxConnection.close();
          break;
        }
        const timeSinceActivity = Date.now() - lastActivity;
        if (timeSinceActivity > activityTimeout * 1000) {
          log.info(
            `RPCConnection activityTimeout: ${timeSinceActivity /
              1000} seconds since last data was read.`,
          );
          this.boxConnection.close();
          break;
        }
      }
    };
    checkTimeout();
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
    const buffer: [Uint8Array, Header][] = [];
    const bufferer = (message: Uint8Array, header: Header) => {
      buffer.push([message, header]);
    };
    this.responseStreamListeners.set(requestNumber, bufferer);
    return { //TODO return AsyncIterator instead
      read: () => {
        if (buffer.length > 0) {
          const [message, header] = buffer.shift() as [Uint8Array, Header];
          if (!header.endOrError) {
            return Promise.resolve(parse(message, header.bodyType));
          } else {
            const endMessage = textDecoder.decode(message);
            if (endMessage === "true") {
              return Promise.reject(new EndOfStream());
            } else {
              return Promise.reject(new Error(endMessage));
            }
          }
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
                      reject(
                        new Error(
                          `On connectiion with ${this.boxConnection}: ${endMessage}`,
                        ),
                      );
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
    //writing in one go, to ensure correct order
    const message = concat(header, payload);
    try {
      await this.boxConnection.write(message);
    } catch (error) {
      throw new Error(`Failed writing to boxConnection: ${error}.`);
    }
    return requestNumber;
  };
}
