/**
 * Edits the signature of the draft's account and inserts it into the body.
 * Signatures are stored per account in the app's key-value store.
 */
import { useRef, useState } from "react";
import { Signature } from "lucide-react";
import { Popover, TextField } from "../../../../_shared/office-ui";
import { MAX_SIGNATURE_CHARS, type SignatureStore } from "../../compose/signature";

export interface SignatureButtonProps {
  accountId: string;
  signatures: SignatureStore;
  onInsert(text: string): void;
}

export function SignatureButton({ accountId, signatures, onInsert }: SignatureButtonProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (insert: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await signatures.save(accountId, text);
      if (insert && text.trim()) onInsert(text);
      setOpen(false);
    } catch (failure: unknown) {
      console.warn(`[mail] signature.save.failed (${failure instanceof Error ? failure.name : typeof failure})`);
      setError("The signature could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="oui-button oui-button--ghost mail-compose__signature-button"
        aria-expanded={open}
        onClick={() => {
          setText(signatures.get(accountId));
          setError(null);
          setOpen((value) => !value);
        }}
      >
        <Signature size={14} aria-hidden="true" /> Signature
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Signature" placement="top-start">
        <div className="mail-compose__popover-form">
          <TextField
            label="Signature for this account"
            multiline
            rows={4}
            value={text}
            onChange={setText}
            maxLength={MAX_SIGNATURE_CHARS}
            hint="Added below new messages from this account."
          />
          {error && <p className="mail-compose__error" role="alert">{error}</p>}
          <div className="mail-compose__popover-actions">
            <button type="button" className="oui-button" disabled={saving} onClick={() => void save(false)}>Save</button>
            <button type="button" className="oui-button oui-button--primary" disabled={saving || !text.trim()} onClick={() => void save(true)}>Save and insert</button>
          </div>
        </div>
      </Popover>
    </>
  );
}
