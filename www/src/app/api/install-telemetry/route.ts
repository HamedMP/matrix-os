import { after, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getPostHogClient, shutdownPostHog } from '@/lib/posthog-server';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 4096;

const installTelemetrySchema = z.object({
  event: z.enum([
    'matrix_manual_install_started',
    'matrix_manual_install_completed',
    'matrix_manual_install_failed',
  ]),
  installId: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  channel: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  version: z.string().regex(/^[A-Za-z0-9._:/@+-]{1,120}$/),
  domainMode: z.enum(['ip', 'dns']),
  bundleSource: z.enum(['default', 'custom']),
  developerToolsCount: z.number().int().min(0).max(20),
  phase: z.string().regex(/^[A-Za-z0-9._:/@+-]{1,120}$/),
  status: z.enum(['started', 'completed', 'failed']),
  exitCode: z.number().int().min(0).max(255),
});

function jsonResponse(status: number) {
  return NextResponse.json({ ok: status < 400 }, { status });
}

async function readBoundedJson(request: Request): Promise<{ body?: unknown; tooLarge?: boolean }> {
  const reader = request.body?.getReader();
  if (!reader) {
    return {};
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { body: JSON.parse(new TextDecoder().decode(bytes)) };
}

export async function POST(request: Request) {
  const payload = await readBoundedJson(request).catch(() => undefined);
  if (!payload) {
    return jsonResponse(400);
  }
  if (payload.tooLarge) {
    return jsonResponse(413);
  }

  const parsed = installTelemetrySchema.safeParse(payload.body);
  if (!parsed.success) {
    return jsonResponse(400);
  }

  const input = parsed.data;
  const posthog = getPostHogClient();
  after(async () => {
    try {
      posthog.capture({
        distinctId: `manual-install:${input.installId}`,
        event: input.event,
        properties: {
          channel: input.channel,
          version: input.version,
          domain_mode: input.domainMode,
          bundle_source: input.bundleSource,
          developer_tools_count: input.developerToolsCount,
          phase: input.phase,
          status: input.status,
          exit_code: input.exitCode,
          install_surface: 'linux_vps_script',
          $ip: '0.0.0.0',
        },
      });
      await shutdownPostHog();
    } catch (err: unknown) {
      console.warn(
        '[install-telemetry] Failed to capture event:',
        err instanceof Error ? err.name : typeof err,
      );
    }
  });

  return new Response(null, { status: 204 });
}
