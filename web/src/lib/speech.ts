/**
 * The read-aloud player: speaks a sequence of items (an article, or the notes
 * of a feed one after the other) with the browser's Web Speech API.
 *
 * Items come from a {@link SpeechSource}, which may load more as the player
 * nears its end (the next page of a feed). Every item is spoken chunk by
 * chunk (see `speech_text.ts`); pausing cancels the synthesizer and resuming
 * says the current chunk again, which works around browsers whose own
 * `pause()` does not resume. The state is in signals for the player bar and
 * for the highlight of the note being read.
 *
 * @module
 */
import { computed, signal } from "@preact/signals";
import { chunkText } from "./speech_text.ts";

/** One thing to read: a note or an article. */
export interface SpeechItem {
  /** Unique within the source; a note's feed key, an article's naddr. */
  key: string;
  /** Short label for the player, e.g. the author's name or the title. */
  label: string;
  /** The text, in paragraphs; chunked by the player. */
  paragraphs: string[];
  /** BCP 47 language of the text, when known. */
  lang?: string;
  /** In-app path of the item, for the player's link. */
  path?: string;
}

/** Where the player takes its items from. */
export interface SpeechSource {
  /** Shown in the player bar, e.g. "Home · Following". */
  title: string;
  /** The next item, or `null` at the end. Called one item at a time. */
  next(): Promise<SpeechItem | null>;
}

/** What the player bar shows. */
export interface PlayerState {
  title: string;
  status: "loading" | "playing" | "paused" | "error";
  /** Why the next item could not be loaded (status `error`). */
  error?: string;
  item?: SpeechItem;
  /** 0-based position of the item in the source. */
  index: number;
  /** Whether there is an item before this one. */
  hasPrevious: boolean;
}

/** Whether this browser can speak. */
export const speechSupported = typeof globalThis.speechSynthesis !==
    "undefined" &&
  typeof globalThis.SpeechSynthesisUtterance !== "undefined";

/** The player, or `null` when nothing is being read. */
export const player = signal<PlayerState | null>(null);

/** Key of the item being read, for highlighting it. */
export const speakingKey = computed(() => player.value?.item?.key);

const RATE_KEY = "scuttlesaurus.speech.rate";
const VOICE_KEY = "scuttlesaurus.speech.voice";

/** The speaking rates the player offers. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // the choice just does not survive a reload
  }
}

/** Speaking rate, 1 is normal. */
export const rate = signal<number>(
  (() => {
    const r = Number(stored(RATE_KEY));
    return (RATES as readonly number[]).includes(r) ? r : 1;
  })(),
);

/** `voiceURI` of the chosen voice; `null` lets the browser choose by language. */
export const voiceUri = signal<string | null>(stored(VOICE_KEY));

/** The voices of this browser, filled in once the browser has them. */
export const voices = signal<SpeechSynthesisVoice[]>([]);

if (speechSupported) {
  const update = () => {
    voices.value = speechSynthesis.getVoices();
  };
  update();
  speechSynthesis.addEventListener?.("voiceschanged", update);
  // Do not keep talking after the tab is gone (some browsers do).
  globalThis.addEventListener?.("pagehide", () => speechSynthesis.cancel());
}

interface Run {
  source: SpeechSource;
  /** Items fetched so far, for going back. */
  items: SpeechItem[];
  /** Position in `items`. */
  index: number;
  chunks: string[];
  chunk: number;
  done: boolean;
  /** An item is being loaded; navigation waits for it. */
  busy: boolean;
}

let run: Run | null = null;
/** Bumped whenever an utterance in flight must be ignored. */
let generation = 0;
/** Keeps the utterance alive: Chrome drops `onend` of collected ones. */
let _current: SpeechSynthesisUtterance | null = null;

function publish(status: PlayerState["status"], error?: string): void {
  if (!run) {
    player.value = null;
    return;
  }
  player.value = {
    title: run.source.title,
    status,
    item: run.items[run.index],
    index: run.index,
    hasPrevious: run.index > 0,
    error,
  };
}

function chunksOf(item: SpeechItem): string[] {
  return item.paragraphs.flatMap((p) => chunkText(p));
}

function pickVoice(lang: string | undefined): SpeechSynthesisVoice | undefined {
  const all = voices.value.length ? voices.value : speechSynthesis.getVoices();
  const chosen = voiceUri.value
    ? all.find((v) => v.voiceURI === voiceUri.value)
    : undefined;
  if (chosen) return chosen;
  if (!lang) return undefined;
  const base = lang.toLowerCase().split("-")[0];
  return all.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
    all.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base);
}

