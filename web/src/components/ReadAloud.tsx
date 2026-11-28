/**
 * The read-aloud controls: {@link ReadAloudButton} starts reading (an article,
 * a feed), {@link ReadAloudBar} is the player docked at the bottom of the
 * screen while something is being read, across navigation.
 *
 * @module
 */
import {
  Headphones,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  X,
} from "lucide-preact";
import { useState } from "preact/hooks";
import { Link } from "../lib/router.tsx";
import {
  next,
  player,
  previous,
  rate,
  RATES,
  setRate,
  setVoice,
  speechSupported,
  stop,
  togglePause,
  voices,
  voiceUri,
} from "../lib/speech.ts";
import { Button, IconButton } from "./Button.tsx";

/** Props of {@link ReadAloudButton}. */
export interface ReadAloudButtonProps {
  /** Starts the player (with `play` or `playItem` of `lib/speech.ts`). */
  onStart: () => void;
  /** Button text (default "Read aloud"). */
  label?: string;
  /** `icon`: a round icon button, as in an action row. */
  look?: "pill" | "icon";
  title?: string;
}

/** Starts reading; renders nothing in browsers that cannot speak. */
export function ReadAloudButton(
  { onStart, label = "Read aloud", look = "pill", title }: ReadAloudButtonProps,
) {
  if (!speechSupported) return null;
  if (look === "icon") {
    return (
      <IconButton
        label={label}
        icon={<Headphones size={18} aria-hidden="true" />}
        onClick={onStart}
      />
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      class="read-aloud-btn"
      icon={<Headphones size={16} />}
      title={title}
      onClick={onStart}
    >
      {label}
    </Button>
  );
}

function rateLabel(r: number): string {
  return `${r}×`;
}

/** The player docked at the bottom while something is read aloud. */
export function ReadAloudBar() {
  const state = player.value;
  const [settings, setSettings] = useState(false);
  if (!state) return null;
  const { item, status } = state;
  const loading = status === "loading";
  const playing = status === "playing";
  const current = rate.value;
  const nextRate = RATES[
    (RATES.indexOf(current as typeof RATES[number]) + 1) %
    RATES.length
  ];
  const list = voices.value;
  return (
    <section class="read-aloud" aria-label="Read aloud">
      <div class="read-aloud__main">
        <span
          class={`read-aloud__icon${playing ? " is-playing" : ""}`}
          aria-hidden="true"
        >
          <Headphones size={18} />
        </span>
        <div class="read-aloud__text" aria-live="polite">
          <span class="read-aloud__title">{state.title}</span>
          <span class="read-aloud__item">
            {loading
              ? "Loading…"
              : item?.path
              ? <Link to={item.path}>{item.label}</Link>
              : item?.label}
          </span>
        </div>
        <div class="read-aloud__controls">
          <IconButton
            label="Previous"
            size="sm"
            disabled={loading}
            icon={<SkipBack size={18} />}
            onClick={previous}
          />
          <IconButton
            label={playing ? "Pause" : "Resume"}
            variant="primary"
            disabled={loading}
            icon={playing ? <Pause size={18} /> : <Play size={18} />}
            onClick={togglePause}
          />
          <IconButton
            label="Next"
            size="sm"
            disabled={loading}
            icon={<SkipForward size={18} />}
            onClick={next}
          />
          <button
            type="button"
            class="read-aloud__rate"
            title={`Speed ${rateLabel(current)}, change to ${
              rateLabel(nextRate)
            }`}
            onClick={() => setRate(nextRate)}
          >
            {rateLabel(current)}
          </button>
          <IconButton
            label="Voice"
            size="sm"
            active={settings}
            icon={<SlidersHorizontal size={18} />}
            onClick={() => setSettings(!settings)}
          />
          <IconButton
            label="Stop reading"
            size="sm"
            icon={<X size={18} />}
            onClick={stop}
          />
        </div>
      </div>
      {settings && (
        <label class="read-aloud__voice">
          <span>Voice</span>
          <select
            class="field__input"
            value={voiceUri.value ?? ""}
            onChange={(e) =>
              setVoice((e.currentTarget as HTMLSelectElement).value || null)}
          >
            <option value="">Automatic (by language)</option>
            {list.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}
