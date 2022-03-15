import ScuttlebuttHost, { FeedId } from "./ext/scuttlebutt-host.js";
import { iriToSigil, serverIdentity } from "./web-util.js";
export default class ClientHostProvider {
  async getScuttlebuttHost() {
    const hostId = await serverIdentity(); //ssb:feed/ed25519/luoZnBKHXeJl4kB39uIkZnQD4L0zl6Vd-Pe75gKS4fo=
    const hostSigil = iriToSigil(hostId); //@luoZnBKHXeJl4kB39uIkZnQD4L0zl6Vd+Pe75gKS4fo=.ed25519
    const hostKey = hostSigil.substring(
      1,
      hostSigil.length - ".ed25519".length,
    );
    const peerUri = (window.location.protocol === "http:" ? "ws" : "wss") +
      "://" + window.location.host + "~shs:" + hostKey;
    const host = new ScuttlebuttHost({
      peers: [
        peerUri,
      ],
    });
    const keyPair = host.getClientKeyPair();
    host.followees.add(new FeedId(keyPair.publicKey));
    await console.log(new FeedId(keyPair.publicKey).toString());
    host.start();
    return host;
  }
}
