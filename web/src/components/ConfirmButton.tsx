/**
 * A destructive action that asks once: the first press shows "Delete?" with
 * a confirm and a cancel button, the confirm runs `onConfirm`.
 *
 * @module
 */
import { useState } from "preact/hooks";
import { Button } from "./Button.tsx";

/** Props of {@link ConfirmButton}. */
export interface ConfirmButtonProps {
  /** Label of the first press, e.g. "Delete". */
  label: string;
  /** Question shown after the first press. */
  question?: string;
  /** Runs when confirmed. Rejections are shown below the buttons. */
  onConfirm: () => Promise<void> | void;
  /** Button size (default "sm"). */
  size?: "sm" | "md";
}

/** Two-step button for deletions. */
export function ConfirmButton(
  { label, question = "Delete this for good?", onConfirm, size = "sm" }:
    ConfirmButtonProps,
) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!asking) {
    return (
      <Button variant="ghost" size={size} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span class="confirm" role="group" aria-label={question}>
      <span class="confirm__question">{question}</span>
      <Button
        variant="danger"
        size={size}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await onConfirm();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setBusy(false);
          }
        }}
      >
        Yes, {label.toLowerCase()}
      </Button>
      <Button
        variant="ghost"
        size={size}
        disabled={busy}
        onClick={() => setAsking(false)}
      >
        Cancel
      </Button>
      {error && <span class="confirm__error" role="alert">{error}</span>}
    </span>
  );
}
