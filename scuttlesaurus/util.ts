import importedSodium, {
  base64_variants as base64Variants,
  KeyPair as importKeypair,
} from "https://deno.land/x/sodium@0.2.0/sumo.ts";
export * as path from "https://deno.land/std@0.103.0/path/mod.ts";
export * as log from "https://deno.land/std@0.103.0/log/mod.ts";
export { delay } from "https://deno.land/std@0.129.0/async/mod.ts";
export { exists } from "https://deno.land/std@0.103.0/fs/exists.ts";
export { writeAll } from "https://deno.land/std@0.116.0/streams/conversion.ts";
export const sodium = importedSodium;
export type KeyPair = importKeypair;
//like Deno.error.NofFound, but available in browser
export class NotFoundError extends Error {}

await sodium.ready;

export class FeedId extends Uint8Array {
  constructor(publicKey: Uint8Array) {
    super(publicKey);
  }

  get base64Key() {
    return toBase64(this);
  }

  get base64FilenameSafe() {
    return toFilenameSafeAlphabet(this.base64Key);
  }

  toUri(): string {
    //URIs according to https://github.com/ssb-ngi-pointer/ssb-uri-spec
    return "ssb:feed/ed25519/" + this.base64FilenameSafe;
  }

  toString(): string {
    return `@${this.base64Key}.ed25519`;
  }

  toJSON = this.toString;
}

export class BlobId extends Uint8Array {
  constructor(key: Uint8Array) {
    super(key);
  }

  get base64Key() {
    return toBase64(this);
  }

  get base64FilenameSafe() {
    return toFilenameSafeAlphabet(this.base64Key);
  }

  toUri(): string {
    //URIs according to https://github.com/ssb-ngi-pointer/ssb-uri-spec
    return "ssb:blob/sha256/" + this.base64FilenameSafe;
  }

  toString(): string {
    return `&${this.base64Key}.sha256`;
  }

  toJSON = this.toString;
}

export class MsgKey extends Uint8Array {
  constructor(key: Uint8Array) {
    super(key);
  }

  get base64Key() {
    return toBase64(this);
  }

  get base64FilenameSafe() {
    return toFilenameSafeAlphabet(this.base64Key);
  }

  toUri(): string {
    //URIs according to https://github.com/ssb-ngi-pointer/ssb-uri-spec
    return "ssb:message/sha256/" + this.base64FilenameSafe;
  }

  toString(): string {
    return `%${this.base64Key}.sha256`;
  }

  toJSON = this.toString;
}

export interface Address {
  protocol: string;
  host: string;
  port: number;
  key: FeedId;
  toString: () => string;
  toJSON: () => string;
}

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | { [x: string]: JSONValue }
  | Array<JSONValue>;

/** reads classic .ssb/secret with comments */
export function parseKeyPair(secretText: string) {
  const secretTextNoComments = secretText.split("\n").filter((line) =>
    line.charAt(0) !== "#"
  ).join("\n");
  const secret = JSON.parse(secretTextNoComments);
  return {
    keyType: secret.curve,
    publicKey: fromBase64(
      secret.public.substring(0, secret.public.length - ".ed25519".length),
    ),
    privateKey: fromBase64(
      secret.private.substring(0, secret.private.length - ".ed25519".length),
    ),
  };
}

export function serializeKeyPair(keyPair: KeyPair) {
  const secret = {
    public: toBase64(keyPair.publicKey) + ".ed25519",
    "private": toBase64(keyPair.privateKey) + ".ed25519",
    curve: keyPair.keyType,
  };
  return JSON.stringify(secret, undefined, 2);
}

export function parseAddress(addr: string): Address {
  try {
    const [netAddr, keyString] = addr.split("~shs:");
    const [protocol, host, portString] = netAddr.split(":");
    const port = parseInt(portString);
    return {
      protocol,
      host,
      port,
      key: new FeedId(fromBase64(keyString)),
      toString: () => {
        return addr;
      },
      toJSON: () => {
        return addr;
      },
    };
  } catch (error) {
    throw new Error(`Error parsing ${addr}: ${error}`);
  }
}

