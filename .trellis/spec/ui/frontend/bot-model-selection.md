# Bot model selection

## 1. Scope / Trigger

Recipe creation, Agent editing, Bot details and composer must share the authenticated catalog's model identity and availability.

## 2. Signatures

Use `isAutomaticBotSelection(selection)` for the exact legacy sentinel; `managedPiBotModelChoices(catalog)` for managed choices; `botModelRoutingLabel(selection, catalog)` for saved route presentation.

## 3. Contracts

Concrete Matrix AI is instance `matrix_pi_default` with its canonical catalog model ID. Automatic requires `matrix_bot_default/auto` without options. Undefined means loading; bound null means unavailable. An omitted new-recipe selection retains its existing backend creation default, not evidence of an effective Matrix model.

## 4. Validation & Error Matrix

- Fresh executable catalog: initialize a new recipe once to its first concrete Matrix model.
- Refresh or unavailable/reserved catalog: prohibit new/changed model saves; do not retain stale executable choices.
- Existing unchanged unavailable/legacy route: preserve identity while allowing unrelated text edits.
- Unknown/nonmanaged recipe route: display the actual saved provider/model as unavailable; never Automatic.

## 5. Good / Base / Bad

Good: new setup, existing editor and composer persist/reopen the same concrete Matrix model. Base: legacy custom Agent remains its saved coding route until explicit switch; Jev remains Hermes. Bad: silently converting a removed model to Automatic or silently choosing Codex for new Agents.

## 6. Tests Required

Contract model-choice tests, actual Bot details rendering, matrix-model-selection, reserved-credit field, recipe instantiation, composer controls and ChatAgentsEntry cover canonical identity, late catalog arrival, unchanged legacy save and unavailable/refresh guards. Live acceptance additionally requires real new/existing Bot inference and settlement on the exact tested runtime.

## 7. Wrong vs Correct

Wrong: every non-Pi selection is Automatic. Correct: only the exact supported sentinel is Automatic; other identities stay visible and retain their own availability semantics. Do not claim configured selection as proof of the admitted run model.
