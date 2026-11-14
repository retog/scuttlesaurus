/**
 * Sign-in: browser extension, new identity, existing secret key, or read-only.
 *
 * @module
 */
import { Copy, Eye, KeyRound, Puzzle, Sparkles } from "lucide-preact";
import { useState } from "preact/hooks";
import {
  createIdentity,
  hasExtension,
  loginReadOnly,
  loginWithExtension,
  loginWithSecretKey,
} from "../lib/session.ts";
import { loginOpen } from "../lib/ui.ts";
import { Button } from "./Button.tsx";
import { Modal } from "./Modal.tsx";
import { toast } from "./Toast.tsx";

type Step = "choose" | "created" | "key" | "readonly";

/** Props of {@link LoginDialog}. */
export interface LoginDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful login (not after creating, until confirmed). */
  onLogin?: () => void;
}

/** The dialog itself, controllable by props (used by the gallery). */
export function LoginDialog({ open, onClose, onLogin }: LoginDialogProps) {
  const [step, setStep] = useState<Step>("choose");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ nsec: string; npub: string }>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const finish = () => {
    setStep("choose");
    setInput("");
    setError(undefined);
    setCreated(undefined);
    setSaved(false);
    onClose();
    onLogin?.();
  };

  const attempt = async (fn: () => unknown) => {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
      finish();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    // Closing after creating an identity is allowed once the key is saved.
    if (step === "created" && !saved) return;
    setStep("choose");
    setCreated(undefined);
    setError(undefined);
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Sign in" size="sm">
      {step === "choose" && (
        <div class="login">
          <p class="muted">
            Your identity is a Nostr key. Pick how you want to hold it.
          </p>
          {hasExtension() && (
            <button
              type="button"
              class="login__option"
              onClick={() => attempt(loginWithExtension)}
              disabled={busy}
            >
              <Puzzle size={22} aria-hidden="true" />
              <span>
                <strong>Browser extension</strong>
                <small>Recommended. The key never leaves the extension.</small>
              </span>
            </button>
          )}
          <button
            type="button"
            class="login__option"
            onClick={() => {
              setCreated(createIdentity());
              setStep("created");
            }}
          >
            <Sparkles size={22} aria-hidden="true" />
            <span>
              <strong>Create a new identity</strong>
              <small>Generates a key pair in this browser.</small>
            </span>
          </button>
          <button
            type="button"
            class="login__option"
            onClick={() => setStep("key")}
          >
            <KeyRound size={22} aria-hidden="true" />
            <span>
              <strong>Use an existing key</strong>
              <small>Paste your nsec.</small>
            </span>
          </button>
          <button
            type="button"
            class="login__option"
            onClick={() => setStep("readonly")}
          >
            <Eye size={22} aria-hidden="true" />
            <span>
              <strong>Just look around</strong>
              <small>Follow along with an npub, without signing.</small>
            </span>
          </button>
          {error && <p class="form-error" role="alert">{error}</p>}
          <p class="login__note muted">
            A key created or pasted here is stored in this browser's
            localStorage, unencrypted. Anyone with access to this browser
            profile, or any script running on this site, could read it. Prefer
            an extension for an identity you care about.
          </p>
        </div>
      )}

      {step === "created" && created && (
        <div class="login">
          <p>
            <strong>Save this secret key now.</strong>{" "}
            It is shown only once and cannot be recovered. Whoever has it can
            post as you.
          </p>
          <code class="login__secret" data-testid="nsec">{created.nsec}</code>
          <div class="row">
            <Button
              icon={<Copy size={16} />}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.nsec);
                  toast("Secret key copied", "success");
                } catch {
                  toast(
                    "Copy failed: select the key and copy it by hand",
                    "error",
                  );
                }
              }}
            >
              Copy secret key
            </Button>
          </div>
          <p class="muted">
            Your public identity is{" "}
            <span class="mono">{created.npub.slice(0, 16)}…</span>
          </p>
          <label class="login__confirm">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved((e.target as HTMLInputElement).checked)}
            />
            I have saved my secret key somewhere safe
          </label>
          <Button variant="primary" disabled={!saved} onClick={finish}>
            Continue
          </Button>
        </div>
      )}

      {step === "key" && (
        <form
          class="login"
          onSubmit={(e) => {
            e.preventDefault();
            attempt(() => loginWithSecretKey(input));
          }}
        >
          <label class="field">
            <span class="field__label">Secret key</span>
            <input
              class="field__input mono"
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder="nsec1…"
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            />
          </label>
          <p class="muted">Kept in this browser's localStorage, unencrypted.</p>
          {error && <p class="form-error" role="alert">{error}</p>}
          <div class="row">
            <Button variant="ghost" onClick={() => setStep("choose")}>
              Back
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!input.trim()}
              loading={busy}
            >
              Sign in
            </Button>
          </div>
        </form>
      )}

      {step === "readonly" && (
        <form
          class="login"
          onSubmit={(e) => {
            e.preventDefault();
            attempt(() => loginReadOnly(input));
          }}
        >
          <label class="field">
            <span class="field__label">Public key</span>
            <input
              class="field__input mono"
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder="npub1…"
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            />
          </label>
          <p class="muted">
            You will see the network as this person would, but cannot post.
          </p>
          {error && <p class="form-error" role="alert">{error}</p>}
          <div class="row">
            <Button variant="ghost" onClick={() => setStep("choose")}>
              Back
            </Button>
            <Button variant="primary" type="submit" disabled={!input.trim()}>
              Look around
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** The app-wide login dialog, opened with `openLogin()` from `lib/ui.ts`. */
export function GlobalLoginDialog() {
  return (
    <LoginDialog
      open={loginOpen.value}
      onClose={() => loginOpen.value = false}
    />
  );
}