export function parseFeedId(feedIdString: string) {
  const base64Key =
    feedIdString.startsWith("@") && feedIdString.endsWith(".ed25519")
      ? feedIdString.substring(1, feedIdString.length - 8)
      : feedIdString;
  return new FeedId(fromBase64(base64Key));
}

export function parseBlobId(blobIdString: string) {
  const base64Key =
    blobIdString.startsWith("&") && blobIdString.endsWith(".sha256")
      ? blobIdString.substring(1, blobIdString.length - 7)
      : blobIdString;
  return new BlobId(fromBase64(base64Key));
}

export function parseMsgKey(msgKeyString: string) {
  const base64Key =
    msgKeyString.startsWith("%") && msgKeyString.endsWith(".sha256")
      ? msgKeyString.substring(1, msgKeyString.length - 7)
      : msgKeyString;
  return new MsgKey(fromBase64(base64Key));
}

export function bytes2NumberUnsigned(bytes: Uint8Array): number {
  return bytes.length === 0 ? 0 : bytes[0] * Math.pow(0x100, bytes.length - 1) +
    bytes2NumberUnsigned(bytes.subarray(1));
}

export function bytes2NumberSigned(bytes: Uint8Array): number {
  return bytes[0] & 0b10000000
    ? -Math.pow(2, 7 + (bytes.length - 1) * 8) + (0b01111111 &
          bytes[0]) * Math.pow(0x100, bytes.length - 1) +
      bytes2NumberUnsigned(bytes.subarray(1))
    : bytes2NumberUnsigned(bytes);
}

export function concat(...elems: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    elems.reduce((sum, elem) => sum + (elem.length), 0),
  );
  let pos = 0;
  for (const elem of elems) {
    result.set(elem, pos);
    pos += elem.length;
  }
  return result;
}

export async function readBytes(reader: Deno.Reader, length: number) {
  const result = new Uint8Array(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const remainder = result.subarray(bytesRead);
    try {
      const bytesReadNow = await reader.read(remainder);
      if (bytesReadNow === null) {
        throw new Error(
          `End of reader, expecting ${remainder.length} more bytes`,
        );
      }
      bytesRead += bytesReadNow;
    } catch (e) {
      throw e;
    }
  }
  return result;
}
/** convert base64 from standard to filename-safe alphabet as per RFC3548*/
export const toFilenameSafeAlphabet = (orig: string) =>
  orig.replaceAll("/", "_").replaceAll("+", "-");

export const fromFilenameSafeAlphabet = (orig: string) =>
  orig.replaceAll("_", "/").replaceAll("-", "+");

export function toBase64(data: Uint8Array) {
  return sodium.to_base64(
    data,
    base64Variants.ORIGINAL_NO_PADDING,
  );
}

export function fromBase64(text: string) {
  return sodium.from_base64(
    text,
    base64Variants.ORIGINAL_NO_PADDING,
  );
}

export function toHex(data: Uint8Array) {
  return sodium.to_hex(data);
}

function nodeBinaryEncode(text: string): Uint8Array {
  function encodeValue(value: number) {
    if (value <= 0xFFFF) {
      return new Uint8Array([value & 0xFF]);
    } else {
      const firstByte = (Math.floor(value / 0x400) - 0b1000000) & 0xFF;
      const secondByte = value & 0xFF;
      return new Uint8Array([firstByte, secondByte]);
    }
  }

  function encodeChars(chars: number[]): Uint8Array {
    if (chars.length === 0) {
      return new Uint8Array(0);
    } else {
      return concat(...chars.map((char) => encodeValue(char)));
    }
  }
  const codePoints: number[] = [...text].map((cp) => cp.codePointAt(0)!);
  return encodeChars(codePoints);
}

