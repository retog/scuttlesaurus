/**
 * The owner's settings form over `GET`/`PUT /api/config`: node identity,
 * social distance, history, and relays. Settings fixed by environment
 * variables are shown disabled. Only changed fields are sent; the server's
 * validation messages are shown next to the field they name.
 *
 * @module
 */
import { Lock, Plus, X } from "lucide-preact";
import { useState } from "preact/hooks";
import {
  ApiError,
  type ConfigPatch,
  type ConfigResponse,
  type NodeSettings,
  putConfig,
  settingOfError,
} from "../lib/api.ts";
import { refreshStatus, status } from "../lib/node.ts";
import { toast } from "./Toast.tsx";
import { Button, IconButton } from "./Button.tsx";
import { hopLabel } from "./HopBadge.tsx";

/** The editable values, as the form holds them: numbers as typed text. */
interface Draft {
  name: string;
  description: string;
  publicUrl: string;
  hops: number;
  maxAuthors: string;
  horizonDays: string[];
  bootstrapRelays: string[];
  maxRelays: string;
  forward: "none" | "owner" | "all";
  allowPrivateRelays: boolean;
  enabled: boolean;
}

/** Field errors by dotted setting path. */
type Errors = Record<string, string>;

const HOP_OPTIONS = [0, 1, 2, 3, 4] as const;

/** What each depth means, in plain words. */
const HOP_TEXT: Record<number, string> = {
  0: "Only you. The node keeps your own events and nobody else's.",
  1: "You and the people you follow.",
  2: "Also the people they follow. A neighbourhood of a few thousand people.",
  3: "Three steps out. Much more to store and to fetch.",
  4: "Four steps out. Large: this needs considerable storage and bandwidth.",
};

const FORWARD_TEXT: Record<Draft["forward"], string> = {
  none: "Keep events published to this node here, and send nothing on.",
  owner: "Send the owner's own events on to their authors' relays.",
  all: "Send every event published here on to its author's relays.",
};

function fromSettings(settings: NodeSettings): Draft {
  const r = settings.replication;
  return {
    name: settings.name,
    description: settings.description,
    publicUrl: settings.publicUrl ?? "",
    hops: r.hops,
    maxAuthors: String(r.maxAuthors),
    horizonDays: r.horizonDays.map(String),
    bootstrapRelays: [...r.bootstrapRelays],
    maxRelays: String(r.maxRelays),
    forward: r.forward,
    allowPrivateRelays: r.allowPrivateRelays,
    enabled: r.enabled,
  };
}

const WHOLE = /^\d+$/;

function isRelayUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

/** Checks the documented ranges; returns the errors by setting path. */
function validate(draft: Draft): Errors {
  const errors: Errors = {};
  if (!draft.name.trim()) errors.name = "Give the node a name.";
  if (draft.publicUrl.trim()) {
    try {
      const url = new URL(draft.publicUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.publicUrl = "Use an http:// or https:// address.";
      }
    } catch {
      errors.publicUrl =
        "Use an absolute address such as https://saurus.example.org.";
    }
  }
  const authors = Number(draft.maxAuthors);
  if (!WHOLE.test(draft.maxAuthors) || authors < 1 || authors > 100000) {
    errors["replication.maxAuthors"] = "A whole number from 1 to 100,000.";
  }
  if (
    draft.horizonDays.some((d) => !WHOLE.test(d.trim())) ||
    draft.horizonDays.length === 0
  ) {
    errors["replication.horizonDays"] =
      "Whole numbers of days, zero or more. 0 means all history.";
  }
  const relays = Number(draft.maxRelays);
  if (!WHOLE.test(draft.maxRelays) || relays < 1 || relays > 100) {
    errors["replication.maxRelays"] = "A whole number from 1 to 100.";
  }
  if (!draft.bootstrapRelays.every(isRelayUrl)) {
    errors["replication.bootstrapRelays"] =
      "Every relay must be a ws:// or wss:// address.";
  }
  return errors;
}

