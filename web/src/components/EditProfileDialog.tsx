/**
 * The dialog to edit the signed-in person's profile. Only the fields the
 * person changed are sent: {@link saveProfile} merges them into the current
 * kind 0 and keeps everything else. Pictures and banners can be uploaded,
 * pasted as a link, or removed.
 *
 * @module
 */
import { ImagePlus, Trash2 } from "lucide-preact";
import { useRef, useState } from "preact/hooks";
import { explainRefusal } from "../lib/actions.ts";
import { uploadBlob } from "../lib/blossom.ts";
import {
  profileFromContent,
  type ProfileKey,
  saveProfile,
} from "../lib/people.ts";
import { type Profile, seedProfile } from "../lib/profiles.ts";
import { session } from "../lib/session.ts";
import { Button } from "./Button.tsx";
import { gradientFor } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";
import { toast } from "./Toast.tsx";

/** Props of {@link EditProfileDialog}. */
export interface EditProfileDialogProps {
  open: boolean;
  onClose: () => void;
  /** The profile as it is now; the form starts from it. */
  profile: Profile;
}

type Form = Record<ProfileKey, string>;

function formOf(profile: Profile): Form {
  return {
    name: profile.name ?? "",
    display_name: profile.displayName ?? "",
    about: profile.about ?? "",
    website: profile.website ?? "",
    nip05: profile.nip05 ?? "",
    picture: profile.picture ?? "",
    banner: profile.banner ?? "",
  };
}

/** Whether `value` is an absolute http or https URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** The problem with a field value, or `undefined` when it is acceptable. */
function problemOf(key: ProfileKey, value: string): string | undefined {
  if (!value) return undefined;
  if (key === "website" || key === "picture" || key === "banner") {
    return isHttpUrl(value)
      ? undefined
      : "Use a full link starting with https://";
  }
  if (key === "nip05" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Use the form name@domain.example";
  }
  return undefined;
}

/** A picture or banner: preview, a link field, upload and remove. */
function ImageField(
  { label, kind, value, pubkey, onChange }: {
    label: string;
    kind: "picture" | "banner";
    value: string;
    pubkey: string;
    onChange: (next: string) => void;
  },
) {
  const [uploading, setUploading] = useState(false);
  const [broken, setBroken] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const shown = value && !broken;
  const upload = async (picked: File) => {
    setUploading(true);
    try {
      const blob = await uploadBlob(picked);
      setBroken(false);
      onChange(blob.url);
    } catch (error) {
      toast(explainRefusal(error), "error");
    } finally {
      setUploading(false);
    }
  };
  return (
    <div class={`image-field image-field--${kind}`}>
      <div
        class="image-field__preview"
        style={!shown ? { background: gradientFor(pubkey) } : undefined}
      >
        {shown && (
          <img
            src={value}
            alt=""
            decoding="async"
            onError={() => setBroken(true)}
          />
        )}
      </div>
      <div class="image-field__controls">
        <label class="field">
          <span class="field__label">{label}</span>
          <input
            class="field__input"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={value}
            onInput={(e) => {
              setBroken(false);
              onChange((e.target as HTMLInputElement).value.trim());
            }}
          />
        </label>
        <div class="row image-field__buttons">
          <input
            ref={file}
            class="visually-hidden"
            type="file"
            accept="image/*"
            tabIndex={-1}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const picked = input.files?.[0];
              input.value = "";
              if (picked) void upload(picked);
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<ImagePlus size={16} />}
            loading={uploading}
            onClick={() => file.current?.click()}
          >
            Upload
          </Button>
          {value && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={16} />}
              onClick={() => onChange("")}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The form itself; mounted when the dialog opens, so it starts fresh. */
function EditForm({ profile, onClose }: {
  profile: Profile;
  onClose: () => void;
}) {
  const initial = formOf(profile);
  const [form, setForm] = useState<Form>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const me = session.value?.pubkey ?? profile.pubkey;
  const set = (key: ProfileKey) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(undefined);
  };
  // Only what the person changed is checked: an old, odd value elsewhere in
  // the profile must not block saving the rest.
  const problems = (Object.keys(form) as ProfileKey[]).flatMap((key) => {
    if (form[key].trim() === initial[key].trim()) return [];
    const problem = problemOf(key, form[key].trim());
    return problem ? [[key, problem] as const] : [];
  });
  const problemFor = (key: ProfileKey) =>
    problems.find(([k]) => k === key)?.[1];

  const save = async () => {
    if (problems.length > 0 || saving) return;
    const changes: Partial<Record<ProfileKey, string>> = {};
    for (const key of Object.keys(form) as ProfileKey[]) {
      const next = form[key].trim();
      if (next !== initial[key].trim()) changes[key] = next;
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const content = await saveProfile(changes);
      seedProfile(profileFromContent(me, content));
      toast("Profile saved", "success");
      onClose();
    } catch (reason) {
      setError(explainRefusal(reason));
    } finally {
      setSaving(false);
    }
  };

  const text = (key: ProfileKey, label: string, multiline = false) => (
    <label class="field">
      <span class="field__label">{label}</span>
      {multiline
        ? (
          <textarea
            class="field__input edit-profile__about"
            rows={4}
            value={form[key]}
            onInput={(e) => set(key)((e.target as HTMLTextAreaElement).value)}
          />
        )
        : (
          <input
            class="field__input"
            type="text"
            value={form[key]}
            aria-invalid={problemFor(key) ? true : undefined}
            onInput={(e) => set(key)((e.target as HTMLInputElement).value)}
          />
        )}
      {problemFor(key) && <span class="form-error">{problemFor(key)}</span>}
    </label>
  );

  return (
    <form
      class="edit-profile"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ImageField
        label="Picture"
        kind="picture"
        value={form.picture}
        pubkey={me}
        onChange={set("picture")}
      />
      <ImageField
        label="Banner"
        kind="banner"
        value={form.banner}
        pubkey={me}
        onChange={set("banner")}
      />
      {text("display_name", "Display name")}
      {text("name", "Name (handle)")}
      {text("about", "About", true)}
      {text("website", "Website")}
      {text("nip05", "NIP-05 identifier")}
      {error && <p class="form-error" role="alert">{error}</p>}
      <div class="edit-profile__actions">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={saving}
          disabled={problems.length > 0}
        >
          Save profile
        </Button>
      </div>
    </form>
  );
}

/** Modal with the profile form; see the module comment. */
export function EditProfileDialog(
  { open, onClose, profile }: EditProfileDialogProps,
) {
  return (
    <Modal open={open} onClose={onClose} title="Edit profile">
      {open && <EditForm profile={profile} onClose={onClose} />}
    </Modal>
  );
}
