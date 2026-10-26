import {
  ChefHatIcon,
  Target02Icon,
  UserGroupIcon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { GET_STARTED_APP_IDEAS, type GetStartedAppIdeaId, type GetStartedWizardEvent, type GetStartedWizardState } from "@matrix-os/contracts";
import { useId, useState } from "react";
import { Icon, ToggleChip } from "../onboarding-widget/parts.js";
import { joinNames, type GetStartedGallery, type GetStartedGalleryApp } from "./gallery.js";

/** An App Gallery app the owner's connections make ready, and the connected services it uses. */
export interface GetStartedReadyApp {
  app: GetStartedGalleryApp;
  using: readonly { id: string; name: string }[];
}

function GalleryIcon({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="mxo-gs__ready-icon" aria-hidden="true">
      {failed ? name.charAt(0) : <img src={src} alt="" width={40} height={40} onError={() => setFailed(true)} />}
    </span>
  );
}

function ReadyApps({ ready, gallery, wizard, dispatch }: {
  ready: readonly GetStartedReadyApp[];
  gallery: GetStartedGallery;
  wizard: GetStartedWizardState;
  dispatch(event: GetStartedWizardEvent): void;
}) {
  const ideasId = useId();
  return (
    <div className="mxo-gs__gallery">
      <ul className="mxo-gs__bot-list" aria-label="Apps ready with your data">
        {ready.map(({ app, using }) => {
          const adding = gallery.installing === app.id;
          return (
            <li key={app.id} className="mxo-card mxo-gs__bot" data-added={app.installed ? "" : undefined}>
              <GalleryIcon key={gallery.iconUrl(app.id)} src={gallery.iconUrl(app.id)} name={app.name} />
              <span className="mxo-gs__bot-text">
                <strong>{app.name}</strong>
                <span className="mxo-muted">{app.tagline}</span>
                <span className="mxo-muted">Uses {joinNames(using.map((service) => service.name))}</span>
                {gallery.failed === app.id ? <span className="mxo-failed-line">Couldn't add it. Try again.</span> : null}
              </span>
              {app.installed ? (
                <span className="mxo-connected"><span className="mxo-dot mxo-dot--on" aria-hidden />Added</span>
              ) : (
                <button
                  type="button"
                  className="mxo-btn mxo-btn--outline"
                  aria-label={`Add ${app.name}`}
                  disabled={gallery.installing !== null}
                  aria-busy={adding}
                  onClick={() => gallery.install(app.id)}
                >
                  {adding ? "Adding…" : "Add"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <section aria-labelledby={ideasId}>
        <h3 id={ideasId} className="mxo-muted">Or build your first app</h3>
        <div className="mxo-chips">
          {GET_STARTED_APP_IDEAS.map((idea) => (
            <ToggleChip key={idea.id} label={idea.label} pressed={wizard.appIdea === idea.id} onToggle={() => dispatch({ type: "pick-app-idea", id: idea.id })} />
          ))}
        </div>
        <p className="mxo-muted">{BUILD_HINT}</p>
      </section>
    </div>
  );
}

const BUILD_HINT = "Pick one and Matrix starts building it in Chat as soon as your AI is ready.";

const IDEA_ICONS: Record<GetStartedAppIdeaId, IconSvgElement> = {
  "habit-tracker": Target02Icon,
  "client-crm": UserGroupIcon,
  "budget-planner": Wallet01Icon,
  "recipe-box": ChefHatIcon,
};

/**
 * Spec 635: App Gallery between the main bot and the assistant bots. With apps the owner's
 * connections make ready, it lists them to add; otherwise it shows what owners can build. The
 * first app idea lives here: Matrix starts building the pick when they arrive and an AI is ready.
 */
export function GetStartedAppGalleryStep({ wizard, dispatch, labelledBy, gallery, ready }: {
  wizard: GetStartedWizardState;
  dispatch(event: GetStartedWizardEvent): void;
  labelledBy: string;
  gallery: GetStartedGallery | null;
  ready: readonly GetStartedReadyApp[];
}) {
  if (gallery && ready.length > 0) return <ReadyApps ready={ready} gallery={gallery} wizard={wizard} dispatch={dispatch} />;
  return (
    <div className="mxo-gs__gallery">
      <div className="mxo-gs__ideas" role="group" aria-labelledby={labelledBy}>
        {GET_STARTED_APP_IDEAS.map((idea) => (
          <button
            key={idea.id}
            type="button"
            className="mxo-card mxo-gs__idea"
            aria-pressed={wizard.appIdea === idea.id}
            onClick={() => dispatch({ type: "pick-app-idea", id: idea.id })}
          >
            <span className="mxo-gs__idea-icon"><Icon icon={IDEA_ICONS[idea.id]} size={18} /></span>
            <strong>{idea.label}</strong>
            <span className="mxo-muted">{idea.request}</span>
          </button>
        ))}
      </div>
      <p className="mxo-muted">{BUILD_HINT} Make anything else in App Gallery anytime.</p>
    </div>
  );
}
