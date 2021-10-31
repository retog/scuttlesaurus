import CommClientInterface from "../CommClientInterface.ts";

export default interface TransportClient
  extends CommClientInterface<Deno.Reader & Deno.Writer & Deno.Closer> {
  protocols: string[];
}
