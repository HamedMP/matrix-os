import { uniqueConnection } from "./import";
import type { Connection, Definition } from "./types";

export default function ImportAccounts({ app, inventory, loaded, chosen, onChoose, disabled }: {
  app: Definition; inventory: Connection[] | null; loaded: boolean; chosen: string[];
  onChoose: (value: string[]) => void; disabled: boolean;
}) {
  if (!loaded) return <p>Checking connections…</p>;
  if (!inventory) return <p className="notice">Connection availability could not be checked.</p>;
  return <>{app.services.map(service => <AccountGroup key={service.id} service={service} inventory={inventory} chosen={chosen} onChoose={onChoose} disabled={disabled} />)}</>;
}
function AccountGroup({ service, inventory, chosen, onChoose, disabled }: {
  service: Definition["services"][number]; inventory: Connection[]; chosen: string[];
  onChoose: (value: string[]) => void; disabled: boolean;
}) {
  const accounts = inventory.filter(c => c.service === service.id);
  const unique = accounts.filter((c, i) => accounts.findIndex(other => other.account_label === c.account_label) === i);
  return <fieldset><legend>{service.name}{service.optional && " · optional source"}</legend>
    {unique.length ? unique.map(account => <AccountChoice key={account.account_label} account={account} inventory={inventory} chosen={chosen} onChoose={onChoose} disabled={disabled} />)
      : <p className="muted">Connect this service in Matrix Settings first.</p>}
  </fieldset>;
}
function AccountChoice({ account, inventory, chosen, onChoose, disabled }: {
  account: Connection; inventory: Connection[]; chosen: string[];
  onChoose: (value: string[]) => void; disabled: boolean;
}) {
  const key = `${account.service}:${account.account_label}`;
  const ambiguous = !uniqueConnection(inventory, account.service, account.account_label);
  const unavailable = !account.id || ambiguous;
  return <label className="check"><input type="checkbox" disabled={disabled || unavailable} checked={chosen.includes(key)}
    onChange={e => onChoose(e.target.checked ? [...chosen, key] : chosen.filter(k => k !== key))} />
    <span><strong>{account.account_email ?? account.account_label}</strong>{account.account_email && <small>{account.account_label}</small>}
      {unavailable && <small>{!account.id ? "Account identity unavailable. Update Matrix before importing." : "Account label is shared. Give each account a unique label in Matrix Settings."}</small>}
    </span>
  </label>;
}
