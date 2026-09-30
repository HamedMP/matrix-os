export function JevLabelPermission({ enabled, disabled, onChange }: {
  enabled: boolean; disabled: boolean; onChange(value: boolean): void;
}) {
  return <label className="grid gap-2 text-xs leading-5">
    <span className="flex items-start gap-2"><input type="checkbox" aria-label="Allow this bot to add Jev labels to the selected Gmail account" checked={enabled} disabled={disabled}
      onChange={event => onChange(event.currentTarget.checked)} />
      Allow this bot to add Jev labels to the selected Gmail account</span>
    <span>When enabled, runs add verified category labels and check them in Gmail. Existing labels stay intact. No archiving, sending or deleting. Leave off for preview only.</span>
  </label>;
}