/** The patch with only the settings that differ from the saved ones. */
function patchFor(saved: Draft, draft: Draft): ConfigPatch {
  const patch: ConfigPatch = {};
  if (draft.name !== saved.name) patch.name = draft.name.trim();
  if (draft.description !== saved.description) {
    patch.description = draft.description;
  }
  if (draft.publicUrl.trim() !== saved.publicUrl.trim()) {
    patch.publicUrl = draft.publicUrl.trim();
  }
  const replication: NonNullable<ConfigPatch["replication"]> = {};
  if (draft.hops !== saved.hops) replication.hops = draft.hops;
  if (draft.maxAuthors !== saved.maxAuthors) {
    replication.maxAuthors = Number(draft.maxAuthors);
  }
  if (draft.horizonDays.join() !== saved.horizonDays.join()) {
    replication.horizonDays = draft.horizonDays.map(Number);
  }
  if (draft.bootstrapRelays.join() !== saved.bootstrapRelays.join()) {
    replication.bootstrapRelays = draft.bootstrapRelays.map((r) => r.trim());
  }
  if (draft.maxRelays !== saved.maxRelays) {
    replication.maxRelays = Number(draft.maxRelays);
  }
  if (draft.forward !== saved.forward) replication.forward = draft.forward;
  if (draft.allowPrivateRelays !== saved.allowPrivateRelays) {
    replication.allowPrivateRelays = draft.allowPrivateRelays;
  }
  if (draft.enabled !== saved.enabled) replication.enabled = draft.enabled;
  if (Object.keys(replication).length > 0) patch.replication = replication;
  return patch;
}

/** Props of {@link NodeSettingsForm}. */
export interface NodeSettingsFormProps {
  /** The configuration as the server last sent it. */
  config: ConfigResponse;
  /** Called with the server's answer after a successful save. */
  onSaved?: (config: ConfigResponse) => void;
}

