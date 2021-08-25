import { Address } from "./util.ts";

export default interface Transport
  extends AsyncIterable<Deno.Reader & Deno.Writer & Deno.Closer> {
  protocol: string;
  connect(addr: Address): Promise<Deno.Reader & Deno.Writer & Deno.Closer>;
  listen(
    options?: Record<string, unknown>,
  ): Promise<void>;
}
