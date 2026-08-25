import type {
  CanonicalChatInvocation,
  CanonicalChatResourceReference,
} from "@matrix-os/contracts";

export type ComposerReferenceToken =
  | {
      type: "invocation";
      invocation: CanonicalChatInvocation;
      label: string;
    }
  | {
      type: "resource";
      resource: CanonicalChatResourceReference;
    };

export interface SharedChatComposerSubmission {
  text: string;
  agentPrompt: string;
  invocations: CanonicalChatInvocation[];
  resources: CanonicalChatResourceReference[];
}

export function composerReferenceTokenKey(token: ComposerReferenceToken): string {
  return token.type === "invocation"
    ? `invocation:${token.invocation.kind}:${token.invocation.descriptorId}`
    : `resource:${token.resource.kind}:${token.resource.id}`;
}

export function addComposerReferenceToken(
  tokens: ComposerReferenceToken[],
  token: ComposerReferenceToken,
): ComposerReferenceToken[] {
  const key = composerReferenceTokenKey(token);
  return tokens.some((candidate) => composerReferenceTokenKey(candidate) === key)
    ? tokens
    : [...tokens, token];
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownDestination(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll(" ", "%20")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerReferenceToken(token: ComposerReferenceToken): string {
  if (token.type === "invocation") return token.invocation.invocation;
  return `[${escapeMarkdownLabel(token.resource.label)}](${encodeMarkdownDestination(token.resource.id)})`;
}

export function buildSharedChatComposerSubmission(
  value: string,
  tokens: ComposerReferenceToken[],
): SharedChatComposerSubmission {
  const text = value.trim();
  const invocations = tokens.flatMap((token) => (
    token.type === "invocation" ? [token.invocation] : []
  ));
  const resources = tokens.flatMap((token) => (
    token.type === "resource" ? [token.resource] : []
  ));
  return {
    text,
    agentPrompt: text,
    invocations,
    resources,
  };
}
