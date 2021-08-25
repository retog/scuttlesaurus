import Transport from "./Transport.ts";
import { Address, combine } from "./util.ts";
export default class NetTransport implements Transport {
  listeners: AsyncIterable<Deno.Reader & Deno.Writer & Deno.Closer>[] = [];
  [Symbol.asyncIterator](): AsyncIterator<Deno.Reader & Deno.Writer & Deno.Closer> {
    return combine(...this.listeners)[Symbol.asyncIterator]();
  }
  protocol = "net";
  async connect(
    addr: Address,
  ): Promise<Deno.Reader & Deno.Writer & Deno.Closer> {
    return await Deno.connect({
      hostname: addr.host,
      port: addr.port,
    });
  }
  listen(
    options: { port: number } & Record<string, unknown> = { port: 8008 },
  ) {
    this.listeners.push(Deno.listen(options));
    return new Promise<void>(() => {})
  }
}
