/** Defense in depth for the future isolated Jev execution path.
 *
 * This does not isolate files or processes. PR1 blocks Jev dispatch before a
 * harness starts; a supported restricted execution boundary is required next.
 */
export function clearGatewayAuthorityEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = /^(?:MATRIX_.*(?:TOKEN|SECRET|KEY)|UPGRADE_TOKEN|DATABASE_URL|PLATFORM_|PIPEDREAM_|CLERK_|POSTHOG_|R2_|S3_|AI_RELAY_|CF_AIG_|STRIPE_)/;
  return Object.fromEntries(Object.keys(env).filter((key) => blocked.test(key)).map((key) => [key, ""]));
}
