# Selection of peers to connect and feeds to ask

## Status: idea

Every peer-feed-tuple is associated with a single byte. A higher value of this
bytes increases tha chances that a peer is asked about a feed. The value is
computed as follow:

- When a new feed or peer is added all tuples containing it have value 1,
  except:
  - The tuple (if any) where feed and peer have the same id, has value OxFF
  - When a peer is added with referrer, the tuple peer-referrer has value 0xFF
  - When a feed is added with referrer, the values of any peer-feed tuple is
    half of the value of the respective peer-referrer tuple
- When a peer is asked about a feed,
  - if it can return new messages, the peer-feed tuple’s value is increased by 1
  - otherwise, if the peer-feed tuple’s value is 1, it is set to 0
  - otherwise, the value is halved with a probability of 0.1, but never reduced
    below 2
