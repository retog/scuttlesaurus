import { RequestHandler } from "./RPCConnection.ts";
import * as FSStorage from "./fsStorage.ts";
import { path } from "./util.ts";

type sourceProcedure = (
  args: Record<string, string>[],
) => AsyncIterator<Record<string, unknown> | string | Uint8Array>;
type rpcContext = Record<string, sourceProcedure>;

/** An RPC request handler providing default procedured based on FSStorage */
export default class Procedures implements RequestHandler {
  rootContext: rpcContext = {
    createHistoryStream: async function* (args: Record<string, string>[]) {
      const opts = args[0];
      const feedKey = opts.id.substring(1, opts.id.length - ".ed25519".length);
      let seq = Number.parseInt(opts.seq);
      //console.log(`got request for ${feedKey} with seq: ${seq}`);
      while (true) {
        const fileName = path.join(
          FSStorage.getFeedDir(feedKey),
          (seq++) + ".json",
        );
        try {
          const parsedFile = JSON.parse(
            await Deno.readTextFile(fileName),
          );
          if (opts.keys === undefined || opts.keys) {
            yield parsedFile as string | Record<string, unknown> | Uint8Array;
          } else {
            yield parsedFile.value as
              | string
              | Record<string, unknown>
              | Uint8Array;
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            //console.log(`File ${fileName} not found, ending stream`);
            break;
          }
        }
      }
    },
  };

  namedContext: Record<string, rpcContext> = {
    blobs: {
      createWants: async function* (_args: Record<string, string>[]) {
        yield {};
      },
    },
  };

  handleSourceRequest(
    names: string[],
    args: Record<string, string>[],
  ) {
    const context = names.length > 1
      ? this.namedContext[names.shift()!]
      : this.rootContext;
    if (context && context[names[0]]) {
      return context[names[0]](args);
    } else {
      return (async function* () {})() as AsyncIterator<
        string | Record<string, unknown> | Uint8Array,
        unknown,
        undefined
      >;
    }
  }
}
