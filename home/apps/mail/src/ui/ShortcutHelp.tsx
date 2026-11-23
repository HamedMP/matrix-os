/**
 * The keyboard shortcut sheet, built from the store's key map so it can never
 * drift from what the keys actually do.
 */
import { Dialog, KeyHint } from "../../../_shared/office-ui";
import { MAIL_KEY_BINDINGS, type MailKeyBinding } from "../model";

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ArrowDown: "↓",
  ArrowUp: "↑",
  Escape: "Esc",
  Enter: "Enter",
});

function keyName(key: string): string[] {
  if (KEY_NAMES[key]) return [KEY_NAMES[key]];
  if (/^[A-Z]$/.test(key)) return ["Shift", key];
  return [key];
}

/** Bindings grouped by label, in key-map order, plus the help key itself. */
export function shortcutRows(bindings: readonly MailKeyBinding[] = MAIL_KEY_BINDINGS): Array<{ label: string; keys: string[][] }> {
  const rows: Array<{ label: string; keys: string[][] }> = [];
  for (const binding of bindings) {
    const row = rows.find((candidate) => candidate.label === binding.label);
    if (row) row.keys.push(keyName(binding.key));
    else rows.push({ label: binding.label, keys: [keyName(binding.key)] });
  }
  rows.push({ label: "Extend selection", keys: [["Shift", "↓"], ["Shift", "↑"]] });
  rows.push({ label: "Show keyboard shortcuts", keys: [["?"]] });
  return rows;
}

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <table className="mail-shortcuts">
        <tbody>
          {shortcutRows().map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>
                {row.keys.map((keys, i) => (
                  <span key={keys.join("+")} className="mail-shortcuts__combo">
                    {i > 0 && <span className="mail-shortcuts__or">or</span>}
                    <KeyHint keys={keys} />
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
