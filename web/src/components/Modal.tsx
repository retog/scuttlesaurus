/**
 * A modal dialog on top of the native `<dialog>` element (focus trap, Esc).
 *
 * @module
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { X } from "lucide-preact";
import { IconButton } from "./Button.tsx";
import { SignerStatus } from "./SignerStatus.tsx";

/** Props of {@link Modal}. */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ComponentChildren;
  /** Wider layout for editors. */
  size?: "sm" | "md";
}

/** Dialog with a title and close button; closes on Esc and backdrop click. */
export function Modal(
  { open, onClose, title, children, size = "md" }: ModalProps,
) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      class={`modal modal--${size}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div class="modal__panel" tabIndex={-1} autofocus>
          <header class="modal__header">
            <h2 class="modal__title">{title}</h2>
            <IconButton
              label="Close"
              icon={<X size={18} />}
              onClick={onClose}
            />
          </header>
          <div class="modal__body">{children}</div>
          <SignerStatus where="modal" />
        </div>
      )}
    </dialog>
  );
}
