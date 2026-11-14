/**
 * A labelled value with a copy button and one line on what to do with it.
 *
 * @module
 */
import { Copy } from "lucide-preact";
import { Button } from "./Button.tsx";
import { copyText } from "./LoginDialog.tsx";

/** Props of {@link CopyField}. */
export interface CopyFieldProps {
  label: string;
  value: string;
  /** One sentence on what the value is for. */
  hint: string;
}

/** A URL or key the person needs to copy, with its purpose. */
export function CopyField({ label, value, hint }: CopyFieldProps) {
  return (
    <div class="copy-field">
      <div class="copy-field__head">
        <span class="copy-field__label">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy size={15} />}
          onClick={() => copyText(value, label)}
        >
          Copy
        </Button>
      </div>
      <code class="copy-field__value" title={value}>{value}</code>
      <p class="muted copy-field__hint">{hint}</p>
    </div>
  );
}