export function computeMsgHash(msg: unknown) {
  return sodium.crypto_hash_sha256(
    nodeBinaryEncode(JSON.stringify(msg, undefined, 2)),
  );
}

export function sha256Hash(data: Uint8Array) {
  return sodium.crypto_hash_sha256(data);
}

export function isZero(bytes: Uint8Array) {
  return !bytes.find((b) => b > 0);
}

const never = function <T>() {
  return new Promise<T>(
    () => {},
  );
};

function getNext<T>(asyncIterator: AsyncIterator<T>, index: number) {
  return asyncIterator.next().then((result) => ({
    index,
    result,
  }));
}

//from https://stackoverflow.com/a/50586391/1455912
export async function* combine<T>(...iterable: AsyncIterable<T>[]) {
  const asyncIterators: AsyncIterator<T>[] = iterable.map((o) =>
    o[Symbol.asyncIterator]()
  );
  const results: T[] = [];
  let count = asyncIterators.length;

  const nextPromises = asyncIterators.map(getNext);
  try {
    while (count) {
      const { index, result } = await Promise.race(nextPromises);
      if (result.done) {
        nextPromises[index] = never<
          { index: number; result: IteratorResult<T> }
        >();
        results[index] = result.value;
        count--;
      } else {
        nextPromises[index] = getNext(asyncIterators[index], index);
        yield result.value;
      }
    }
  } finally {
    for (const [index, iterator] of asyncIterators.entries()) {
      if (nextPromises[index] != never() && iterator.return != null) {
        iterator.return();
      }
    }
    // no await here - see https://github.com/tc39/proposal-async-iteration/issues/126
  }
  return results;
}

export function flatten<T>(
  outer: AsyncIterator<AsyncIterator<T>>,
): AsyncIterator<T> {
  const innerIterators: AsyncIterator<T>[] = [];
  const innerIteratorsNexts: Promise<
    { index: number; result: IteratorResult<T> }
  >[] = innerIterators.map(getNext);
  let outerNext: Promise<IteratorResult<AsyncIterator<T>>> = outer.next();
  let finishedIterators = 0;
  return {
    next: () => {
      const iteration: () => Promise<IteratorResult<T>> = async () => {
        if (finishedIterators < (innerIterators.length + 1)) {
          const nextEvent = await Promise.race([
            outerNext,
            ...innerIteratorsNexts,
          ]);
          if ("index" in nextEvent) {
            //an actual result
            if (nextEvent.result.done) {
              innerIteratorsNexts[nextEvent.index] = never();
              finishedIterators++;
              return iteration();
            } else {
              innerIteratorsNexts[nextEvent.index] = getNext(
                innerIterators[nextEvent.index],
                nextEvent.index,
              );
              return nextEvent.result;
            }
          } else {
            //a new inner iterator
            if (nextEvent.done) {
              finishedIterators++;
              outerNext = never<IteratorResult<AsyncIterator<T>>>();
            } else {
              innerIterators.push(nextEvent.value);
              innerIteratorsNexts.push(getNext(
                nextEvent.value,
                innerIteratorsNexts.length,
              ));
              outerNext = outer.next();
            }
            return iteration();
          }
        } else {
          return { done: true, value: undefined };
        }
      };
      return iteration();
    },
  };
}

