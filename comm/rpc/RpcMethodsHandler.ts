import {
  RequestHandler,
  ResultValue,
  RpcContext,
  RpcFunction,
} from "./types.ts";
import { log } from "../../util.ts";

/** An RPC request handler providing default procedured based on FSStorage */
export default class RpcMethodsHandler implements RequestHandler {
  constructor(public rcpContexts: RpcContext[]) {
    log.debug(`creating request handler for ${rcpContexts}`);
  }

  protected getFunction(
    names: string[],
  ) {
    return this.rcpContexts.map((context) =>
      getFunctionInContext(names, context)
    ).find(
      (f) => typeof f !== "undefined",
    );
  }

  handleSourceRequest(
    names: string[],
    args: Record<string, string>[],
  ) {
    const method = this.getFunction(names);
    if (method) {
      return method(args) as AsyncIterable<ResultValue>;
    } else {
      return (async function* () {})() as AsyncIterable<
        string | Record<string, unknown> | Uint8Array
      >;
    }
  }

  handleAsyncRequest(
    names: string[],
    args: Record<string, string>[],
  ) {
    const method = this.getFunction(names);
    if (method) {
      return method(args) as Promise<ResultValue>;
    } else {
      return new Promise(() => {/*never*/}) as Promise<ResultValue>;
    }
  }
}

function getFunctionInContext(
  names: string[],
  methods: RpcContext,
): RpcFunction {
  if (names.length > 1) {
    return getFunctionInContext(
      names.slice(1),
      methods[names[0]] as RpcContext,
    );
  } else {
    return methods?.[names[0]] as RpcFunction;
  }
}
