import {
  getStartedRecipeBotSuggestions,
  getStartedServiceLabel,
  type GetStartedWizardEvent,
  type GetStartedWizardState,
} from "@matrix-os/contracts";
import { RecipeRabbit } from "../chat-agents/RecipeRabbit.js";
import { ServiceConnectAction, type GetStartedConnect } from "./connect.js";

const NONE: ReadonlySet<string> = new Set();

const HOW_BOTS_WORK = [
  "Each one does a single job, on its own or when you message it.",
  "Start with no access to your apps. You choose what each one can use.",
  "Find them in Chat. Change or remove them anytime.",
] as const;

/** Offers the first missing app's own sign-in right on the card; once connected, the bot can be added. */
function MissingApp({ service, all, connect }: { service: string; all: readonly string[]; connect: GetStartedConnect | null }) {
  const label = getStartedServiceLabel(service);
  if (connect && !connect.unavailable && connect.availableServices.has(service)) {
    return <ServiceConnectAction service={service} label={label} connect={connect} text={`Connect ${label}`} />;
  }
  return <span className="mxo-muted">Needs {all.map(getStartedServiceLabel).join(" and ")}</span>;
}

/**
 * Spec 635, Section 7b: the "Meet your bots" screen. Ready-made bots for the owner's goals,
 * each drawn like it is in the bot gallery. Adding one never grants app access.
 */
export function GetStartedRecipeBots({ wizard, connect, dispatch }: {
  wizard: GetStartedWizardState;
  connect: GetStartedConnect | null;
  dispatch(event: GetStartedWizardEvent): void;
}) {
  const suggestions = getStartedRecipeBotSuggestions(wizard.goals, connect?.connectedServices ?? NONE);
  const added = new Set(wizard.bots);
  return (
    <div className="mxo-gs__bots">
      <ul className="mxo-gs__bot-list" aria-label="Bots for you">
        {suggestions.map(({ bot, missing }) => {
          const isAdded = added.has(bot.recipeId);
          return (
            <li key={bot.recipeId} className="mxo-card mxo-gs__bot" data-added={isAdded ? "" : undefined}>
              <RecipeRabbit id={bot.recipeId} name={bot.label} state={isAdded ? "success" : "idle"} />
              <span className="mxo-gs__bot-text">
                <strong>{bot.label}</strong>
                <span className="mxo-muted">{bot.why}</span>
              </span>
              {missing.length > 0 && !isAdded ? (
                <MissingApp service={missing[0]!} all={missing} connect={connect} />
              ) : (
                <button
                  type="button"
                  className={isAdded ? "mxo-btn mxo-btn--dark" : "mxo-btn mxo-btn--outline"}
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
      <ul className="mxo-gs__bot-facts">
        {HOW_BOTS_WORK.map((fact) => <li key={fact} className="mxo-muted">{fact}</li>)}
      </ul>
    </div>
  );
}