export class TSEMap<T extends { toString: () => string }, V>
  implements Map<T, V> {
  private map = new Map<string, [T, V]>();
  clear(): void {
    this.map.clear();
  }
  delete(key: T): boolean {
    return this.map.delete(key.toString());
  }
  forEach(
    callbackfn: (value: V, key: T, map: Map<T, V>) => void,
    // deno-lint-ignore no-explicit-any
    thisArg?: any,
  ): void {
    this.map.forEach(
      (value: [T, V]) => callbackfn.apply(thisArg, [value[1], value[0], this]),
    );
  }
  get(key: T): V | undefined {
    return this.map.get(key.toString())?.[1];
  }
  has(key: T): boolean {
    return this.map.has(key.toString());
  }
  set(key: T, value: V): this {
    this.map.set(key.toString(), [key, value]);
    return this;
  }
  get size() {
    return this.map.size;
  }
  entries(): IterableIterator<[T, V]> {
    return this.map.values();
  }
  *keys(): IterableIterator<T> {
    for (const entry of this.map.values()) {
      yield entry[0];
    }
  }
  *values(): IterableIterator<V> {
    for (const entry of this.map.values()) {
      yield entry[1];
    }
  }
  [Symbol.iterator](): IterableIterator<[T, V]> {
    return this.entries();
  }
  [Symbol.toStringTag]: string;
}
/** toString-Equality Set */
export class TSESet<T extends { toString: () => string }> implements Set<T> {
  map = new Map<string, T>();
  add(value: T): this {
    this.map.set(value.toString(), value);
    return this;
  }
  clear(): void {
    this.map.clear();
  }
  delete(value: T): boolean {
    return this.map.delete(value.toString());
  }
  forEach(
    callbackfn: (value: T, value2: T, set: Set<T>) => void,
    // deno-lint-ignore no-explicit-any
    thisArg?: any,
  ): void {
    this.map.forEach((value) => {
      callbackfn.apply(thisArg, [value, value, this]);
    });
  }
  has(value: T): boolean {
    return this.map.has(value.toString());
  }
  get size() {
    return this.map.size;
  }
  *entries(): IterableIterator<[T, T]> {
    for (const value of this.values()) {
      yield [value, value];
    }
  }
  keys(): IterableIterator<T> {
    return this.map.values();
  }
  values(): IterableIterator<T> {
    return this.map.values();
  }
  [Symbol.iterator](): IterableIterator<T> {
    return this.map.values();
  }
  [Symbol.toStringTag]: string = "TSESet";
}

export class ObservableSet<T> extends TSESet<T> {
  private addListeners: Set<((value: T) => void)> = new Set();
  addAddListener(l: (value: T) => void) {
    this.addListeners.add(l);
  }
  removeAddListener(l: (value: T) => void) {
    this.addListeners.delete(l);
  }

  private removeListeners: Set<((value: T) => void)> = new Set();
  addRemoveListener(l: (value: T) => void) {
    this.removeListeners.add(l);
  }
  removeRemoveListener(l: (value: T) => void) {
    this.removeListeners.delete(l);
  }

  add(value: T) {
    if (!super.has(value)) {
      super.add(value);
      this.addListeners.forEach((l) => l(value));
    }
    return this;
  }
  delete(value: T) {
    if (super.delete(value)) {
      this.removeListeners.forEach((l) => l(value));
      return true;
    } else {
      return false;
    }
  }
  clear() {
    super.forEach((entry) => this.delete(entry));
  }
}

export class ObservableMap<T, V> extends TSEMap<T, V> {
  private addListeners: Set<((key: T) => void)> = new Set();
  addAddListener(l: (key: T) => void) {
    this.addListeners.add(l);
  }
  removeAddListener(l: (key: T) => void) {
    this.addListeners.delete(l);
  }

  private removeListeners: Set<((key: T) => void)> = new Set();
  addRemoveListener(l: (key: T) => void) {
    this.removeListeners.add(l);
  }
  removeRemoveListener(l: (key: T) => void) {
    this.removeListeners.delete(l);
  }

  set(key: T, value: V) {
    super.set(key, value);
    this.addListeners.forEach((l) => l(key));
    return this;
  }
  delete(key: T) {
    if (super.delete(key)) {
      this.removeListeners.forEach((l) => l(key));
      return true;
    } else {
      return false;
    }
  }
  clear() {
    for (const key of super.keys()) {
      this.delete(key);
    }
  }
}
