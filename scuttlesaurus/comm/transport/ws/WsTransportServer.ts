import TransportServer from "../TransportServer.ts";
import { log } from "../../../util.ts";
import makeConnectionLike from "./makeConnectionLike.ts";
import { Application, Context } from "https://deno.land/x/oak@v10.2.0/mod.ts";

export default class WsTransportServer implements TransportServer {
  constructor(
    private webapp: Application,
  ) {}
  protocols = ["ws", "wss"];

  async *listen(signal?: AbortSignal) {
    let listener:
      | ((con: Deno.Reader & Deno.Writer & Deno.Closer) => void)
      | undefined;
    this.webapp.use(async (ctx: Context, next: () => Promise<unknown>) => {
      if (ctx.isUpgradable) {
        if (listener) {
          listener(makeConnectionLike(ctx.upgrade()));
        } else {
          log.warning("Got ws connection before listening");
        }
        log.debug("ws response sent");
      } else {
        await next();
      }
    });
    while (!signal?.aborted) {
      yield await new Promise<Deno.Reader & Deno.Writer & Deno.Closer>((
        resolve,
        reject,
      ) => {
        listener = resolve;
        signal?.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("WsTransportServer was aborted.", "AbortError"),
            ),
          { once: true },
        );
      });
    }
  }
}
