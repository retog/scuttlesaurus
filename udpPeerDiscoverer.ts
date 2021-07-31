//import { delay } from "https://deno.land/std@0.103.0/async/mod.ts";
import { log } from "./util.ts";

const l = Deno.listenDatagram({
  port: 8008,
  hostname: "0.0.0.0",
  transport: "udp",
});

export function advertise(_multiAddress: string) {
  //as UDP broadcast doesn't seem to be supported
  //Another issue is finding out own ip
  //TODO implement
  return new Promise((_res, _rej) => {});
}

log.info(
  `Listening on ${(l.addr as Deno.NetAddr).hostname}:${
    (l.addr as Deno.NetAddr).port
  }.`,
);

const udpPeerDiscoverer = {
  async *[Symbol.asyncIterator]() {
    for await (const r of l) {
      const multiAddress = (new TextDecoder()).decode(r[0]);
      const addresses = multiAddress.split(";");
      yield {
        hostname: (r[1] as Deno.NetAddr).hostname,
        addresses,
      };
      /*log.info(
        `got UDP packet ${multiAddress} from ${
          (r[1] as Deno.NetAddr).hostname
        }:${(r[1] as Deno.NetAddr).port}.`,
      );*/
    }
  },
};

export default udpPeerDiscoverer;
