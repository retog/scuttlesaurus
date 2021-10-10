import CommInterface from "../CommInterface.ts";

export default interface Transport
  extends CommInterface<Deno.Reader & Deno.Writer & Deno.Closer> {
  protocols: string[];
}
