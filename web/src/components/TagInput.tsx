/**
 * Chip input for topics: type a word and press Enter or comma to add it,
 * Backspace on an empty field removes the last one.
 *
 * @module
 */
import { X } from "lucide-preact";
import { useState } from "preact/hooks";
import { normalizeTopic } from "../lib/articles.ts";

/** Props of {@link TagInput}. */
export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Accessible name of the field. */
  label: string;
  /** Maximum number of topics (default 8). */
  max?: number;
  placeholder?: string;
}

/** Topics as removable chips with a text field to add more. */
export function TagInput(
  { value, onChange, label, max = 8, placeholder }: TagInputProps,
) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const tag = normalizeTopic(raw);
    setDraft("");
    if (!tag || value.includes(tag) || value.length >= max) return;
    onChange([...value, tag]);
  };

  return (
    <div class="tag-input">
      <ul class="tag-input__chips" aria-label={label}>
        {value.map((tag) => (
          <li key={tag} class="tag-chip">
            <span>#{tag}</span>
            <button
              type="button"
              class="tag-chip__remove"
              aria-label={`Remove topic ${tag}`}
              onClick={() => onChange(value.filter((t) => t !== tag))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
        {value.length < max && (
          <li class="tag-input__field">
            <input
              class="tag-input__input"
              type="text"
              aria-label={label}
              placeholder={value.length === 0 ? placeholder : "Add a topic"}
              value={draft}
              maxLength={48}
              onInput={(e) => {
                const text = (e.target as HTMLInputElement).value;
                if (/[,\n]/.test(text)) add(text.replace(/[,\n]/g, ""));
                else setDraft(text);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add(draft);
                } else if (
                  e.key === "Backspace" && draft === "" && value.length > 0
                ) {
                  onChange(value.slice(0, -1));
                }
              }}
              onBlur={() => {
                if (draft.trim()) add(draft);
              }}
            />
          </li>
        )}
      </ul>
    </div>
  );
}
