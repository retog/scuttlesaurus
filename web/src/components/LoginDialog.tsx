/**
 * Sign-in: browser extension, signer app (NIP-46), new identity, existing
 * secret key, or read-only.
 *
 * The pieces are exported so that the first-run setup and the settings page
 * reuse the same key handling: {@link ExtensionButton}, {@link SignerLogin},
 * {@link SecretKeyForm}, {@link PublicKeyForm} and {@link SecretKeyReveal}.
 * Each form takes an async submit handler and shows its error itself.
 *
 * @module
 */
import {
  Copy,
  Eye,
  KeyRound,
  Puzzle,
  Smartphone,
  Sparkles,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { status } from "../lib/node.ts";
import {
  chooseRelay,
  connectBunker,
  normalizeRelayInput,
  type PendingConnection,
  signerAuthUrl,
  startNostrConnect,
  SUGGESTED_RELAY,
} from "../lib/remote_signer.ts";
import { QrCode } from "./QrCode.tsx";
import {
  createIdentity,
  hasExtension,
  loginReadOnly,
  loginWithExtension,
  loginWithRemote,
  loginWithSecretKey,
} from "../lib/session.ts";
import { loginOpen } from "../lib/ui.ts";
import { Button } from "./Button.tsx";
import { Modal } from "./Modal.tsx";
import { toast } from "./Toast.tsx";

type Step = "choose" | "created" | "key" | "readonly" | "signer";

/** Copies text to the clipboard and says so; falls back to a hint. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, "success");
  } catch {
    toast("Copy failed: select the text and copy it by hand", "error");
  }
}

/** Props of {@link ExtensionButton}. */
export interface ExtensionButtonProps {
  /** Called after the extension has answered; throw to show an error. */
  onLogin: () => void | Promise<void>;
  busy?: boolean;
}

/**
 * The "browser extension" option. Renders nothing when no NIP-07 provider is
 * present.
 */
export function ExtensionButton({ onLogin, busy }: ExtensionButtonProps) {
  const [error, setError] = useState<string>();
  if (!hasExtension()) return null;
  return (
    <>
      <button
        type="button"
        class="login__option"
        disabled={busy}
        onClick={async () => {
          setError(undefined);
          try {
            await loginWithExtension();
            await onLogin();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <Puzzle size={22} aria-hidden="true" />
        <span>
          <strong>Browser extension</strong>
          <small>Recommended. The key never leaves the extension.</small>
        </span>
      </button>
      {error && <p class="form-error" role="alert">{error}</p>}
    </>
  );
}

/** Props of {@link SignerLogin}. */
export interface SignerLoginProps {
  /**
   * Called after the signer app has connected and the session is set; throw to
   * show an error (the first-run setup claims the node here).
   */
  onLogin: () => void | Promise<void>;
  /** Shows a Back button, and a Cancel while waiting, when given. */
  onBack?: () => void;
}

/**
 * Sign in with a signer app over NIP-46 "Nostr Connect" (Amber and others).
 *
 * Shows a `nostrconnect://` link (tapping it opens the signer app on a phone),
 * the same link as a QR code for a signer on another device, and a field for a
 * `bunker://` address or `name@domain`. The key stays in the signer app.
 */
export function SignerLogin({ onLogin, onBack }: SignerLoginProps) {
  const choice = chooseRelay(
    status.value?.relayUrl,
    globalThis.location.hostname,
  );
  const [custom, setCustom] = useState<string>();
  const [relayInput, setRelayInput] = useState("");
  const [relayError, setRelayError] = useState<string>();
  const [uri, setUri] = useState<string>();
  const [error, setError] = useState<string>();
  const [bunker, setBunker] = useState("");
  const [bunkerBusy, setBunkerBusy] = useState(false);
  const done = useRef(false);
  const bunkerAbort = useRef<AbortController | undefined>(undefined);
  const relay = custom ?? choice.relay;
  const authUrl = signerAuthUrl.value;

  const finish = async (login: () => void) => {
    if (done.current) return;
    done.current = true;
    try {
      login();
      await onLogin();
    } catch (e) {
      done.current = false;
      setError((e as Error).message);
    }
  };

  // One connection attempt per relay; a new relay replaces the link.
  useEffect(() => {
    if (!relay) {
      setUri(undefined);
      return;
    }
    setError(undefined);
    let attempt: PendingConnection | undefined;
    try {
      attempt = startNostrConnect(relay);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setUri(attempt.uri);
    attempt.done.then(
      (data) => finish(() => loginWithRemote(data)),
      (e: Error) => {
        if ((e as { reason?: string }).reason !== "cancelled") {
          setError(e.message);
        }
      },
    );
    return () => attempt?.cancel();
  }, [relay]);

  useEffect(() => () => bunkerAbort.current?.abort(), []);

  const pickRelay = (text: string) => {
    const normalized = normalizeRelayInput(text);
    if (!normalized) {
      setRelayError("That is not a relay address. Use wss://… or ws://…");
      return;
    }
    setRelayError(undefined);
    setCustom(normalized);
  };

  const wide = globalThis.matchMedia?.("(min-width: 640px)").matches ?? false;

  return (
    <div class="login signer">
      <p>
        Your key stays in the signer app. This browser only holds a connection
        key that lets it ask the app to sign.
      </p>

      {!relay && (
        <form
          class="signer__relay"
          onSubmit={(e) => {
            e.preventDefault();
            pickRelay(relayInput);
          }}
        >
          <p class="form-note" role="note">{choice.reason}</p>
          <label class="field">
            <span class="field__label">Relay</span>
            <input
              class="field__input mono"
              type="text"
              inputMode="url"
              autocomplete="off"
              spellcheck={false}
              placeholder={SUGGESTED_RELAY}
              value={relayInput}
              onInput={(e) =>
                setRelayInput((e.target as HTMLInputElement).value)}
            />
          </label>
          <p class="muted">
            Suggestion:{" "}
            <button
              type="button"
              class="link-button"
              onClick={() => {
                setRelayInput(SUGGESTED_RELAY);
                pickRelay(SUGGESTED_RELAY);
              }}
            >
              use <span class="mono">{SUGGESTED_RELAY}</span>
            </button>. Nothing connects to it until you choose it.
          </p>
          {relayError && <p class="form-error" role="alert">{relayError}</p>}
          <div class="row">
            <Button
              variant="primary"
              type="submit"
              disabled={!relayInput.trim()}
            >
              Continue
            </Button>
          </div>
        </form>
      )}

      {relay && uri && (
        <>
          <a class="btn btn--primary btn--lg signer__open" href={uri}>
            <Smartphone size={20} aria-hidden="true" />
            <span class="btn__label">Open signer app</span>
          </a>
          <div class="row signer__actions">
            <Button
              icon={<Copy size={16} />}
              onClick={() => copyText(uri, "Link")}
            >
              Copy link
            </Button>
          </div>
          <p class="signer__wait" role="status">
            <span class="spinner spinner--inline" aria-hidden="true" />
            <span>
              Waiting for your signer app… Approve the connection there.
              {authUrl && (
                <>
                  {" "}
                  <a href={authUrl} target="_blank" rel="noopener noreferrer">
                    Your signer needs you to continue on its page.
                  </a>
                </>
              )}
            </span>
          </p>
          <details class="signer__qr" open={wide}>
            <summary>Signing in from a computer? Scan a QR code</summary>
            <QrCode
              value={uri}
              label="QR code of the nostrconnect link, to scan with a signer app"
            />
            <p class="muted">
              Scan it with the signer app on your phone.
            </p>
          </details>
          <p class="muted signer__relay-line">
            Connecting through the relay{" "}
            <span class="mono">{relay.replace(/^wss?:\/\//, "")}</span>
            {custom === undefined && choice.relay ? " (this node)" : ""}.
          </p>
          <details class="signer__advanced">
            <summary>Advanced: use another relay</summary>
            <form
              class="signer__relay"
              onSubmit={(e) => {
                e.preventDefault();
                pickRelay(relayInput);
              }}
            >
              <label class="field">
                <span class="field__label">Relay</span>
                <input
                  class="field__input mono"
                  type="text"
                  inputMode="url"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={SUGGESTED_RELAY}
                  value={relayInput}
                  onInput={(e) =>
                    setRelayInput((e.target as HTMLInputElement).value)}
                />
              </label>
              {relayError && (
                <p class="form-error" role="alert">{relayError}</p>
              )}
              <div class="row">
                <Button type="submit" disabled={!relayInput.trim()}>
                  Use this relay
                </Button>
              </div>
            </form>
          </details>
        </>
      )}

      <form
        class="signer__bunker"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          setBunkerBusy(true);
          const abort = new AbortController();
          bunkerAbort.current = abort;
          try {
            const data = await connectBunker(bunker, { signal: abort.signal });
            await finish(() => loginWithRemote(data));
          } catch (err) {
            if ((err as { reason?: string }).reason !== "cancelled") {
              setError((err as Error).message);
            }
          } finally {
            setBunkerBusy(false);
          }
        }}
      >
        <label class="field">
          <span class="field__label">Or paste a bunker address</span>
          <input
            class="field__input mono"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="bunker://… or name@domain"
            value={bunker}
            disabled={bunkerBusy}
            onInput={(e) => setBunker((e.target as HTMLInputElement).value)}
          />
        </label>
        <p class="muted">
          This connects your browser to the relay named in the address.
        </p>
        {bunkerBusy && (
          <p class="signer__wait" role="status">
            <span class="spinner spinner--inline" aria-hidden="true" />
            <span>
              Waiting for your signer app… Approve the connection there.
              {authUrl && (
                <>
                  {" "}
                  <a href={authUrl} target="_blank" rel="noopener noreferrer">
                    Your signer needs you to continue on its page.
                  </a>
                </>
              )}
            </span>
          </p>
        )}
        <div class="row">
          {bunkerBusy
            ? (
              <Button
                variant="ghost"
                onClick={() => bunkerAbort.current?.abort()}
              >
                Cancel
              </Button>
            )
            : (
              <Button
                type="submit"
                disabled={!bunker.trim()}
              >
                Connect
              </Button>
            )}
        </div>
      </form>

      {error && <p class="form-error" role="alert">{error}</p>}
      {onBack && (
        <div class="row">
          <Button variant="ghost" onClick={onBack}>Back</Button>
        </div>
      )}
    </div>
  );
}

/** Props of {@link SecretKeyForm}. */
export interface SecretKeyFormProps {
  /** Receives the trimmed nsec or hex key; throw to show an error. */
  onSubmit: (secret: string) => void | Promise<void>;
  submitLabel?: string;
  /** Shows a Back button when given. */
  onBack?: () => void;
}

/** Paste a secret key. It is kept in this browser only; says so. */
export function SecretKeyForm(
  { onSubmit, submitLabel = "Sign in", onBack }: SecretKeyFormProps,
) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <form
      class="login"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        setBusy(true);
        try {
          await onSubmit(input.trim());
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
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
      <p class="muted">
        Kept in this browser's localStorage only, unencrypted. It is never sent
        to the node.
      </p>
      {error && <p class="form-error" role="alert">{error}</p>}
      <div class="row">
        {onBack && <Button variant="ghost" onClick={onBack}>Back</Button>}
        <Button
          variant="primary"
          type="submit"
          disabled={!input.trim()}
          loading={busy}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Props of {@link PublicKeyForm}. */
export interface PublicKeyFormProps {
  /** Receives the npub or hex key; throw to show an error. */
  onSubmit: (npubOrHex: string) => void | Promise<void>;
  submitLabel?: string;
  onBack?: () => void;
}

/** Paste a public key: read-only, nothing can be signed with it. */
export function PublicKeyForm(
  { onSubmit, submitLabel = "Look around", onBack }: PublicKeyFormProps,
) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <form
      class="login"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        setBusy(true);
        try {
          await onSubmit(input.trim());
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
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
        Read-only: the node replicates this person's network, but you cannot
        post as them from this browser.
      </p>
      {error && <p class="form-error" role="alert">{error}</p>}
      <div class="row">
        {onBack && <Button variant="ghost" onClick={onBack}>Back</Button>}
        <Button
          variant="primary"
          type="submit"
          disabled={!input.trim()}
          loading={busy}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Props of {@link SecretKeyReveal}. */
export interface SecretKeyRevealProps {
  nsec: string;
  npub: string;
  /** Called once the person ticks "I have saved it". */
  onContinue: () => void;
  continueLabel?: string;
}

/**
 * Shows a new secret key once, with copy and a confirmation checkbox that must
 * be ticked before continuing.
 */
export function SecretKeyReveal(
  { nsec, npub, onContinue, continueLabel = "Continue" }: SecretKeyRevealProps,
) {
  const [saved, setSaved] = useState(false);
  return (
    <div class="login">
      <p>
        <strong>Save this secret key now.</strong>{" "}
        It is shown only once and cannot be recovered. Whoever has it can post
        as you.
      </p>
      <code class="login__secret" data-testid="nsec">{nsec}</code>
      <div class="row">
        <Button
          icon={<Copy size={16} />}
          onClick={() => copyText(nsec, "Secret key")}
        >
          Copy secret key
        </Button>
      </div>
      <p class="muted">
        Your public identity is <span class="mono">{npub.slice(0, 16)}…</span>
      </p>
      <label class="login__confirm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved((e.target as HTMLInputElement).checked)}
        />
        I have saved my secret key somewhere safe
      </label>
      <Button variant="primary" disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </Button>
    </div>
  );
}

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
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ nsec: string; npub: string }>();

  const finish = () => {
    setStep("choose");
    setError(undefined);
    setCreated(undefined);
    onClose();
    onLogin?.();
  };

  const close = () => {
    // Closing after creating an identity is allowed once the key is saved;
    // the reveal step itself refuses to continue until then.
    if (step === "created") return;
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
          <ExtensionButton onLogin={() => finish()} />
          <button
            type="button"
            class="login__option"
            onClick={() => setStep("signer")}
          >
            <Smartphone size={22} aria-hidden="true" />
            <span>
              <strong>Signer app (Amber and others)</strong>
              <small>Your key stays in the app on your phone.</small>
            </span>
          </button>
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
        <SecretKeyReveal
          nsec={created.nsec}
          npub={created.npub}
          onContinue={finish}
          continueLabel="Continue"
        />
      )}

      {step === "signer" && (
        <SignerLogin
          onBack={() => setStep("choose")}
          onLogin={finish}
        />
      )}

      {step === "key" && (
        <SecretKeyForm
          submitLabel="Sign in"
          onBack={() => setStep("choose")}
          onSubmit={(secret) => {
            loginWithSecretKey(secret);
            finish();
          }}
        />
      )}

      {step === "readonly" && (
        <PublicKeyForm
          submitLabel="Look around"
          onBack={() => setStep("choose")}
          onSubmit={(key) => {
            loginReadOnly(key);
            finish();
          }}
        />
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
