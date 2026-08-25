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

function formatResourceReference(resource: CanonicalChatResourceReference): string {
  const identifier = resource.id === resource.label ? "" : ` (${resource.id})`;
  return `- [${resource.kind}] ${resource.label}${identifier}`;
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
  const sections = [
    invocations.map((invocation) => invocation.invocation).join("\n"),
    text,
    resources.length > 0
      ? `Context references:\n${resources.map(formatResourceReference).join("\n")}`
      : "",
  ].filter((section) => section.length > 0);

  return {
    text,
    agentPrompt: sections.join("\n\n"),
    invocations,
    resources,
  };
}
