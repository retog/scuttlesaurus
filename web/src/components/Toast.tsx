/**
 * Transient messages. Call {@link toast} from anywhere; {@link ToastHost}
 * (rendered once by the Shell) displays them.
 *
 * @module
 */
import { signal } from "@preact/signals";
import { AlertTriangle, CheckCircle2, Info } from "lucide-preact";

/** Visual kind of a toast. */
export type ToastKind = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const items = signal<ToastItem[]>([]);
let nextId = 0;

/** Show a message for a few seconds (errors stay longer). */
export function toast(
  message: string,
  kind: ToastKind = "info",
  durationMs = kind === "error" ? 7000 : 3500,
): void {
  const id = ++nextId;
  items.value = [...items.value, { id, message, kind }];
  setTimeout(() => dismiss(id), durationMs);
}

function dismiss(id: number): void {
  items.value = items.value.filter((t) => t.id !== id);
}

const ICONS = { info: Info, success: CheckCircle2, error: AlertTriangle };

/** Container for toasts; place once near the root. */
export function ToastHost() {
  return (
    <div class="toast-host" role="status" aria-live="polite">
      {items.value.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div class={`toast toast--${t.kind}`} key={t.id}>
            <Icon size={18} aria-hidden="true" />
            <span>{t.message}</span>
            <button
              type="button"
              class="toast__close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
