# Selection of peers to connect and feeds to ask

**Status: partially freely implemented**

## Ranking

Every peer-feed-tuple is associated with a q value between 1 and 256 (i.e, the q
value can bestored as a byte by deducting 1). A higher value of this bytes
increases tha chances that a peer is asked about a feed. The value is computed
as follow:

- When a new feed or peer is added all tuples containing it have value 4 except:
  - The tuple (if any) where feed and peer have the same id, has value Ox100
  - When a peer is added with referrer, the tuple peer-referrer has value 0x100
  - When a feed is added with referrer, the values of any peer-feed tuple is
    half of the value of the respective peer-referrer tuple
- When a peer is asked about a feed,
  - if it can return new messages, the peer-feed tuple’s value is increased by 1
  - otherwise, the value is halved with a probability of 0.1

## Update iteration

- Scuttlesaurus first decide on the feed that most urgently should be updated,
  we call this the primary update target
  - Currently this is just the feed that hasn't beed the primary update target
    for the longest time, other factors will be considered in future
- based on the primary update target a peer is picked as follows:
  - put all tuples containing the feed in a list
  - compute the sum of the q values
  - generate a random number between 1 and this sum
  - iterate over the peers in the list and sum q values till this sum is equals
    or greater the picked random number, select thi peer
- create rpc connecton to peer
- request feed of primary update target
- request more feeds with this connection

## Removal of pertmanently unreachable peers

Peers should be removed if no connection suceeded during 5 days in which a
connection was attempted.

For that ScuttlebuttHost keeps a persistent map that maps peers to a tuple
consisting of the number of qualified failures and the datetime of the last such
failure.

Whenever the ConnectionManager successfully established a connection, the
respective peer is removed from this map.

Whenever the ConnectionManager fails at connecting to a peer, this peer is added
to the map, if not already there. If the peer is already in the map, and the
date of the last qualified failure is more than one day past, reset the datetime
and increase the counter, otherwise do nothing.

Remove peers from list of peers when counter > 5
