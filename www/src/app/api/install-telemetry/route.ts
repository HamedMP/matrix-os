import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getPostHogClient } from '@/lib/posthog-server';

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

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse(413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400);
  }

  const parsed = installTelemetrySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400);
  }

  const input = parsed.data;
  getPostHogClient().capture({
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

  return new Response(null, { status: 204 });
}
