import fallback from "./definition.json";
import type { Definition } from "./types";
export function readDefinition(): Definition {
  const value = document
    .getElementById("matrix-app-definition")
    ?.textContent?.trim();
  const definition: unknown =
    !value || value === "__MATRIX_APP_DEFINITION__"
      ? fallback
      : JSON.parse(value);
  if (
    !definition ||
    typeof definition !== "object" ||
    !("id" in definition) ||
    typeof definition.id !== "string" ||
    !("fields" in definition) ||
    !Array.isArray(definition.fields) ||
    definition.fields.length > 12 ||
    !("services" in definition) ||
    !Array.isArray(definition.services) ||
    definition.services.length > 4
  )
    throw new Error("App definition is unavailable");
  return definition as Definition;
}
