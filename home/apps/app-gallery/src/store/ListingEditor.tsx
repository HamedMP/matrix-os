import React, { useState } from "react";
import { APP_STORE_CATEGORIES } from "../store-model";
import {
  AppStoreListingDraftSchema,
  type AppStoreListingDraft,
} from "../generated-store-gateway";
export default function ListingEditor({
  listing,
  disabled,
  onDirty,
  onSave,
}: {
  listing: AppStoreListingDraft;
  disabled: boolean;
  onDirty: () => void;
  onSave: (value: AppStoreListingDraft) => Promise<void>;
}) {
  // Keep unsaved input for this draft revision; the parent keys a revised server result explicitly.
  const [value, setValue] = useState(listing),
    [invalid, setInvalid] = useState(false);
  const update = (key: keyof AppStoreListingDraft, text: string) => {
    setValue((current) => ({ ...current, [key]: text }));
    setInvalid(false);
    onDirty();
  };
  return (
    <form
      className="store-listing-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = AppStoreListingDraftSchema.safeParse(value);
        if (!parsed.success) {
          setInvalid(true);
          return;
        }
        void onSave(parsed.data);
      }}
    >
      <h4>Listing preview and details</h4>
      <div className="store-card">
        <strong>{value.name}</strong>
        <p>{value.tagline}</p>
        <p>{value.description}</p>
        <small>
          {value.category} · {value.version}
        </small>
      </div>
      {(
        [
          ["name", "App name", 60],
          ["slug", "Store address", 48],
          ["tagline", "Tagline", 100],
          ["version", "Version", 20],
        ] as const
      ).map(([key, label, max]) => (
        <label key={key}>
          {label}
          <input
            disabled={disabled}
            value={value[key]}
            maxLength={max}
            required
            onChange={(event) => update(key, event.target.value)}
          />
        </label>
      ))}
      <label>
        Description
        <textarea
          required
          disabled={disabled}
          value={value.description}
          maxLength={2000}
          onChange={(event) => update("description", event.target.value)}
        />
      </label>
      <label>
        Category
        <select
          disabled={disabled}
          value={value.category}
          onChange={(event) => update("category", event.target.value)}
        >
          {APP_STORE_CATEGORIES.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label>
        Changelog
        <textarea
          disabled={disabled}
          value={value.changelog}
          maxLength={2000}
          onChange={(event) => update("changelog", event.target.value)}
        />
      </label>
      {invalid && (
        <p role="alert">
          Check the listing fields. Use a store address of 3–48 lowercase
          letters, numbers or hyphens and a version such as 1.0.0.
        </p>
      )}
      <button type="submit" disabled={disabled}>
        Save listing
      </button>
    </form>
  );
}
