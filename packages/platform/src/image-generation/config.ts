export type PlatformImageConfig = {
    enabled: false;
} | {
    enabled: true;
    apiKey: string;
    monthlyAllowanceMicrousd: number;
};
export function loadPlatformImageConfig(env: NodeJS.ProcessEnv = process.env): PlatformImageConfig {
    if (env.PLATFORM_IMAGE_ENABLED !== "true" && env.PLATFORM_IMAGE_ENABLED !== "1")
        return { enabled: false };
    const apiKey = env.PLATFORM_IMAGE_GEMINI_API_KEY ?? "";
    const cap = Number(env.PLATFORM_IMAGE_MONTHLY_ALLOWANCE_MICROUSD);
    if (apiKey.length < 16 || apiKey.length > 512 || !Number.isSafeInteger(cap) || cap < 1 || cap > 100000000)
        throw new Error("Platform images are misconfigured");
    return { enabled: true, apiKey, monthlyAllowanceMicrousd: cap };
}
