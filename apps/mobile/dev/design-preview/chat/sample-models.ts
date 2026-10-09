import { MATRIX_ENGINE_ID, type ModelChoice, type ModelEngine } from "@/components/chat/model-choices";

// The sample content of frame C3. The frame adds a category to each model's
// second line ("Matrix AI · Coding"), which the catalog does not provide, and
// shows the models of Matrix AI only.

function matrixModel(key: string, name: string, selected = false): ModelChoice {
  return { key, name, detail: "Matrix AI", logo: "matrix", selected, available: true };
}

export const SAMPLE_MODEL_ENGINES: ModelEngine[] = [
  {
    id: MATRIX_ENGINE_ID,
    label: "Matrix AI",
    logo: "matrix",
    note: null,
    models: [
      matrixModel("sample-sonnet", "Claude Sonnet 5", true),
      matrixModel("sample-glm", "GLM"),
      matrixModel("sample-gf1", "GF1"),
    ],
  },
  { id: "sample-claude-code", label: "Claude Code", logo: "claude", note: null, models: [] },
  { id: "sample-codex", label: "Codex", logo: "codex", note: null, models: [] },
  // The frame cuts this chip off after its logo.
  { id: "sample-hermes", label: "Hermes", logo: "hermes", note: null, models: [] },
];

export const SAMPLE_CREDIT = "$18.40";
