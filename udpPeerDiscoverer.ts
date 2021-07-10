const l = Deno.listenDatagram({
  port: 8008,
  hostname: "0.0.0.0",
  transport: "udp",
});
/*console.log(
  `Listening on ${(l.addr as Deno.NetAddr).hostname}:${
    (l.addr as Deno.NetAddr).port
  }.`,
);*/

const udpPeerDiscoverer = {
  async *[Symbol.asyncIterator]() {
    for await (const r of l) {
      const multiAddress = (new TextDecoder()).decode(r[0]);
      const addresses = multiAddress.split(";");
      yield {
        hostname: (r[1] as Deno.NetAddr).hostname,
        addresses,
      };
      /*console.log(
        `got UDP packet ${multiAddress} from ${
          (r[1] as Deno.NetAddr).hostname
        }:${(r[1] as Deno.NetAddr).port}.`,
      );*/
    }
  },
};

export default udpPeerDiscoverer;
