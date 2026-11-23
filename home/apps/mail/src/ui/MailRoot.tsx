/**
 * Connection states before the workspace: finding accounts, nothing
 * connected (onboarding), integrations unavailable, or a failure with retry.
 */
import { AlertCircle, Mail, Plug } from "lucide-react";
import { AppFrame, EmptyState, Skeleton } from "../../../_shared/office-ui";
import type { MailAccountEntry } from "../model";
import type { MailBridge } from "./context";
import { MailWorkspace } from "./MailWorkspace";
import { useMailAccounts, type AccountsLoader } from "./use-mail-accounts";
import { useMailStore, type StoreFactory } from "./use-mail-store";

export interface MailRootProps {
  loadAccounts?: AccountsLoader;
  createStore?: StoreFactory;
  bridge?: MailBridge;
  now?: () => number;
  timeZone?: string;
}

function LoadingFrame({ label }: { label: string }) {
  return (
    <AppFrame className="mail-app" title="Mail" titleIcon={<Mail size={18} />}>
      <div className="mail-boot" aria-busy="true" aria-label={label}>
        <div className="mail-boot__rail"><Skeleton lines={8} /></div>
        <div className="mail-boot__list">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="mail-row-skeleton"><Skeleton width="40%" /><Skeleton width="85%" /></div>)}
        </div>
        <div className="mail-boot__reading"><Skeleton lines={6} /></div>
      </div>
    </AppFrame>
  );
}

function Connected({ entries, ...props }: MailRootProps & { entries: MailAccountEntry[] }) {
  const store = useMailStore(entries, props.createStore);
  if (!store) return <LoadingFrame label="Opening mail" />;
  return <MailWorkspace store={store} entries={entries} bridge={props.bridge} now={props.now} timeZone={props.timeZone} />;
}

export function MailRoot(props: MailRootProps) {
  const { status, reload } = useMailAccounts(props.loadAccounts);
  switch (status.kind) {
    case "loading":
      return <LoadingFrame label="Finding your mail accounts" />;
    case "ready":
      return <Connected {...props} entries={status.entries} />;
    case "empty":
      return (
        <AppFrame className="mail-app" title="Mail" titleIcon={<Mail size={18} />}>
          <div className="mail-onboarding">
            <EmptyState
              icon={<Plug />}
              headline="Connect your mail"
              description="Open Settings > Integrations and connect Gmail or Outlook. Your mail stays in your account; Mail reads it through that connection, and nothing is sent without your click."
              action={{ label: "I have connected an account", onClick: reload }}
            />
          </div>
        </AppFrame>
      );
    case "unavailable":
      return (
        <AppFrame className="mail-app" title="Mail" titleIcon={<Mail size={18} />}>
          <div className="mail-onboarding">
            <EmptyState
              icon={<Plug />}
              headline="Mail accounts are not available here"
              description="Connected accounts are not offered on this surface. Open Mail on your Matrix computer, then connect Gmail or Outlook in Settings > Integrations."
              action={{ label: "Check again", onClick: reload }}
            />
          </div>
        </AppFrame>
      );
    case "error":
      return (
        <AppFrame className="mail-app" title="Mail" titleIcon={<Mail size={18} />}>
          <div className="mail-onboarding" role="alert">
            <EmptyState
              icon={<AlertCircle />}
              headline="Your mail accounts could not be loaded"
              description="Something went wrong while reaching your connected accounts."
              action={{ label: "Try again", onClick: reload }}
            />
          </div>
        </AppFrame>
      );
  }
}
