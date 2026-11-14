/**
 * The "waiting for approval" indicator of remote signing (NIP-46). Every
 * signature through a signer app may need a tap on the phone, so any call of
 * `signEvent` shows this, without the caller doing anything. It also offers
 * the page a signer asks the person to open (`auth_url`).
 *
 * Rendered once by the Shell, and inside every modal dialog (which covers the
 * Shell's own indicator).
 *
 * @module
 */
import { Smartphone } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { pendingSignatures, signerAuthUrl } from "../lib/remote_signer.ts";

/** Seconds after which the hint to open the signer app appears. */
const HINT_AFTER_SECONDS = 8;

/** Props of {@link SignerStatus}. */
export interface SignerStatusProps {
  /** `modal` is placed inside a dialog; `page` is fixed to the viewport. */
  where: "page" | "modal";
}

/** Shows nothing unless a signature is waiting for the signer. */
export function SignerStatus({ where }: SignerStatusProps) {
  const pending = pendingSignatures.value;
  const authUrl = signerAuthUrl.value;
  const oldest = pending.length ? pending[0].startedAt : undefined;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (oldest === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [oldest]);
  if (pending.length === 0) return null;
  const seconds = Math.max(0, Math.floor((now - pending[0].startedAt) / 1000));
  const what = pending.length === 1
    ? pending[0].what
    : `${pending.length} requests`;
  return (
    <div
      class={`signer-status signer-status--${where}`}
      role="status"
      aria-live="polite"
    >
      <span class="spinner spinner--inline" aria-hidden="true" />
      <span class="signer-status__text">
        <strong>Waiting for approval in your signer app…</strong>
        <small>
          {authUrl
            ? (
              <>
                Your signer needs you to continue on its page:{" "}
                <a href={authUrl} target="_blank" rel="noopener noreferrer">
                  open it
                </a>
              </>
            )
            : seconds >= HINT_AFTER_SECONDS
            ? `Asked to sign ${what} ${seconds} s ago. Open the app if you did not see a request.`
            : `Signing ${what}`}
        </small>
      </span>
      <Smartphone size={18} aria-hidden="true" />
    </div>
  );
}
