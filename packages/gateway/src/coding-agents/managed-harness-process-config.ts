import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addPortableProviderCredentials, buildPiChildEnvironment } from "./pi-process-environment.js";

const MANAGED_GLM_MODEL = "@cf/zai-org/glm-5.3-flash";

function isManagedGlmCredential(
  credentials: Record<string, string> | undefined,
): boolean {
  return Boolean(credentials?.OPENAI_API_KEY && credentials.OPENAI_BASE_URL);
}

function readOnlyOpenCodeConfig(): Record<string, unknown> {
  return {
    snapshot: false,
    permission: {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
    },
  };
}

function anthropicOpenCodeBaseUrl(baseUrl: string): string {
  const prefix = baseUrl.replace(/\/+$/, "");
  return prefix.endsWith("/v1") ? prefix : `${prefix}/v1`;
}

export function buildOpenCodeRunConfiguration(
  credentials: Record<string, string> | undefined,
): string {
  const config = readOnlyOpenCodeConfig();
  if (isManagedGlmCredential(credentials)) {
    const baseUrl = credentials!.OPENAI_BASE_URL!;
    return JSON.stringify({
      ...config,
      agent: { title: { disable: true } },
      provider: {
        cloudflare: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: baseUrl.replace(/\/+$/, ""),
            apiKey: "{env:OPENAI_API_KEY}",
          },
        },
      },
    });
  }
  const anthropicBaseUrl = credentials?.ANTHROPIC_BASE_URL;
  return JSON.stringify({
    ...config,
    ...(anthropicBaseUrl ? {
      provider: {
        anthropic: { options: { baseURL: anthropicOpenCodeBaseUrl(anthropicBaseUrl) } },
      },
    } : {}),
  });
}

function processEnvironment(input: {
  homePath: string;
  baseEnvironment?: Record<string, string>;
  credentials?: Record<string, string>;
}): Record<string, string> {
  const ownerEnvironment = buildPiChildEnvironment({
    ...input.baseEnvironment,
    HOME: input.homePath,
  });
  ownerEnvironment.HOME = input.homePath;
  const env = addPortableProviderCredentials(ownerEnvironment, input.credentials);
  if (isManagedGlmCredential(input.credentials)) {
    env.OPENAI_API_KEY = input.credentials!.OPENAI_API_KEY!;
    env.OPENAI_BASE_URL = input.credentials!.OPENAI_BASE_URL!;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

export function prepareOpenCodeRunEnvironment(input: {
  homePath: string;
  baseEnvironment?: Record<string, string>;
  credentials?: Record<string, string>;
}): Record<string, string> {
  const env = processEnvironment(input);
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "1";
  env.OPENCODE_CONFIG_CONTENT = buildOpenCodeRunConfiguration(input.credentials);
  return env;
}

export async function preparePiRunEnvironment(input: {
  homePath: string;
  baseEnvironment?: Record<string, string>;
  credentials?: Record<string, string>;
}): Promise<Record<string, string>> {
  const env = processEnvironment(input);
  if (!isManagedGlmCredential(input.credentials)) return env;

  const configDirectory = join(input.homePath, ".matrix", "runtime", "pi-managed");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const modelsPath = join(configDirectory, "models.json");
  const temporaryPath = join(configDirectory, `.models-${randomUUID()}.tmp`);
  const content = JSON.stringify({
    providers: {
      cloudflare: {
        api: "openai-completions",
        baseUrl: input.credentials!.OPENAI_BASE_URL!.replace(/\/+$/, ""),
        apiKey: "OPENAI_API_KEY",
        models: [{
          id: MANAGED_GLM_MODEL,
          name: "GLM 5.3 Flash",
          input: ["text"],
          reasoning: true,
        }],
      },
    },
  });
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, modelsPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  env.PI_CODING_AGENT_DIR = configDirectory;
  return env;
}
