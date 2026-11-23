/**
 * State for the To, Cc and Bcc fields. Valid addresses go straight into the
 * draft (so autosave picks them up); typed text and entries that are not
 * usable addresses stay local until fixed or removed.
 */
import { useCallback, useRef, useState } from "react";
import type { MailAddress } from "../../../../_shared/office-accounts/types/mail";
import { mergeRecipients, parseRecipients, pendingRecipientText, removeRecipient } from "../../compose/recipients";
import type { MailStore } from "../../model";

export type RecipientKind = "to" | "cc" | "bcc";
export const RECIPIENT_KINDS: readonly RecipientKind[] = ["to", "cc", "bcc"];
/** Invalid entries shown per field. */
const MAX_INVALID = 50;

type PerField<T> = Record<RecipientKind, T>;

export interface RecipientsApi {
  text: PerField<string>;
  invalid: PerField<string[]>;
  setText(kind: RecipientKind, text: string): void;
  commit(kind: RecipientKind, text: string, all: boolean): void;
  add(kind: RecipientKind, address: MailAddress): void;
  remove(kind: RecipientKind, address: string): void;
  removeInvalid(kind: RecipientKind, entry: string): void;
  /** Commits every field's typed text now; returns the number of invalid entries left. */
  flush(): number;
}

export function useRecipients(store: MailStore, localId: string): RecipientsApi {
  const [text, setTexts] = useState<PerField<string>>({ to: "", cc: "", bcc: "" });
  const [invalid, setInvalids] = useState<PerField<string[]>>({ to: [], cc: [], bcc: [] });
  const textRef = useRef(text);
  const invalidRef = useRef(invalid);
  textRef.current = text;
  invalidRef.current = invalid;

  const current = useCallback((kind: RecipientKind): MailAddress[] => store.getSnapshot().drafts[localId]?.draft[kind] ?? [], [store, localId]);

  const apply = useCallback((kind: RecipientKind, raw: string, all: boolean) => {
    const { commit, rest } = all ? { commit: raw, rest: "" } : pendingRecipientText(raw);
    const parsed = parseRecipients(commit);
    if (parsed.valid.length) {
      const next = mergeRecipients(current(kind), parsed.valid);
      store.editDraft(localId, { [kind]: next });
    }
    const nextInvalid = [...new Set([...invalidRef.current[kind], ...parsed.invalid])].slice(0, MAX_INVALID);
    invalidRef.current = { ...invalidRef.current, [kind]: nextInvalid };
    textRef.current = { ...textRef.current, [kind]: rest };
    setInvalids(invalidRef.current);
    setTexts(textRef.current);
  }, [current, store, localId]);

  return {
    text,
    invalid,
    setText(kind, value) {
      textRef.current = { ...textRef.current, [kind]: value };
      setTexts(textRef.current);
    },
    commit: apply,
    add(kind, address) {
      store.editDraft(localId, { [kind]: mergeRecipients(current(kind), [address]) });
    },
    remove(kind, address) {
      store.editDraft(localId, { [kind]: removeRecipient(current(kind), address) });
    },
    removeInvalid(kind, entry) {
      invalidRef.current = { ...invalidRef.current, [kind]: invalidRef.current[kind].filter((item) => item !== entry) };
      setInvalids(invalidRef.current);
    },
    flush() {
      for (const kind of RECIPIENT_KINDS) if (textRef.current[kind].trim()) apply(kind, textRef.current[kind], true);
      return RECIPIENT_KINDS.reduce((sum, kind) => sum + invalidRef.current[kind].length, 0);
    },
  };
}
