import udpPeerDiscoverer from "./udpPeerDiscoverer.ts";

const peerAddresses: Map<string, string[]> = new Map();

for await (const peer of udpPeerDiscoverer) {
    if(JSON.stringify(peerAddresses.get(peer.hostname)) !== JSON.stringify(peer.addresses)) {
        peerAddresses.set(peer.hostname, peer.addresses);
        console.log(peer.addresses);
    }
}