/** Says the current chunk of the current item, then moves on. */
function speak(): void {
  const r = run;
  if (!r) return;
  const item = r.items[r.index];
  if (!item) return;
  if (r.chunk >= r.chunks.length) {
    void advance(1);
    return;
  }
  const mine = ++generation;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(r.chunks[r.chunk]);
  const voice = pickVoice(item.lang);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else if (item.lang) utterance.lang = item.lang;
  utterance.rate = rate.value;
  utterance.onend = () => {
    if (mine !== generation || run !== r) return;
    r.chunk++;
    speak();
  };
  utterance.onerror = (event) => {
    if (mine !== generation || run !== r) return;
    if (event.error === "interrupted" || event.error === "canceled") return;
    // A chunk the voice cannot say is skipped rather than ending the run.
    r.chunk++;
    speak();
  };
  _current = utterance;
  speechSynthesis.speak(utterance);
  publish("playing");
}

/** Moves `step` items forward (or back), loading the next one if needed. */
async function advance(step: 1 | -1): Promise<void> {
  const r = run;
  // One move at a time: a second one while an item loads would load another.
  if (!r || r.busy) return;
  generation++;
  speechSynthesis.cancel();
  const target = r.index + step;
  if (target < 0) {
    r.chunk = 0;
    speak();
    return;
  }
  if (target >= r.items.length) {
    if (r.done) {
      stop();
      return;
    }
    publish("loading");
    r.busy = true;
    let item: SpeechItem | null;
    try {
      item = await r.source.next();
    } catch (reason) {
      if (run !== r) return;
      // Not the end of the list: the player stays, and resuming retries.
      publish(
        "error",
        reason instanceof Error ? reason.message : String(reason),
      );
      return;
    } finally {
      r.busy = false;
    }
    if (run !== r) return;
    if (!item) {
      r.done = true;
      stop();
      return;
    }
    r.items.push(item);
  }
  r.index = target;
  r.chunks = chunksOf(r.items[target]);
  r.chunk = 0;
  speak();
}

/** Starts reading `source` from its first item, replacing what was playing. */
export function play(source: SpeechSource): void {
  if (!speechSupported) return;
  stop();
  run = {
    source,
    items: [],
    index: -1,
    chunks: [],
    chunk: 0,
    done: false,
    busy: false,
  };
  publish("loading");
  void advance(1);
}

/** Reads one item on its own. */
export function playItem(title: string, item: SpeechItem): void {
  let given = false;
  play({
    title,
    next: () => {
      if (given) return Promise.resolve(null);
      given = true;
      return Promise.resolve(item);
    },
  });
}

/** Pauses after cutting the current chunk short. */
export function pause(): void {
  if (!run || player.value?.status !== "playing") return;
  generation++;
  speechSynthesis.cancel();
  publish("paused");
}

/**
 * Resumes at the start of the chunk that was cut short, or after a failed
 * load tries to load the next item again.
 */
export function resume(): void {
  const status = player.value?.status;
  if (!run) return;
  if (status === "error") void advance(1);
  else if (status === "paused") speak();
}

/** Pause or resume (or retry after an error). */
export function togglePause(): void {
  const status = player.value?.status;
  if (status === "paused" || status === "error") resume();
  else pause();
}

/** Skips to the next item. */
export function next(): void {
  void advance(1);
}

/** Back to the previous item, or to the start of the first one. */
export function previous(): void {
  if (!run || run.busy) return;
  // Well into an item, "back" restarts it, as in a music player.
  if (run.chunk > 1 || run.index === 0) {
    generation++;
    run.chunk = 0;
    speak();
    return;
  }
  void advance(-1);
}

/** Stops reading and closes the player. */
export function stop(): void {
  generation++;
  run = null;
  _current = null;
  if (speechSupported) speechSynthesis.cancel();
  publish("paused");
}

/** Changes the rate; the current chunk is said again at the new rate. */
export function setRate(value: number): void {
  rate.value = value;
  store(RATE_KEY, String(value));
  if (player.value?.status === "playing") speak();
}

/** Chooses a voice (`null`: by language); the current chunk restarts. */
export function setVoice(uri: string | null): void {
  voiceUri.value = uri;
  store(VOICE_KEY, uri);
  if (player.value?.status === "playing") speak();
}
