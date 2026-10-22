import {
  getStartedRecipeBotSuggestions,
  getStartedServiceLabel,
  type GetStartedWizardEvent,
  type GetStartedWizardState,
} from "@matrix-os/contracts";
import { useId } from "react";
import { RabbitAvatar } from "../onboarding-widget/parts.js";
import { ServiceConnectAction, type GetStartedConnect } from "./connect.js";

const NONE: ReadonlySet<string> = new Set();

/** Offers the first missing app's own sign-in right in the row; once connected, the bot can be added. */
function MissingApp({ service, all, connect }: { service: string; all: readonly string[]; connect: GetStartedConnect | null }) {
  const label = getStartedServiceLabel(service);
  if (connect && !connect.unavailable && connect.availableServices.has(service)) {
    return <ServiceConnectAction service={service} label={label} connect={connect} text={`Connect ${label}`} />;
  }
  return <span className="mxo-muted">Needs {all.map(getStartedServiceLabel).join(" and ")}</span>;
}

/** Spec 635, Section 7b: ready-made bots for the owner's goals. Adding one never grants app access. */
export function GetStartedRecipeBots({ wizard, connect, dispatch }: {
  wizard: GetStartedWizardState;
  connect: GetStartedConnect | null;
  dispatch(event: GetStartedWizardEvent): void;
}) {
  const titleId = useId();
  const suggestions = getStartedRecipeBotSuggestions(wizard.goals, connect?.connectedServices ?? NONE);
  if (suggestions.length === 0) return null;
  const added = new Set(wizard.bots);
  return (
    <section className="mxo-gs__connect-section">
      <h3 id={titleId} className="mxo-muted">Bots for you</h3>
      <ul className="mxo-card mxo-app-list" aria-labelledby={titleId}>
        {suggestions.map(({ bot, missing }) => {
          const isAdded = added.has(bot.recipeId);
          return (
            <li key={bot.recipeId} className="mxo-app">
              <RabbitAvatar size={28} />
              <span className="mxo-app__name">
                {bot.label}
                <span className="mxo-muted mxo-gs__why">{bot.why}</span>
              </span>
              {missing.length > 0 && !isAdded ? (
                <MissingApp service={missing[0]!} all={missing} connect={connect} />
              ) : (
                <button
                  type="button"
                  className="mxo-btn mxo-btn--outline"
                  aria-pressed={isAdded}
                  aria-label={`${isAdded ? "Remove" : "Add"} ${bot.label}`}
                  onClick={() => dispatch({ type: "toggle-bot", id: bot.recipeId })}
                >
                  {isAdded ? "Added" : "Add"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mxo-muted">Bots start with no access to your apps. You choose what each one can use.</p>
    </section>
  );
}
