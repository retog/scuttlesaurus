/**
 * The article editor: a formatting toolbar acting on the textarea selection,
 * and the Markdown source beside a live preview (side by side from 1100px,
 * "Write | Preview" tabs below).
 *
 * The text transforms are pure ({@link applyEdit}) so they can be read and
 * tested without the DOM.
 *
 * @module
 */
import {
  Bold,
  Code,
  Heading2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { toast } from "./Toast.tsx";
import { IconButton } from "./Button.tsx";
import { Markdown } from "./Markdown.tsx";
import { Tabs } from "./Tabs.tsx";

/** A formatting command of the toolbar. */
export type EditAction =
  | "bold"
  | "italic"
  | "heading"
  | "link"
  | "quote"
  | "code"
  | "bullet"
  | "numbered";

/** The text after an edit and the selection to show. */
export interface EditResult {
  text: string;
  start: number;
  end: number;
}

function wrap(
  text: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string,
): EditResult {
  const selected = text.slice(start, end) || placeholder;
  return {
    text: text.slice(0, start) + before + selected + after + text.slice(end),
    start: start + before.length,
    end: start + before.length + selected.length,
  };
}

/**
 * Toggle a line prefix on every line of the selection: when all lines carry
 * `marker` it is removed, otherwise `add` rewrites each line.
 */
function toggleLines(
  text: string,
  start: number,
  end: number,
  marker: RegExp,
  add: (line: string, index: number) => string,
): EditResult {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const found = text.indexOf("\n", end);
  const lineEnd = found === -1 ? text.length : found;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const remove = lines.every((line) => marker.test(line));
  const block = lines
    .map((line, i) => (remove ? line.replace(marker, "") : add(line, i)))
    .join("\n");
  return {
    text: text.slice(0, lineStart) + block + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + block.length,
  };
}

/**
 * Apply a toolbar command to `text` with the selection `start`..`end`.
 * Without a selection, inline commands insert a placeholder to overwrite.
 */
export function applyEdit(
  text: string,
  start: number,
  end: number,
  action: EditAction,
): EditResult {
  switch (action) {
    case "bold":
      return wrap(text, start, end, "**", "**", "bold text");
    case "italic":
      return wrap(text, start, end, "*", "*", "italic text");
    case "code": {
      const selected = text.slice(start, end);
      if (selected.includes("\n")) {
        return wrap(text, start, end, "```\n", "\n```", "code");
      }
      return wrap(text, start, end, "`", "`", "code");
    }
    case "link": {
      const label = text.slice(start, end) || "link text";
      const url = "https://";
      return {
        text: text.slice(0, start) + `[${label}](${url})` + text.slice(end),
        start: start + label.length + 3,
        end: start + label.length + 3 + url.length,
      };
    }
    case "heading":
      return toggleLines(
        text,
        start,
        end,
        /^#{1,6} /,
        (line) => "## " + line.replace(/^#{1,6} /, ""),
      );
    case "quote":
      return toggleLines(text, start, end, /^> /, (line) => "> " + line);
    case "bullet":
      return toggleLines(text, start, end, /^- /, (line) => "- " + line);
    case "numbered":
      return toggleLines(
        text,
        start,
        end,
        /^\d+\. /,
        (line, i) => `${i + 1}. ` + line.replace(/^\d+\. /, ""),
      );
  }
}

/** Props of {@link MarkdownEditor}. */
export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Uploads an image and resolves with its URL; the editor inserts `![](url)`. */
  onUploadImage: (file: File) => Promise<string>;
  placeholder?: string;
}

/** Markdown source with a toolbar and a live preview. */
export function MarkdownEditor(
  { value, onChange, onUploadImage, placeholder }: MarkdownEditorProps,
) {
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const latest = useRef(value);
  latest.current = value;
  const pending = useRef<{ start: number; end: number } | undefined>(undefined);
  const [pane, setPane] = useState<"write" | "preview">("write");
  const [uploading, setUploading] = useState(false);
  const imageAt = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  useEffect(() => {
    const el = area.current;
    const next = pending.current;
    if (!el || !next) return;
    pending.current = undefined;
    el.focus();
    el.setSelectionRange(next.start, next.end);
  }, [value]);

  const select = (result: EditResult) => {
    pending.current = { start: result.start, end: result.end };
    onChange(result.text);
  };

  const apply = (action: EditAction) => {
    const el = area.current;
    if (!el) return;
    select(applyEdit(el.value, el.selectionStart, el.selectionEnd, action));
  };

  const insertImage = async (picked: File) => {
    setUploading(true);
    try {
      const url = await onUploadImage(picked);
      const text = latest.current;
      const start = Math.min(imageAt.current.start, text.length);
      const end = Math.min(imageAt.current.end, text.length);
      const snippet = `![](${url})`;
      select({
        text: text.slice(0, start) + snippet + text.slice(end),
        start: start + snippet.length,
        end: start + snippet.length,
      });
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div class={`md-editor md-editor--${pane}`}>
      <div class="md-editor__bar" role="toolbar" aria-label="Formatting">
        <IconButton
          label="Bold (Ctrl+B)"
          size="sm"
          icon={<Bold size={18} />}
          onClick={() => apply("bold")}
        />
        <IconButton
          label="Italic (Ctrl+I)"
          size="sm"
          icon={<Italic size={18} />}
          onClick={() => apply("italic")}
        />
        <IconButton
          label="Heading"
          size="sm"
          icon={<Heading2 size={18} />}
          onClick={() => apply("heading")}
        />
        <IconButton
          label="Link (Ctrl+K)"
          size="sm"
          icon={<LinkIcon size={18} />}
          onClick={() => apply("link")}
        />
        <IconButton
          label="Quote"
          size="sm"
          icon={<Quote size={18} />}
          onClick={() => apply("quote")}
        />
        <IconButton
          label="Code"
          size="sm"
          icon={<Code size={18} />}
          onClick={() => apply("code")}
        />
        <IconButton
          label="Bulleted list"
          size="sm"
          icon={<List size={18} />}
          onClick={() => apply("bullet")}
        />
        <IconButton
          label="Numbered list"
          size="sm"
          icon={<ListOrdered size={18} />}
          onClick={() => apply("numbered")}
        />
        <IconButton
          label={uploading ? "Uploading image…" : "Insert image"}
          size="sm"
          disabled={uploading}
          icon={<ImagePlus size={18} />}
          onClick={() => {
            const el = area.current;
            imageAt.current = el
              ? { start: el.selectionStart, end: el.selectionEnd }
              : { start: latest.current.length, end: latest.current.length };
            file.current?.click();
          }}
        />
        <input
          ref={file}
          class="visually-hidden"
          type="file"
          accept="image/*"
          tabIndex={-1}
          onChange={(event) => {
            const input = event.target as HTMLInputElement;
            const picked = input.files?.[0];
            input.value = "";
            if (picked) insertImage(picked);
          }}
        />
      </div>
      <div class="md-editor__tabs">
        <Tabs
          label="Editor pane"
          value={pane}
          onChange={setPane}
          tabs={[
            { value: "write", label: "Write" },
            { value: "preview", label: "Preview" },
          ]}
        />
      </div>
      <div class="md-editor__panes">
        <textarea
          ref={area}
          class="md-editor__input"
          aria-label="Article text in Markdown"
          placeholder={placeholder ?? "Write in Markdown…"}
          value={value}
          spellcheck
          onInput={(event) =>
            onChange((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (!(event.ctrlKey || event.metaKey)) return;
            const key = event.key.toLowerCase();
            const action: EditAction | undefined = key === "b"
              ? "bold"
              : key === "i"
              ? "italic"
              : key === "k"
              ? "link"
              : undefined;
            if (action) {
              event.preventDefault();
              apply(action);
            }
          }}
        />
        <div class="md-editor__preview" aria-label="Preview">
          {value.trim()
            ? <Markdown source={value} />
            : <p class="muted">Nothing to preview yet.</p>}
        </div>
      </div>
    </div>
  );
}
