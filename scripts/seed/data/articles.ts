/**
 * The long-form articles of the seed world (kind 30023), written in Markdown,
 * and the draft (kind 30024). The body of an article may carry the marker
 * `{{INLINE}}` on a line of its own: it becomes an illustration when the
 * article has `inline`, and is removed otherwise.
 *
 * Code blocks use `~~~` fences so that the text needs no escaping.
 * @module
 */

/** An article as written in this file. */
export interface ArticleData {
  /** The `d` tag. */
  readonly slug: string;
  /** Handle of the author. */
  readonly author: string;
  readonly title: string;
  readonly summary: string;
  /** Key of the topic whose sentences the comments are written from. */
  readonly topic: string;
  /** Days before `now` on which the first version was published. */
  readonly days: number;
  readonly tags: readonly string[];
  /** Whether the article has a cover image. */
  readonly cover: boolean;
  /** An illustration inside the body, and its caption. */
  readonly inline?: string;
  readonly body: string;
  /** A newer version: days before `now`, and the edits to the body. */
  readonly revision?: {
    readonly days: number;
    readonly edits: readonly (readonly [string, string])[];
  };
}

/** The articles of the cast. */
export const ARTICLES: readonly ArticleData[] = [
  {
    slug: "small-network",
    author: "ada",
    title: "Why a small network is a good network",
    summary:
      "Most social software maximises reach. Scuttlebutt maximised care: your feed is the people you follow, their follows, and then it stops.",
    topic: "databases",
    days: 4,
    tags: ["nostr", "networks", "scuttlebutt"],
    cover: true,
    inline: "A ridge at first light, drawn from the car park",
    body: `# Why a small network is a good network

*A note on neighbourhoods, gossip, and keeping only what you will read.*

Most social software is built to maximise the number of people you can reach. Scuttlebutt, the peer-to-peer network that inspired a good deal of what we do here, was built around a different number: the number of people you can care about. Your feed is the people you follow, and the people they follow, and then it stops.

{{INLINE}}

## Distance is information

When everything is replicated from everywhere, distance disappears, and with it any sense of where a voice came from. When you replicate only what is near you, **distance becomes information**. A note from a friend of a friend reads differently from a note from a friend, and that is as it should be. You know roughly how much context you have, and you know whom to ask when you have none.

> The graph is the spam filter. Nobody is blocked; most people are simply far away.

There are three rings worth naming:

1. **You**, whose whole history is kept.
2. **The people you follow**, with a generous window of recent history.
3. **Their follows**, with a short window, just enough to read along.

### What it costs

Rough numbers for a node that follows about a hundred people:

- a few hundred thousand triples
- a few hundred megabytes of memory
- almost no bandwidth once the backfill has finished

The cost is the point. A small network is cheap to keep, and cheap things can be kept by people who are not professionals.

## What it asks of you

A small network asks you to be a neighbour. You cannot shout into it and hope the right people hear. You have to follow thoughtfully, mute what you do not want, and accept that some voices will never reach you because nobody nearby links to them. That feels like a loss at first. After a month it feels like a relief.

It also changes the shape of replies. In a huge timeline a reply is a flare that burns out in a minute. In a small one it is closer to a conversation at a table. People answer slowly and at length, and they remember what you said last week.

Some things are harder. Discovery is harder: you will not stumble into a new community by accident, and you have to go and look. Search across a neighbourhood is also a smaller search, so the answer to "has anyone written about this?" is more often "not in my corner, try the next one over". Those are fair trade-offs for a node you can understand.

## Keeping only what you will read

The last argument is the least technical. A node that keeps everything keeps a great deal you will never open. A node that keeps your neighbourhood keeps the things you are likely to read, and keeps them for a sensible length of time. Older history, outside the window, is simply not fetched. Nothing is lost that you were going to see.

~~~sparql
SELECT ?note ?createdAt WHERE {
  ?list nostr:author <nostr:npub1…> ; nostr:kind 3 ; nostr:follows ?author .
  ?note nostr:author ?author ; nostr:kind 1 ; nostr:createdAt ?createdAt .
}
ORDER BY DESC(?createdAt) LIMIT 50
~~~

That query is the whole feed. It is short enough to read, and that is most of its charm.

## Reading further

| Idea | Where |
| ---- | ----- |
| Gossip replication | The Scuttlebutt protocol guide |
| The outbox model | NIP-65 |
| Replaceable events | NIP-01 |

If you want a single sentence to take away, take this one: keep less, and read all of it.`,
  },
  {
    slug: "listening",
    author: "nova",
    title: "Listening to the sky at three in the morning",
    summary:
      "What a night shift at a radio telescope teaches you about patience.",
    topic: "astronomy",
    days: 20,
    tags: ["astronomy", "nightshift", "radio"],
    cover: true,
    inline: "The dish at three in the morning, long exposure",
    body: `# Listening to the sky at three in the morning

*What a night shift at a radio telescope teaches you about patience.*

The shift starts when the light goes and ends when the coffee does. In between there is a long, quiet stretch that people outside the work never imagine: hours of waiting for the sky to show you something you can use, and hours more for the instruments to tell you that the thing you saw was your own cable.

{{INLINE}}

## The dish does not care

A radio dish has no opinions. It points where it is told and listens to whatever arrives. Most of what arrives is ordinary: the hum of the power grid, the satellites that cross the field every few minutes, the occasional aircraft whose transponder sounds, on the spectrum, almost like a pulsar. Our job is to separate the few signals that matter from a great deal that does not.

That separation is slow, and mostly boring. You learn to read a waterfall plot the way a sailor reads the sea: not by any single wave, but by the texture of the whole. Rows of noise, a stripe that should not be there, a drift in the baseline that means the receiver has warmed up. You stop looking for the answer and start looking for the thing that is wrong.

## Patience as a method

Three habits taught me more patience than anything else.

First, the calibration. Every observation depends on knowing what the instrument does on an empty patch of sky, so we measure that patch again and again. It is dull work, and it is the only reason the bright results mean anything.

Second, the schedule. Targets rise and set, weather arrives without an appointment, and a source that was visible at midnight is behind a hill by two. You plan for the sky you expect and accept the sky you get.

Third, the repeat. A single detection is a rumour. A detection that comes back on the next night, and the night after, is starting to be a fact. Many of the results I am proudest of were quiet repeats of earlier quiet results.

> Nobody discovers anything in an hour. Most discoveries are a long series of hours that happened to agree.

## What the night shift keeps

The hardest part is sleep. The body runs on the wrong clock, and by the end of a week it is never quite sure whether it is tired or hungry. I have made peace with that by treating the night as a kind of retreat. The telescope is the only thing that asks for attention, and the sky is patient enough to wait for it.

There is an odd intimacy in working at three in the morning. The town is asleep, the roads are empty, and the only people awake are the ones who chose to be. We talk on the radio about nothing, about the football, about the weather back home, and we are very careful with the things that matter.

If you ever visit a site like this, go in the dark and stay still for ten minutes. Let your eyes adjust. The radio side of the sky is invisible to you, but the optical side will give back something of the same feeling: a sense that you are small, that the signal is faint, and that waiting is part of the observation.

~~~text
03:14:09  calib  ok    gain 0.98   baseline drift 0.2 K
03:19:41  scan   ok    target lock  snr 6.4
03:31:02  scan   flag  satellite pass, excised
~~~

I will write again when the waterfall shows something I cannot explain. Until then, the sky and I are both being patient.`,
  },
  {
    slug: "ferns",
    author: "mara",
    title: "Ferns for people who forget to water",
    summary:
      "Ferns are forgiving about most things and very precise about one: the water they are given.",
    topic: "gardening",
    days: 9,
    tags: ["ferns", "houseplants", "gardening"],
    cover: true,
    body: `# Ferns for people who forget to water

*Ferns are forgiving about most things, and very precise about one.*

I keep ferns because they do not complain loudly. A fern will tell you it is thirsty by drooping, and it will forgive a late watering with a few days of patience. What it will not forgive is a bone-dry root ball left in a warm room in January. Most of what I know about ferns I learned by making that mistake.

{{INLINE}}

## The short list

Four ferns have carried me through several years of forgetting. They are all easy in a shaded room, and they all look better than their care deserves.

| Fern | Light | Water | Notes |
| ---- | ----- | ----- | ----- |
| Boston fern | Bright, indirect | Keep damp | Mist in dry rooms |
| Maidenhair | Shade | Keep moist | Hates draughts |
| Staghorn | Bright | Soak weekly | Mount on a board |
| Bird's nest | Shade | Moderate | Forgiving |

The table is only a starting point. Your room will have its own light, and your heating will have its own ideas.

## Watering without a schedule

A calendar is the wrong tool. Lift the pot, feel how light it is, and push a finger into the compost. If the top two centimetres are dry and the pot feels light, water until it runs out of the bottom and empty the saucer. If the pot feels heavy, leave it alone.

This sounds fussy, but it takes about a minute per plant once you have done it a dozen times. The habit replaced the reminder on my phone, which I have now disabled. It was making things worse.

> Ferns do not need you to remember them. They need you to notice them once in a while.

## Humidity, and other myths

Misting is popular and mostly does nothing for more than a few minutes. A tray of wet pebbles under the pot helps a little more. A cheap humidifier in the room helps most, especially in winter, when the radiators dry the air to something like a desert.

Repotting is less frequent than you think. Most ferns like to be a little root-bound, and a pot one size up every second year is plenty. Use a peat-free mix with some bark in it, and never let the pot sit in water.

~~~text
rough season plan
  march      repot the staghorn, check the bird's nest for scale
  june       feed weekly at half strength, stop in september
  november   water less, keep them away from the radiator
~~~

## What the ferns taught me

They taught me that a slow plant is an honest one. A fern does not grow in a hurry, and it does not pretend to. When it unfurls a new frond you know the last three months were not wasted, because the fern spent them building the root that makes the frond possible.

That is also a fair description of how I want to write here: slowly, with some care for the roots, and with a willingness to let something unfurl when it is ready.`,
    revision: {
      days: 2,
      edits: [
        [
          "I learned by making that mistake.",
          "I learned by making that mistake more than once, and I am not proud of it.",
        ],
        [
          "The habit replaced the reminder on my phone, which I have now disabled. It was making things worse.",
          "The habit replaced the reminder on my phone, which I have now disabled. It was making things worse. Next spring I will try a maidenhair in the bathroom, where the steam should do the work for me.",
        ],
      ],
    },
  },
  {
    slug: "slow-reading",
    author: "mara",
    title: "Reading slowly, on purpose",
    summary:
      "A short argument for the book you put down halfway and pick up again next week.",
    topic: "typography",
    days: 15,
    tags: ["reading", "books"],
    cover: false,
    body: `# Reading slowly, on purpose

*A short argument for the book you put down halfway, and pick up again next week.*

I read slowly. It is not a virtue or a flaw, just a fact about how my attention works, and for a long time I tried to fix it. I bought speed-reading courses. I set myself reading goals. I felt guilty about the pile of unfinished paperbacks on the windowsill, which grew every winter until it reached the curtain rail.

## Speed is a kind of skimming

Most advice about reading assumes that the point is to get to the end. Read more, read faster, finish the book, tick it off. That is a reasonable goal for a report or a manual. It is a poor goal for a novel, or for an essay that asks you to change your mind.

When I read quickly I get the plot and miss the sentences. I can tell you what happened in a chapter and not one line that made me stop. The slow reader keeps the line. The slow reader writes it down, copies it into a notebook, and argues with it over a week of evenings.

## A book is a place you return to

I now read in short sessions, usually before breakfast or in the last twenty minutes before bed. A chapter is a good size. I put a pencil in the margin where something catches me, and I close the book even when I am enjoying it, so that the next session has something to look forward to.

When I come back I often find that the author has done something I missed the first time: a repeated image in a later scene, or a clause that means something different after the twist. Those discoveries are the reward for reading slowly. They do not come from speed.

> The second reading is where the book becomes yours. The first is only the introduction.

## Keeping track

I keep a notebook for this. Nothing elaborate: a date, the title, the page, and a sentence I want to keep. Some entries are a single word. Others run to a paragraph. Years later the notebook is more useful than any library catalogue, because it records what I found worth stopping for.

Sometimes I also write two or three sentences about a book after I finish it. That note is for me, not for anybody else. It is the only review I ever need to write.

## Permission

If you are also a slow reader, here is the permission I wish somebody had given me earlier. You do not have to finish every book. You do not have to read at a pace that suits a commute or a meeting schedule. A book can wait on the windowsill for a season and still be waiting for you when you come back.

Reading slowly is not the same as reading badly. It is simply reading at the speed at which a sentence can be heard, and then, now and then, being glad you slowed down.`,
  },
  {
    slug: "tide-calendar",
    author: "ines.d",
    title: "A tide pool calendar for the Atlantic coast",
    summary:
      "When to go down to the rocks, month by month, and what to look for once you are there.",
    topic: "tidepools",
    days: 12,
    tags: ["tidepools", "coast", "field"],
    cover: true,
    body: `# A tide pool calendar for the Atlantic coast

*When to go down to the rocks, month by month, and what to look for once you are there.*

Every good tide pool trip starts with a table, not a map. The map tells you where the pools are. The table tells you when the pools are reachable, and in Lisbon the difference between a good morning and a wasted one is often a single hour. I keep a calendar on the fridge and I update it every January from the official tables.

## Reading the table

The lowest tides of the year come in clusters, roughly every two weeks at the spring tides. Around the new and full moon the water drops furthest, and the rocks that are usually under a metre of sea are briefly open to the air. Those are the mornings that matter.

You want a low below about 0.4 metres, ideally at a time when the sun is up and the wind is light. Anything lower is a bonus, and anything higher is a walk along the sand.

| Season | Best window | What to expect |
| ------ | ----------- | -------------- |
| Winter | Late morning, low sun | Calm pools, bright anemones, few people |
| Spring | Early morning | Sea stars recovering, the first crabs out |
| Summer | Dawn or dusk | Busy by day, quiet and cool at the edges |
| Autumn | Mid-morning | Seaweed thick and good for hiding things under |

## Before you go

Wear shoes with grip, not sandals, and bring a bag for anything you want to show someone later. Keep a small tub of seawater so the animals can be looked at without being handled. A hand lens is worth more than a camera.

Check the wind. A strong onshore breeze can push the surf over the rocks faster than you can walk back, and a calm morning is much safer than a windy one even at the same low tide.

## On the rocks

Move slowly and step where others have stepped. Look at the edges of the pools and under the overhangs, not only at the water. Most of the life is hidden in shade and in gaps the width of a finger.

The rules are simple. Turn stones back the way you found them, with the same face down. Do not pull limpets off the rock; they return to their own scar and will starve if you move them. Leave the sea stars where they are, even when they are beautiful.

~~~text
pool 3, north face, spring tide, 09:40
  anemones (beadlet)    many, closed when exposed
  shore crab            two, under the largest stone
  common prawn          one, very fast
  sea stars             three, small, orange
~~~

## Afterwards

Write down what you saw while you still remember it. The notebook matters more than the photographs, because the photographs of a tide pool look like smears of colour unless you were very lucky with the light.

Then check the table for next month and mark the best mornings. The sea will be there, and so will the rocks, and the calendar keeps you honest about when to go.`,
  },
  {
    slug: "rye-week",
    author: "yusuf.k",
    title: "Feeding a rye starter through a cold week",
    summary:
      "Rye starters are sulky in the cold. Here is how I kept one alive through a week of winter with no warm corner.",
    topic: "bread",
    days: 6,
    tags: ["bread", "sourdough", "rye"],
    cover: true,
    body: `# Feeding a rye starter through a cold week

*Rye starters are sulky in the cold. Here is how I kept one alive through a week with no warm corner.*

The flat has one warm room in winter, and it is the bathroom after a shower. My rye starter does not like the kitchen, where the window lets in a steady draught off the balcony. For most of January it sat at a temperature that made it sluggish, sour in an unhappy way, and it stopped doubling entirely by Tuesday.

This is the week I got it back, and what I learned about feeding it when the room will not cooperate.

## What rye needs

Rye flour has a lot of enzymes and not much gluten. It ferments fast, and it also sours quickly and tends to collapse if you over-proof it. A rye starter is happiest at around twenty-six degrees, and it will forgive a few degrees either way if the feeding is steady.

In a cold kitchen the activity slows and the bacteria change balance. The yeast keeps going, but the acid builds faster than the gas, and the whole thing starts to smell of old cardboard. That is the warning sign.

## The schedule that worked

I stopped trying to keep the starter on a timer and instead kept it on a rough sequence. Morning, feed it with equal weights of flour and water, then leave it in the bathroom with the door shut. Evening, check the level, feed again if it has risen and dropped, and pour off the liquid if there is any.

- **Morning:** 20 g starter, 40 g rye flour, 40 g warm water (about 35 degrees).
- **Evening:** a smaller feed, 10 g starter, 30 g rye, 30 g water, only if it has peaked.
- **Night:** a hot water bottle wrapped in a towel, placed beside the jar, not under it.

The hot water bottle was the single most useful thing. It did what the bathroom alone could not.

## Reading the jar

Look for the dome. A healthy rye starter domes gently and then flattens as it peaks, and the surface shows small, even bubbles. Tap the side of the jar and see whether the dome jiggles. A dense, flat starter that will not lift is not dead, but it needs a warmer and smaller feed.

Smell it honestly. Pear drops and yoghurt are good. Nail varnish means the acid has run ahead of the yeast, and the fix is a larger feed and a warmer room, in that order.

~~~text
day  time   feed (g)          peak   note
1    08:00  20 / 40 / 40      14:00  flat, cold kitchen
2    08:00  20 / 40 / 40      15:30  bathroom, towel bottle at night
3    08:00  20 / 40 / 40      13:00  first real dome
4    08:00  20 / 40 / 40      12:30  pear drops again
~~~

## The bake, briefly

Once the starter doubles reliably, the rye loaf is simple: a 100 percent rye dough, a short rest, a few folds at the start of the bake, and a long time in a hot oven with a tin of water beside the loaf. Rye does not need the shaping drama of wheat. It needs patience and a trust that the crumb will set when it sets.

The loaf that came out at the end of the week was dense, dark, and a little sour, which is exactly what I wanted. The starter is back in the bathroom, under its towel, and it will stay there until March.`,
  },
  {
    slug: "beans-and-figs",
    author: "lucia.f",
    title: "Beans, cordons and the fig that refuses",
    summary:
      "Three things that keep me in the garden through a Bologna summer: runner beans, a row of cordons, and a fig that will not fruit.",
    topic: "gardening",
    days: 17,
    tags: ["gardening", "beans", "figs"],
    cover: true,
    body: `# Beans, cordons and the fig that refuses

*Three things that keep me in the garden through a Bologna summer: runner beans, a row of cordons, and a fig that will not fruit.*

Every summer I plant too many beans, trim too few tomatoes, and wait for the fig to decide whether it likes me. The beans are reliable. The tomatoes are generous if I am firm with them. The fig is a long conversation that has not yet reached an agreement.

## The beans

Runner beans are the best thing I grow for the table, because they keep producing as long as I keep picking. Sow them in late May, once the soil has warmed, directly into the bed at the foot of a tall frame. Give them more water than you think, and mulch the root zone with straw.

The trick is to pick small. A bean the length of a finger is tender and sweet. One the length of a hand is stringy and disappointing. I now walk the row every second day with a basket and a sharp knife, and the plants respond by producing more.

- Pick every two days, from the bottom of the frame upward.
- Water at the roots in the evening, never on the leaves.
- Save a few pods at the end of August and let them dry on the stem for next year.

## The cordon tomatoes

A cordon is a tomato trained to a single stem, tied to a cane, and pinched out every week. It takes more attention than a bush, and it gives a longer harvest and a better flavour in the middle of the season. The rule I follow is to remove the side shoots while they are small, before they become a second plant.

I tie the stem loosely every fortnight and feed with a diluted comfrey tea once the first fruit sets. The comfrey smells terrible, and the tomatoes do not seem to mind.

> A cordon is a conversation you have every week. Skip a week and you will be arguing for a month.

## The fig

The fig is in the corner by the wall, where it gets the afternoon heat that reflects off the bricks. It has grown well and produced a lot of leaves, and for four summers it has produced almost no fruit. I have tried everything I was told: less nitrogen, more potassium, a little root pruning, and an afternoon of quiet on the bench beside it.

Figs flower inside the fruit, so you never see the flowers. That makes them hard to diagnose. My neighbour, who has a fig in the courtyard that fruits every year, says mine is too comfortable. She thinks the roots have spread into the wall and forgotten how to be hungry.

So this winter I am going to cut back the roots on one side, and see what the fig makes of that. It is not a gentle experiment, but the fig has had four years to make its point.

~~~text
bed  crop     sown        first pick   notes
A    runner   late May    early July   frame, straw mulch
B    tomato   mid April   late June    cordons, comfrey tea
C    basil    June        July         between the tomatoes
wall fig      --          none yet     root cut planned, winter
~~~

## What the garden keeps

The beans and tomatoes keep me outside in the evenings, with a glass of something cold and a basket that never seems quite full. The fig keeps me honest about what I can and cannot control. Both are good company, even when one of them is sulking.`,
  },
  {
    slug: "reading-a-tide-chart",
    author: "sigrid.h",
    title: "Reading a tide chart like a letter",
    summary:
      "A tide chart is a letter from the moon. Once you learn its handwriting, you can read the coast in it.",
    topic: "tidepools",
    days: 14,
    tags: ["tides", "charts", "coast"],
    cover: true,
    body: `# Reading a tide chart like a letter

*A tide chart is a letter from the moon. Once you learn its handwriting, you can read the coast in it.*

My father kept the light on the headland for thirty years, and every morning he read the tide chart at the kitchen table before he read anything else. I thought, as a child, that he was reading the news. He was reading the sea, and the sea was writing to him in numbers.

Tide charts look dense at first. Columns of times, columns of heights, a faint curve that rises and falls like breathing. But they follow a small number of rules, and once you know the rules the chart becomes a sentence you can say out loud.

## The shape of a day

Most coasts see two high waters and two low waters in roughly twenty-five hours. The gap between a high and the following low is about six hours and a little more, and the times move later by close to fifty minutes each day. That drift is the first thing to learn, because it explains why yesterday's low tide is never quite today's.

On the chart, look for the height of each high and low as well as its time. The height is the number that matters for the rocks. A high of four metres after a low of one metre is a large tidal range, and the water moves fast across the flats. A high of two metres after a low of one is gentle, and the same rocks will stay dry for an hour longer.

> The time tells you when to be careful. The height tells you how careful to be.

## Springs and neaps

Twice a month the sun and moon line up, and the tides grow larger. These are the spring tides, and their name has nothing to do with the season. Around a week later the sun and moon sit at right angles, and the tides shrink. These are the neaps.

On a good chart you will see the rhythm: a run of large ranges, a fortnight of small ones, then large again. I mark the springs in red on my own copy, because they are the days when the low water reaches the far rocks that the rest of the year keeps hidden.

## Weather writes in the margins

The chart is an astronomical prediction. It does not know about the wind. A strong onshore gale can push the water several tenths of a metre above the chart, and a long calm high pressure can hold it below. The skilled reader adds the weather by hand.

I keep a small table in the back of my notebook: a note of the pressure, the direction of the wind, and how far the water actually came up compared with the chart. After a few years the table is more useful than the chart itself, because it records this particular coast and not the average one.

~~~text
date    predicted high   observed   wind     pressure
03 Nov  3.9 m           4.2 m      SW 6     998 hPa
04 Nov  3.8 m           3.6 m      NE 3     1024 hPa
05 Nov  3.4 m           3.4 m      calm     1019 hPa
~~~

## Reading it like a letter

The best way to read a tide chart is slowly, from the top, with a pencil. Note the first low of the day and work outward. Then read the springs and neaps, then the weather, then the particular rocks you care about. Each line tells you something, and the whole tells you what the coast will do next week.

My father would have said that a good reader does not need to memorise the chart. You need to know its handwriting well enough that the surprises stand out. The sea is not unkind, but it is precise, and it never sends the same letter twice.`,
  },
  {
    slug: "tram-rain",
    author: "felix.b",
    title: "Recording a tram line on a rainy Tuesday",
    summary:
      "Three hours in a bus shelter with a microphone, a fence post and a tram route that talks back.",
    topic: "fieldrec",
    days: 8,
    tags: ["fieldrecording", "trams", "rain"],
    cover: true,
    inline: "Spectrogram of a tram bell in the rain",
    body: `# Recording a tram line on a rainy Tuesday

*Three hours in a bus shelter with a microphone, a fence post and a tram route that talks back.*

The forecast said rain from noon until the evening, and it was right. I took the recorder to the shelter at the end of line 6, where the trams turn and the bells ring for the driver to change ends, and I set up on the bench with the cable tucked under my coat. It was not a glamorous morning. It was the best sound I have caught all year.

{{INLINE}}

## Choosing the place

A bus shelter is a good place for a recording because it has a roof and walls, and both of them change the sound of the rain. The tin roof turns the drops into a drum. The glass side, which is cracked in one corner, adds a faint buzz that I have learned to like. Standing in the open, the same rain would be a hiss. Here it becomes a pattern.

The tram line runs on a curve about forty metres away, and the rails sing when a heavy car takes the bend. That is the sound I came for. It is almost a note, and when a car brakes into the turn the note bends down and then up again, like a voice settling after a sentence.

## Microphones and wind

Rain is kind to a microphone in some ways and cruel in others. Drops hitting the windscreen make a soft pink noise that drowns out the low frequencies, and any gust of wind turns the cable into a rumbling engine. I used a foam cover and a small furry one over it, and I kept the recorder on the bench rather than in my hand.

The levels were set low. Trams are loud at close range and very quiet in the distance, and a rainy morning has a wide dynamic range, from the bell at full volume to the drip from the gutter. I wanted all of it, without the bell clipping.

## What the morning sounded like

At nine the first car came round the curve, slow and wet, with the brakes sighing on the points. Its bell rang twice, a bright metal sound that the rain softened into something rounder. A man with an umbrella walked past without looking at the shelter, and his footsteps were the only sound that did not belong to the water.

By ten the trams were running every eight minutes, and the rhythm had settled. Rails, bell, rain on the roof, the tick of the cooling motor when a car stopped at the platform, and the long hush after the doors closed. I stopped checking the levels and let the morning happen.

> The best field recording is the one that stops feeling like a recording and starts feeling like a place you have been.

## Afterwards

Back at the flat I looked at the spectrogram. The bell is clear as a thin line near two kilohertz, with a shimmer above it that the rain made. Below it the wet rails show as a broad band, and the drops fill the high frequencies like grain on film. There was a bird in the trees across the road that I did not hear at all until I looked, a single thin stripe in the top corner.

I cut the recording to forty minutes and kept only the parts where the rain, the rails and the bell were all doing something at once. The rest went back into the archive, where it will wait for another rainy Tuesday.`,
  },
];

/** The draft of an unfinished article, kept by the owner. */
export const DRAFT = {
  slug: "sea-wall-notes",
  author: "mara",
  title: "Notes on the sea wall (unfinished)",
  summary: "Things I want to remember before I write the proper piece.",
  body: `# Notes on the sea wall (unfinished)

The wall at the end of the promenade is older than the houses behind it, and nobody seems to know who built the top course. There is a line of iron rings set into the coping, rusted to the colour of the bench they face. I want to write about those rings properly.

Things to check before I do: the council archive for the wall's date, whether the rings are for boats or for the lamps that used to stand on the promenade, and what the old fishermen call the stretch by the slipway.

TODO: find a photograph from the winter, when the spray came over the top. Ask Ada about the tide height for the storm in March.`,
};