/** The form itself. Remount it (a new `key`) when the saved config changes. */
export function NodeSettingsForm({ config, onSaved }: NodeSettingsFormProps) {
  const locked = new Set(config.locked);
  const isLocked = (path: string) => locked.has(path);
  const [saved, setSaved] = useState<Draft>(() =>
    fromSettings(config.settings)
  );
  const [draft, setDraft] = useState<Draft>(saved);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const current = status.value;
  const authorsWithin = (depth: number) =>
    (current?.authorsByHop ?? []).slice(0, depth + 1).reduce(
      (n, c) => n + c,
      0,
    );

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async () => {
    const found = validate(draft);
    setErrors(found);
    setFailure(undefined);
    if (Object.keys(found).length > 0) {
      document.getElementById(`field-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    const patch = patchFor(saved, draft);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const answer = await putConfig(patch);
      const next = fromSettings(answer.settings);
      setSaved(next);
      setDraft(next);
      onSaved?.(answer);
      toast("Settings saved", "success");
      void refreshStatus();
    } catch (error) {
      const key = settingOfError(error);
      const message = (error as Error).message;
      if (key) {
        setErrors({
          [key]: message.replace(/^Invalid setting [\w.]+ .*?: /, ""),
        });
        document.getElementById(`field-${key}`)?.focus();
      } else if (error instanceof ApiError && error.status === 401) {
        setFailure("Sign in with your key to save changes.");
      } else if (error instanceof ApiError && error.status === 403) {
        setFailure("Only the owner of this node can change its settings.");
      } else {
        setFailure(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const lockedNote = (path: string) =>
    isLocked(path)
      ? (
        <span class="settings-lock">
          <Lock size={13} aria-hidden="true" /> set by the environment
        </span>
      )
      : null;

  const fieldError = (path: string) =>
    errors[path]
      ? (
        <p class="form-error" role="alert" id={`error-${path}`}>
          {errors[path]}
        </p>
      )
      : null;

  return (
    <form
      class="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-label="Node settings"
    >
      <fieldset class="settings-section">
        <legend class="settings-section__title">Node</legend>
        <p class="muted">How the node introduces itself to others.</p>
        <label class="field">
          <span class="field__label">
            Name {lockedNote("name")}
          </span>
          <input
            id="field-name"
            class="field__input"
            type="text"
            maxLength={80}
            value={draft.name}
            disabled={isLocked("name")}
            aria-invalid={errors.name ? "true" : undefined}
            aria-describedby={errors.name ? "error-name" : undefined}
            onInput={(e) => set("name", (e.target as HTMLInputElement).value)}
          />
          {fieldError("name")}
        </label>
        <label class="field">
          <span class="field__label">
            Description {lockedNote("description")}
          </span>
          <textarea
            id="field-description"
            class="field__input"
            rows={2}
            maxLength={500}
            value={draft.description}
            disabled={isLocked("description")}
            onInput={(e) =>
              set("description", (e.target as HTMLTextAreaElement).value)}
          />
        </label>
        <label class="field">
          <span class="field__label">
            Public address {lockedNote("publicUrl")}
          </span>
          <input
            id="field-publicUrl"
            class="field__input mono"
            type="url"
            placeholder="Taken from the address you use"
            value={draft.publicUrl}
            disabled={isLocked("publicUrl")}
            aria-invalid={errors.publicUrl ? "true" : undefined}
            aria-describedby={errors.publicUrl ? "error-publicUrl" : undefined}
            onInput={(e) =>
              set("publicUrl", (e.target as HTMLInputElement).value)}
          />
          <small class="muted">
            Where other people reach this node, e.g. behind a reverse proxy.
            Leave empty to use the address in the browser.
          </small>
          {fieldError("publicUrl")}
        </label>
      </fieldset>

      <fieldset class="settings-section">
        <legend class="settings-section__title">Social distance</legend>
        <p class="muted">
          How far from you the node reaches. Everybody within that many follow
          steps has their events kept here.
        </p>
        <div
          class="hop-options"
          role="radiogroup"
          aria-label="Replication depth"
          aria-disabled={isLocked("replication.hops") || undefined}
        >
          {HOP_OPTIONS.map((hops) => (
            <button
              key={hops}
              type="button"
              role="radio"
              id={hops === draft.hops ? "field-replication.hops" : undefined}
              class="hop-option"
              aria-checked={hops === draft.hops}
              tabIndex={hops === draft.hops ? 0 : -1}
              disabled={isLocked("replication.hops")}
              onClick={() => set("hops", hops)}
            >
              <span class="hop-option__title">
                {hops} {hops === 1 ? "hop" : "hops"}
              </span>
              <span class="hop-option__text">{HOP_TEXT[hops]}</span>
              {hops <= (current?.hops ?? hops) && (
                <span class="hop-option__count muted">
                  {authorsWithin(hops).toLocaleString()} authors now
                </span>
              )}
            </button>
          ))}
        </div>
        {lockedNote("replication.hops")}
        {fieldError("replication.hops")}
        <label class="field">
          <span class="field__label">
            Authors at most {lockedNote("replication.maxAuthors")}
          </span>
          <input
            id="field-replication.maxAuthors"
            class="field__input"
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            value={draft.maxAuthors}
            disabled={isLocked("replication.maxAuthors")}
            aria-invalid={errors["replication.maxAuthors"] ? "true" : undefined}
            onInput={(e) =>
              set("maxAuthors", (e.target as HTMLInputElement).value)}
          />
          <small class="muted">
            When the network is larger, the people followed by the most authors
            nearer you are kept first.
          </small>
          {fieldError("replication.maxAuthors")}
        </label>
      </fieldset>

      <fieldset class="settings-section">
        <legend class="settings-section__title">History</legend>
        <p class="muted">
          How many days of past events to fetch for each distance. 0 means all
          of them. Further distances use the last value.
        </p>
        {draft.horizonDays.map((days, index) => {
          const path = `replication.horizonDays`;
          const label = index === 0
            ? "You"
            : index === 1
            ? "People you follow"
            : `${hopLabel(index)}${
              index === draft.horizonDays.length - 1 ? " and further" : ""
            }`;
          return (
            <label class="field field--inline" key={index}>
              <span class="field__label">{label}</span>
              <span class="row">
                <input
                  id={index === 0 ? `field-${path}` : undefined}
                  class="field__input settings-days"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={days}
                  disabled={isLocked(path)}
                  aria-label={`Days of history: ${label}`}
                  onInput={(e) => {
                    const next = [...draft.horizonDays];
                    next[index] = (e.target as HTMLInputElement).value;
                    set("horizonDays", next);
                  }}
                />
                <span class="muted">days</span>
              </span>
            </label>
          );
        })}
        {lockedNote("replication.horizonDays")}
        {fieldError("replication.horizonDays")}
      </fieldset>

      <fieldset class="settings-section">
        <legend class="settings-section__title">Relays</legend>
        <label class="settings-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={isLocked("replication.enabled")}
            onChange={(e) =>
              set("enabled", (e.target as HTMLInputElement).checked)}
          />
          <span>
            <strong>Fetch from other relays</strong>
            <small class="muted">
              Off: the node fetches nothing from other relays.
            </small>
          </span>
          {lockedNote("replication.enabled")}
        </label>

        <div class="settings-list">
          <span class="field__label">
            Bootstrap relays {lockedNote("replication.bootstrapRelays")}
          </span>
          <p class="muted">
            Used to find everybody's profile and relay list, and as fallback.
          </p>
          {draft.bootstrapRelays.length === 0 && (
            <p class="form-error">
              With no bootstrap relays the node cannot discover the network.
            </p>
          )}
          {draft.bootstrapRelays.map((relay, index) => (
            <div class="settings-list__row" key={index}>
              <input
                id={index === 0
                  ? "field-replication.bootstrapRelays"
                  : undefined}
                class="field__input mono"
                type="text"
                inputMode="url"
                spellcheck={false}
                placeholder="wss://relay.example.com/"
                aria-label={`Bootstrap relay ${index + 1}`}
                value={relay}
                disabled={isLocked("replication.bootstrapRelays")}
                onInput={(e) => {
                  const next = [...draft.bootstrapRelays];
                  next[index] = (e.target as HTMLInputElement).value;
                  set("bootstrapRelays", next);
                }}
              />
              {!isLocked("replication.bootstrapRelays") && (
                <IconButton
                  label="Remove relay"
                  icon={<X size={18} />}
                  onClick={() =>
                    set(
                      "bootstrapRelays",
                      draft.bootstrapRelays.filter((_, i) => i !== index),
                    )}
                />
              )}
            </div>
          ))}
          {!isLocked("replication.bootstrapRelays") && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus size={15} />}
                onClick={() =>
                  set("bootstrapRelays", [...draft.bootstrapRelays, "wss://"])}
              >
                Add relay
              </Button>
            </div>
          )}
          {fieldError("replication.bootstrapRelays")}
        </div>

        <label class="field">
          <span class="field__label">
            Relays in use at most {lockedNote("replication.maxRelays")}
          </span>
          <input
            id="field-replication.maxRelays"
            class="field__input"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={draft.maxRelays}
            disabled={isLocked("replication.maxRelays")}
            onInput={(e) =>
              set("maxRelays", (e.target as HTMLInputElement).value)}
          />
          {fieldError("replication.maxRelays")}
        </label>

        <fieldset class="settings-radios">
          <legend class="field__label">
            Forwarding {lockedNote("replication.forward")}
          </legend>
          {(["none", "owner", "all"] as const).map((value) => (
            <label class="settings-radio" key={value}>
              <input
                type="radio"
                name="forward"
                value={value}
                checked={draft.forward === value}
                disabled={isLocked("replication.forward")}
                onChange={() =>
                  set("forward", value)}
              />
              <span>
                <strong>
                  {value === "none"
                    ? "Nothing"
                    : value === "owner"
                    ? "The owner's events"
                    : "Every event"}
                </strong>
                <small class="muted">{FORWARD_TEXT[value]}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <label class="settings-toggle">
          <input
            type="checkbox"
            checked={draft.allowPrivateRelays}
            disabled={isLocked("replication.allowPrivateRelays")}
            onChange={(e) =>
              set("allowPrivateRelays", (e.target as HTMLInputElement).checked)}
          />
          <span>
            <strong>Allow private relays</strong>
            <small class="muted">
              Relays that other people name may then sit on private, loopback or
              unencrypted addresses. A followed person could make this node
              connect inside your network. Leave it off unless you need it.
            </small>
          </span>
          {lockedNote("replication.allowPrivateRelays")}
        </label>
      </fieldset>

      {failure && <p class="form-error" role="alert">{failure}</p>}

      <div class="settings-actions">
        <Button
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(saved);
            setErrors({});
            setFailure(undefined);
          }}
        >
          Discard changes
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={!dirty}
          loading={saving}
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}
