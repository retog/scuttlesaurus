/**
 * Text composer: a growing textarea with image attachment. It does not
 * publish by itself; the parent decides what `onSubmit` does (see
 * `postNote` in `lib/notes.ts`).
 *
 * @module
 */
import { ImagePlus } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { uploadBlob } from "../lib/blossom.ts";
import { canSign } from "../lib/session.ts";
import { openLogin } from "../lib/ui.ts";
import { Button, IconButton } from "./Button.tsx";
import { toast } from "./Toast.tsx";

/** Props of {@link Composer}. */
export interface ComposerProps {
  /** Receives the trimmed text. A rejection is shown and the text is kept. */
  onSubmit: (content: string) => Promise<void> | void;
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  autoFocus?: boolean;
  /** Disable everything (e.g. while the parent is busy). */
  disabled?: boolean;
  /** Compact single-row style for inline replies. */
  compact?: boolean;
}

/** The composer. When the session cannot sign it offers to sign in instead. */
export function Composer(props: ComposerProps) {
  const [text, setText] = useState(props.initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const signedIn = canSign.value;

  const grow = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  };
  useEffect(grow, [text]);
  useEffect(() => {
    if (props.autoFocus && signedIn) area.current?.focus();
  }, [props.autoFocus, signedIn]);

  const insert = (snippet: string) => {
    const el = area.current;
    const at = el?.selectionEnd ?? text.length;
    setText((t) => {
      const head = t.slice(0, at);
      const sep = head && !/\s$/.test(head) ? "\n" : "";
      return head + sep + snippet + "\n" + t.slice(at);
    });
  };

  const upload = async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      setUploading((n) => n + 1);
      try {
        const blob = await uploadBlob(file);
        insert(blob.url);
      } catch (e) {
        toast((e as Error).message, "error");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const submit = async () => {
    const content = text.trim();
    if (!content || busy || uploading) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onSubmit(content);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn) {
    return (
      <div class="composer composer--locked">
        <p class="muted">
          Sign in with a key to write. You can still read everything.
        </p>
        <Button variant="primary" onClick={openLogin}>Sign in</Button>
      </div>
    );
  }

  return (
    <div class={`composer${props.compact ? " composer--compact" : ""}`}>
      <textarea
        ref={area}
        class="composer__input"
        rows={props.compact ? 1 : 3}
        placeholder={props.placeholder ?? "What is on your mind?"}
        value={text}
        disabled={props.disabled || busy}
        aria-label={props.placeholder ?? "Note text"}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData?.files;
          if (pasted?.length) {
            e.preventDefault();
            upload(pasted);
          }
        }}
      />
      {error && <p class="composer__error" role="alert">{error}</p>}
      <div class="composer__bar">
        <input
          ref={files}
          class="visually-hidden"
          type="file"
          accept="image/*,video/*"
          multiple
          tabIndex={-1}
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            if (input.files?.length) upload(input.files);
            input.value = "";
          }}
        />
        <IconButton
          label={uploading ? "Uploading…" : "Attach image or video"}
          icon={<ImagePlus size={20} />}
          disabled={props.disabled || busy}
          onClick={() => files.current?.click()}
        />
        <span class="composer__hint muted">
          {uploading ? "Uploading…" : "Ctrl+Enter to send"}
        </span>
        <span class="rail__spacer" />
        {props.onCancel && (
          <Button variant="ghost" onClick={props.onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          loading={busy}
          disabled={props.disabled || !text.trim() || uploading > 0}
          onClick={submit}
        >
          {props.submitLabel ?? "Post"}
        </Button>
      </div>
    </div>
  );
}
