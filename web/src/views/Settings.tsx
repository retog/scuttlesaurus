/**
 * Settings: the node's configuration for its owner (signed in with the owner's
 * key), and for everybody the appearance and the identity in this browser.
 *
 * @module
 */
import {
  Copy,
  EyeOff,
  KeyRound,
  LogIn,
  LogOut,
  Settings as SettingsIcon,
} from "lucide-preact";
import { useState } from "preact/hooks";
import { AuthorName } from "../components/AuthorName.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { Button } from "../components/Button.tsx";
import { CopyField } from "../components/CopyField.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { copyText } from "../components/LoginDialog.tsx";
import { NodeSettingsForm } from "../components/NodeSettingsForm.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Skeleton } from "../components/Spinner.tsx";
import { getConfig } from "../lib/api.ts";
import { useAsync, useDocumentTitle } from "../lib/hooks.ts";
import {
  canSign as signable,
  logout,
  revealSecretKey,
  session,
} from "../lib/session.ts";
import { isOwner, ownerPubkey } from "../lib/node.ts";
import { displayNameOf, useProfile } from "../lib/profiles.ts";
import { toNpub } from "../lib/nostr.ts";
import { followSystem, setTheme, themeChoice } from "../lib/theme.ts";
import { openLogin } from "../lib/ui.ts";

/** The Settings view. */
export default function SettingsView() {
  useDocumentTitle("Settings");
  return (
    <div class="page settings">
      <PageHeader
        title="Settings"
        subtitle="The node's configuration, and how you appear in this browser."
      />
      <NodeSection />
      <AppearanceSection />
      <IdentitySection />
    </div>
  );
}

/** The node's own settings: a form for the owner, an explanation otherwise. */
function NodeSection() {
  const owner = ownerPubkey.value;
  if (isOwner.value && signable.value) return <OwnerSettings />;

  return (
    <section class="card settings-card" aria-labelledby="settings-node">
      <h2 id="settings-node" class="settings-card__title">Node</h2>
      <p>Only the owner of this node can change its settings.</p>
      {owner
        ? (
          <p class="muted">
            Owner: <AuthorName pubkey={owner} showHops={false} />
          </p>
        )
        : <p class="muted">This node has no owner yet.</p>}
      {session.value && !isOwner.value && (
        <p class="muted">
          You are signed in as{" "}
          <AuthorName pubkey={session.value.pubkey} showHops={false} />, which
          is not the owner.
        </p>
      )}
      {isOwner.value && !signable.value && (
        <p class="muted">
          You are the owner, but this browser holds only your public key. Sign
          in with your key to change the settings.
        </p>
      )}
      {(!session.value || !signable.value) && (
        <div class="row">
          <Button
            variant="secondary"
            icon={<LogIn size={18} />}
            onClick={openLogin}
          >
            Sign in as the owner
          </Button>
        </div>
      )}
    </section>
  );
}

/** Loads the configuration and shows the form, with its own loading state. */
function OwnerSettings() {
  const pubkey = session.value?.pubkey;
  const config = useAsync(() => getConfig(), [pubkey]);

  if (!config.data && config.loading) {
    return (
      <section class="card settings-card" aria-busy="true">
        <Skeleton count={5} />
      </section>
    );
  }
  if (!config.data) {
    return (
      <section class="card settings-card">
        <EmptyState
          title="The settings could not be loaded"
          icon={<SettingsIcon size={36} />}
          tone="error"
          action={
            <Button variant="secondary" onClick={config.reload}>
              Try again
            </Button>
          }
        >
          {config.error?.message ?? "The node did not answer."}
        </EmptyState>
      </section>
    );
  }
  return (
    <section class="card settings-card" aria-labelledby="settings-node">
      <h2 id="settings-node" class="settings-card__title">Node</h2>
      <p class="muted">
        Changes apply at once and are saved in the node's configuration file.
        Settings set by the environment are locked; the node's owner can see
        them here but not change them.
      </p>
      <NodeSettingsForm config={config.data} />
    </section>
  );
}

/** Light, dark, or following the system. */
function AppearanceSection() {
  const choice = themeChoice.value ?? "system";
  const options = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;
  return (
    <section class="card settings-card" aria-labelledby="settings-appearance">
      <h2 id="settings-appearance" class="settings-card__title">Appearance</h2>
      <div class="segmented" role="radiogroup" aria-label="Theme">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            class="segmented__option"
            aria-checked={choice === option.value}
            tabIndex={choice === option.value ? 0 : -1}
            onClick={() => {
              if (option.value === "system") followSystem();
              else setTheme(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p class="muted">
        {choice === "system"
          ? "Follows the light or dark setting of your device."
          : "Stays as you chose it, on this browser."}
      </p>
    </section>
  );
}

/** How you are signed in here, your public key, and signing out. */
function IdentitySection() {
  const current = session.value;
  if (!current) {
    return (
      <section class="card settings-card" aria-labelledby="settings-identity">
        <h2 id="settings-identity" class="settings-card__title">Identity</h2>
        <p>You are not signed in.</p>
        <p class="muted">
          Browsing needs no sign-in. Signing in lets you post, and lets the
          owner change the node's settings.
        </p>
        <div class="row">
          <Button
            variant="primary"
            icon={<LogIn size={18} />}
            onClick={openLogin}
          >
            Sign in
          </Button>
        </div>
      </section>
    );
  }
  return <SignedIn pubkey={current.pubkey} mode={current.mode} />;
}

function SignedIn({ pubkey, mode }: { pubkey: string; mode: string }) {
  const profile = useProfile(pubkey);
  const [nsec, setNsec] = useState<string>();
  const npub = toNpub(pubkey);
  const how = mode === "extension"
    ? "You sign with a browser extension. The key stays in the extension."
    : mode === "local"
    ? "You sign with a key kept in this browser. Anyone with access to this browser can use it."
    : "You are looking around with a public key. You cannot sign or post as this identity.";
  return (
    <section class="card settings-card" aria-labelledby="settings-identity">
      <h2 id="settings-identity" class="settings-card__title">Identity</h2>
      <div class="settings-identity">
        <Avatar pubkey={pubkey} size={48} />
        <div>
          <p class="settings-identity__name">
            {displayNameOf(profile, pubkey)}
          </p>
          <p class="muted">{how}</p>
        </div>
      </div>
      <CopyField
        label="Public key (npub)"
        value={npub}
        hint="Share it so that people can find and follow you."
      />
      {mode === "local" && !nsec && (
        <div class="settings-reveal">
          <p class="muted">
            Your secret key lets anybody post as you. Reveal it only to copy it
            somewhere safe.
          </p>
          <Button
            variant="secondary"
            icon={<KeyRound size={16} />}
            onClick={() => setNsec(revealSecretKey())}
          >
            Reveal secret key
          </Button>
        </div>
      )}
      {nsec && (
        <div class="settings-reveal">
          <p class="form-error" role="note">
            Anyone who sees this key can post as you. Do not share it or paste
            it anywhere else.
          </p>
          <code class="login__secret" data-testid="nsec">{nsec}</code>
          <div class="row">
            <Button
              icon={<Copy size={16} />}
              onClick={() => copyText(nsec, "Secret key")}
            >
              Copy secret key
            </Button>
            <Button
              variant="ghost"
              icon={<EyeOff size={16} />}
              onClick={() =>
                setNsec(undefined)}
            >
              Hide
            </Button>
          </div>
        </div>
      )}
      <div class="row">
        <Button
          variant="secondary"
          icon={<LogOut size={18} />}
          onClick={() =>
            logout()}
        >
          Sign out
        </Button>
      </div>
    </section>
  );
}
