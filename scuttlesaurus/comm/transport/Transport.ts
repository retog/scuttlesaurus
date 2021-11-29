import TransportClient from "./TransportClient.ts";
import TransportServer from "./TransportServer.ts";

export default interface Transport extends TransportClient, TransportServer {
  protocols: string[];
}
