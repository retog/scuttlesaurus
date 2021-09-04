export interface RequestHandler {
  handleSourceRequest: (
    name: string[],
    args: Record<string, string>[],
  ) => AsyncIterator<ResultValue>;

  handleAsyncRequest: (
    name: string[],
    args: Record<string, string>[],
  ) => Promise<ResultValue>;
}

export type ResultValue = Record<string, unknown> | string | Uint8Array;
export type RpcFunction = (
  args: Record<string, string>[],
) => (Promise<ResultValue> | AsyncGenerator<ResultValue>);
export type RpcContext = { [key: string]: (RpcFunction | RpcContext) };
