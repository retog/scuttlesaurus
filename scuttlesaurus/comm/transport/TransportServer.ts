import CommServerInterface from "../CommServerInterface.ts";

export default interface TransportServer
  extends CommServerInterface<Deno.Reader & Deno.Writer & Deno.Closer> {
  protocols: string[];
}
