import type { JSONValue } from "../../util.ts";

export interface RequestHandler {
  handleSourceRequest: (
    name: string[],
    args: Record<string, string>[],
  ) => AsyncIterable<ResultValue>;

  handleAsyncRequest: (
    name: string[],
    args: Record<string, string>[],
  ) => Promise<ResultValue>;
}

export type ResultValue = JSONValue | Uint8Array;
export type RpcFunction = (
  args: Record<string, string>[],
) => (Promise<ResultValue> | AsyncIterable<ResultValue>);
export type RpcContext = { [key: string]: (RpcFunction | RpcContext) };
