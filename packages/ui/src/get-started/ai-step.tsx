import {
  GET_STARTED_BOT_LANGUAGES,
  GET_STARTED_BOT_NAMES,
  GET_STARTED_BOT_STYLE,
  GET_STARTED_PERSONALITIES,
  getStartedBotFromWizard,
  getStartedBotPreview,
  renderGetStartedSoulSection,
  type GetStartedAnswers,
  type GetStartedBot,
  type GetStartedBotStyleField,
  type GetStartedWizardEvent,
} from "@matrix-os/contracts";
import { useId, useState, type ReactNode } from "react";
import { RabbitAvatar, ToggleChip } from "../onboarding-widget/parts.js";

const STYLE_FIELDS = Object.keys(GET_STARTED_BOT_STYLE) as GetStartedBotStyleField[];

function ChoiceRow({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId} className="mxo-muted">{title}</h3>
      <div className="mxo-chips" role="group" aria-labelledby={titleId}>{children}</div>
    </section>
  );
}

/** Spec 635, Section 7: the AI's name and style. Everything here only shapes SOUL; it grants nothing. */
export function GetStartedAiStep({ bot, answers, dispatch }: {
  bot: GetStartedBot;
  answers: GetStartedAnswers;
  dispatch(event: GetStartedWizardEvent): void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [soulOpen, setSoulOpen] = useState(false);
  const set = (patch: Partial<GetStartedBot>) => dispatch({ type: "bot", patch });
  const preview = getStartedBotFromWizard(bot);
  return (
    <>
      <ChoiceRow title="Name">
        {GET_STARTED_BOT_NAMES.map((name) => (
          <ToggleChip key={name} label={name} pressed={bot.name === name} onToggle={() => set({ name })} />
        ))}
      </ChoiceRow>
      <input
        className="mxo-gs__input"
        aria-label="AI name"
        placeholder="Or type a name"
        value={bot.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      <ChoiceRow title="Personality">
        {GET_STARTED_PERSONALITIES.map((personality) => (
          <ToggleChip key={personality.id} label={personality.label} pressed={bot.personality === personality.id} onToggle={() => set({ personality: personality.id })} />
        ))}
      </ChoiceRow>

      {preview ? null : <p className="mxo-failed-line" role="alert">That name can't be used. Try another.</p>}
      <div className="mxo-card mxo-app" aria-live="polite">
        <RabbitAvatar size={28} />
        <span className="mxo-app__name">
          {preview?.name ?? "Matrix"}
          <span className="mxo-muted mxo-gs__why">{preview ? getStartedBotPreview(preview) : ""}</span>
        </span>
      </div>
      <p className="mxo-muted">Sample reply for the personality, length and emoji you picked. Language, tone and humour apply in real chats.</p>

      <button type="button" className="mxo-link" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
        {moreOpen ? "Fewer options" : "More options"}
      </button>
      {moreOpen ? (
        <div className="mxo-gs__groups">
          {STYLE_FIELDS.map((field) => (
            <ChoiceRow key={field} title={GET_STARTED_BOT_STYLE[field].title}>
              {GET_STARTED_BOT_STYLE[field].options.map((option) => (
                <ToggleChip key={option.id} label={option.label} pressed={bot[field] === option.id} onToggle={() => set({ [field]: option.id })} />
              ))}
            </ChoiceRow>
          ))}
          <ChoiceRow title="Language">
            {GET_STARTED_BOT_LANGUAGES.map((language) => (
              <ToggleChip key={language.id} label={language.label} pressed={bot.language === language.id} onToggle={() => set({ language: language.id })} />
            ))}
          </ChoiceRow>
          <textarea
            className="mxo-gs__input mxo-gs__textarea"
            aria-label="Always or never"
            placeholder="Always or never… e.g. Never email clients without showing me first."
            rows={2}
            value={bot.rules ?? ""}
            onChange={(event) => set({ rules: event.target.value })}
          />
        </div>
      ) : null}

      <p className="mxo-muted">Always asks before doing anything outside Matrix.</p>
      <button type="button" className="mxo-link" aria-expanded={soulOpen} onClick={() => setSoulOpen((open) => !open)}>
        {soulOpen ? "Hide what this writes" : "See what this writes"}
      </button>
      {soulOpen && preview ? <pre className="mxo-card mxo-summary mxo-gs__soul">{renderGetStartedSoulSection({ ...answers, bot: preview })}</pre> : null}
    </>
  );
}
