/**
 * The first-run setup of a node without an owner: the one screen shown in
 * place of the app (see `Shell`). The person chooses an identity, which
 * becomes the owner; a new identity also gets a profile, an empty follow list
 * and a relay list pointing at this node.
 *
 * The key handling is the same as in the sign-in dialog; see `LoginDialog.tsx`.
 *
 * @module
 */
import type { Event, EventTemplate } from "@nostr/tools/core";
import { signal } from "@preact/signals";
import { ArrowRight, Users } from "lucide-preact";
import { useState } from "preact/hooks";
import { ApiError, type NodeStatus, setup } from "../lib/api.ts";
import { refreshStatus, status } from "../lib/node.ts";
import { toNpub } from "../lib/nostr.ts";
import { Link, navigate } from "../lib/router.tsx";
import { useDocumentTitle } from "../lib/hooks.ts";
import {
  createIdentity,
  loginReadOnly,
  loginWithSecretKey,
  logout,
  publish,
  session,
} from "../lib/session.ts";
import { Button } from "./Button.tsx";
import {
  ExtensionButton,
  PublicKeyForm,
  SecretKeyForm,
  SecretKeyReveal,
} from "./LoginDialog.tsx";
import { Logo } from "./Logo.tsx";

/**
 * True once the owner is set and the closing step is showing. The shell keeps
 * the setup screen up until the person chooses to enter the app.
 */
export const setupFinished = signal(false);

type Path = "start" | "have" | "nsec" | "npub" | "new" | "reveal" | "done";

/** How many times a publish is retried: the node's graph updates after setup. */
const PUBLISH_ATTEMPTS = 6;
const PUBLISH_DELAY_MS = 1500;

/** Publish with retries while the node's social graph catches up. */
async function publishWithRetry(template: EventTemplate): Promise<Event> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      return await publish(template);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_DELAY_MS));
    }
  }
  throw lastError;
}

/** The first-run setup screen. */
export function SetupFlow() {
  useDocumentTitle("Set up");
  const [path, setPath] = useState<Path>("start");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ nsec: string; npub: string }>();
  const [publishProblem, setPublishProblem] = useState<string>();

  /**
   * Make `pubkey` the owner. On failure the identity is forgotten again, so
   * that a refused setup leaves nothing stored in this browser.
   */
  const claim = async (pubkey: string, profileName?: string) => {
    setError(undefined);
    setBusy(true);
    let answer: NodeStatus;
    try {
      answer = await setup(pubkey);
    } catch (e) {
      logout();
      setBusy(false);
      if (e instanceof ApiError && e.status === 409) {
        setError(
          "Someone else set this node up a moment ago. Reloading the node…",
        );
        await refreshStatus();
      } else {
        setError((e as Error).message);
      }
      throw e;
    }
    status.value = answer;
    setupFinished.value = true;
    if (profileName !== undefined) {
      await publishIdentity(profileName, answer.relayUrl);
    }
    setBusy(false);
    setPath("done");
  };

  const publishIdentity = async (profileName: string, relayUrl: string) => {
    try {
      await publishWithRetry({
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        content: JSON.stringify({
          name: profileName,
          display_name: profileName,
        }),
        tags: [],
      });
      await publishWithRetry({
        kind: 3,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [],
      });
      await publishWithRetry({
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [["r", relayUrl]],
      });
    } catch (error) {
      setPublishProblem(
        `Your profile could not be published yet: ${
          (error as Error).message
        }. Publish it from a Nostr client; your identity is still the owner.`,
      );
    }
  };

  const currentPubkey = session.value?.pubkey;

  return (
    <main class="setup" id="main" tabIndex={-1}>
      <div class="setup__card">
        <header class="setup__brand">
          <Logo size={52} word={false} />
          <h1 class="setup__title">Scuttlesaurus</h1>
        </header>

        {path === "start" && (
          <section class="setup__step" aria-labelledby="setup-start">
            <h2 id="setup-start" class="setup__heading">
              Set up your node
            </h2>
            <p class="setup__lead">
              This node will keep what the people near you write.
            </p>
            <div class="login">
              <button
                type="button"
                class="login__option"
                onClick={() =>
                  setPath("have")}
              >
                <Users size={22} aria-hidden="true" />
                <span>
                  <strong>I have a Nostr identity</strong>
                  <small>Sign in with the key you already use.</small>
                </span>
              </button>
              <button
                type="button"
                class="login__option"
                onClick={() =>
                  setPath("new")}
              >
                <ArrowRight size={22} aria-hidden="true" />
                <span>
                  <strong>I am new to Nostr</strong>
                  <small>Create an identity for this node's owner.</small>
                </span>
              </button>
            </div>
            <p class="setup__note muted">
              Operators can also set the owner in advance with the{" "}
              <span class="mono">OWNER</span>{" "}
              environment variable (an npub or hex key). Then this screen does
              not appear.
            </p>
          </section>
        )}

        {path === "have" && (
          <section class="setup__step" aria-labelledby="setup-have">
            <h2 id="setup-have" class="setup__heading">
              Which identity is the owner?
            </h2>
            <div class="login">
              <ExtensionButton
                busy={busy}
                onLogin={async () => {
                  const pubkey = session.value?.pubkey;
                  if (pubkey) {
                    await claim(pubkey);
                  }
                }}
              />
              <button
                type="button"
                class="login__option"
                onClick={() =>
                  setPath("nsec")}
              >
                <span>
                  <strong>Paste a secret key</strong>
                  <small>
                    Kept in this browser only. You can post as the owner.
                  </small>
                </span>
              </button>
              <button
                type="button"
                class="login__option"
                onClick={() =>
                  setPath("npub")}
              >
                <span>
                  <strong>Paste a public key</strong>
                  <small>
                    Read-only. The node replicates your network, but you cannot
                    post from this browser.
                  </small>
                </span>
              </button>
            </div>
            {error && <p class="form-error" role="alert">{error}</p>}
            <div class="row">
              <Button variant="ghost" onClick={() => setPath("start")}>
                Back
              </Button>
            </div>
          </section>
        )}

        {path === "nsec" && (
          <section class="setup__step" aria-labelledby="setup-nsec">
            <h2 id="setup-nsec" class="setup__heading">
              Paste your secret key
            </h2>
            <SecretKeyForm
              submitLabel="Make me the owner"
              onBack={() =>
                setPath("have")}
              onSubmit={async (secret) => {
                loginWithSecretKey(secret);
                await claim(session.value!.pubkey);
              }}
            />
          </section>
        )}

        {path === "npub" && (
          <section class="setup__step" aria-labelledby="setup-npub">
            <h2 id="setup-npub" class="setup__heading">
              Paste your public key
            </h2>
            <PublicKeyForm
              submitLabel="Make me the owner"
              onBack={() =>
                setPath("have")}
              onSubmit={async (key) => {
                loginReadOnly(key);
                await claim(session.value!.pubkey);
              }}
            />
          </section>
        )}

        {path === "new" && (
          <section class="setup__step" aria-labelledby="setup-new">
            <h2 id="setup-new" class="setup__heading">
              Create your identity
            </h2>
            <form
              class="login"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) {
                  return;
                }
                const key = createIdentity();
                setCreated(key);
                setPath("reveal");
              }}
            >
              <label class="field">
                <span class="field__label">Display name</span>
                <input
                  class="field__input"
                  type="text"
                  autocomplete="nickname"
                  maxLength={80}
                  value={name}
                  onInput={(e) =>
                    setName((e.target as HTMLInputElement).value)}
                />
              </label>
              <p class="muted">
                Your key is created in this browser. Next you will see the
                secret key once, so you can save it.
              </p>
              <div class="row">
                <Button
                  variant="ghost"
                  onClick={() =>
                    setPath("start")}
                >
                  Back
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={!name.trim()}
                >
                  Create identity
                </Button>
              </div>
            </form>
          </section>
        )}

        {path === "reveal" && created && (
          <section class="setup__step" aria-labelledby="setup-reveal">
            <h2 id="setup-reveal" class="setup__heading">
              Save your secret key
            </h2>
            <SecretKeyReveal
              nsec={created.nsec}
              npub={created.npub}
              continueLabel={busy ? "Setting up…" : "Make me the owner"}
              onContinue={() => {
                const pubkey = session.value?.pubkey;
                if (!pubkey) {
                  return;
                }
                claim(pubkey, name.trim()).catch(() => {});
              }}
            />
            {error && <p class="form-error" role="alert">{error}</p>}
          </section>
        )}

        {path === "done" && (
          <section class="setup__step" aria-labelledby="setup-done">
            <h2 id="setup-done" class="setup__heading">
              You are the owner
            </h2>
            <p>
              This node now replicates your neighbourhood: your profile, the
              people you follow and the people they follow. On a fresh node this
              takes a while; the Network page shows its progress.
            </p>
            <div class="setup__next">
              <h3 class="setup__subheading">Find people</h3>
              <p class="muted">
                Following nobody yet? Look people up by name or npub in{" "}
                <Link to="/search">Search</Link>, and follow the ones you know.
              </p>
            </div>
            {publishProblem && (
              <p class="form-error" role="alert">{publishProblem}</p>
            )}
            {currentPubkey && (
              <p class="muted">
                Owner:{" "}
                <span class="mono">{toNpub(currentPubkey).slice(0, 16)}…</span>
              </p>
            )}
            <Button
              variant="primary"
              size="lg"
              icon={<ArrowRight size={18} />}
              onClick={() => {
                setupFinished.value = false;
                navigate("/");
              }}
            >
              Open Scuttlesaurus
            </Button>
          </section>
        )}
      </div>
    </main>
  );
}
