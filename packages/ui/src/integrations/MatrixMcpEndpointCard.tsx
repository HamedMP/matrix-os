"use client";

import { ArrowRight, Check, Copy, SquareTerminal, Waypoints } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { McpServiceLogo, McpServiceLogoStack } from "./McpServiceLogo.js";
import { matrixMcpClientSetups, type MatrixMcpClientId } from "./matrix-mcp-endpoint.js";
import { mcpTokens as t } from "./mcp-settings-tokens.js";

export interface MatrixMcpEndpointCardProps {
  /** The hosted Matrix MCP URL (see `matrixMcpEndpointUrl`). */
  endpointUrl: string;
  /** Services that are connected and ready; shown as the "routes to" side of the card. */
  connectedServices: ReadonlyArray<{ presetId?: string; name: string }>;
}

const COPY_RESET_MS = 1800;

/** Copies text and reports the outcome; clipboard access can be denied in sandboxed or unfocused windows. */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (key: string, text: string) => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("ClipboardUnavailable");
      await navigator.clipboard.writeText(text);
      setFailed(null);
      setCopied(key);
    } catch (error: unknown) {
      console.warn("[matrix-mcp] copy failed:", error instanceof Error ? error.name : "UnknownError");
      setCopied(null);
      setFailed(key);
    }
    timer.current = setTimeout(() => { setCopied(null); setFailed(null); }, COPY_RESET_MS);
  };
  return { copied, failed, copy };
}

function CopyButton({ label, done, failed, onClick, compact = false }: { label: string; done: boolean; failed: boolean; onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" aria-label={label} onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-2 ${compact ? "px-2 py-1" : "px-3 py-2"}`}
      style={{ background: done ? t.success : t.primary, color: t.primaryFg }}>
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span aria-live="polite">{done ? "Copied" : failed ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

/** Client marks: Claude and OpenAI glyphs from Simple Icons (CC0); Cursor drawn as its cube mark. */
const CLIENT_MARKS: Record<MatrixMcpClientId, ReactNode> = {
  "claude-code": <svg width={14} height={14} viewBox="0 0 24 24" focusable="false"><path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" /></svg>,
  codex: <svg width={14} height={14} viewBox="0 0 24 24" focusable="false"><path fill="#0D0D0D" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" /></svg>,
  cursor: (
    <svg width={14} height={14} viewBox="0 0 24 24" focusable="false">
      <path fill="#0D0D0D" d="M12 1.5 21.1 6.75v10.5L12 22.5l-9.1-5.25V6.75z" />
      <path fill="#FFFFFF" d="M12 4.2 18.8 8.1 12 12zM12 12l6.8-3.9v7.8z" opacity="0.9" />
    </svg>
  ),
  stdio: <SquareTerminal size={14} strokeWidth={2} color="#3F3F46" />,
};

function ClientMark({ id }: { id: MatrixMcpClientId }) {
  return (
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-md"
      style={{ background: "#FFFFFF", boxShadow: "inset 0 0 0 1px rgba(15, 23, 42, 0.08)" }}>
      {CLIENT_MARKS[id]}
    </span>
  );
}

/**
 * The hero of Settings → MCPs: one Matrix MCP URL that routes to every service
 * the owner connected, plus copy-paste setup for common clients (spec 2691).
 */
export function MatrixMcpEndpointCard({ endpointUrl, connectedServices }: MatrixMcpEndpointCardProps) {
  const setups = matrixMcpClientSetups(endpointUrl);
  const [client, setClient] = useState<MatrixMcpClientId>("claude-code");
  const active = setups.find(setup => setup.id === client) ?? setups[0]!;
  const { copied, failed, copy } = useCopy();
  const count = connectedServices.length;

  return (
    <section aria-label="Your Matrix MCP" className="overflow-hidden rounded-2xl border"
      style={{ borderColor: t.border, background: t.surface }}>
      <div className="relative space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: t.primary, color: t.primaryFg }}>
              <Waypoints size={20} />
            </span>
            <div className="min-w-0">
              <h4 className="text-base font-semibold tracking-tight" style={{ color: t.text }}>Your Matrix MCP</h4>
              <p className="mt-0.5 max-w-xl text-sm" style={{ color: t.secondary }}>
                One URL for every service you connect here. Add it to Claude Code, Codex, or any MCP client and sign in to Matrix once; you never set up each service again.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ background: t.sunken, color: count > 0 ? t.text : t.muted }}>
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: count > 0 ? t.success : t.muted }} />
            {count === 0 ? "No services yet" : `Routes to ${count} ${count === 1 ? "service" : "services"}`}
          </span>
        </div>

        <div className="flex items-center gap-2 rounded-xl border p-1.5 pl-3" style={{ borderColor: t.borderStrong, background: t.sunken }}>
          <code aria-label="Matrix MCP URL" className="min-w-0 flex-1 truncate text-sm" style={{ fontFamily: t.mono, color: t.text }}>{endpointUrl}</code>
          <CopyButton label="Copy Matrix MCP URL" done={copied === "url"} failed={failed === "url"} onClick={() => { void copy("url", endpointUrl); }} />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: t.muted }}>
          <div role="tablist" aria-label="Connect a client" className="flex flex-wrap items-center gap-1.5">
            {setups.map(setup => {
              const selected = setup.id === client;
              return (
                <button key={setup.id} type="button" role="tab" id={`matrix-mcp-tab-${setup.id}`} aria-selected={selected}
                  aria-controls="matrix-mcp-client-panel" onClick={() => setClient(setup.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border py-1 pl-1 pr-2.5 text-xs font-medium transition-colors focus-visible:outline-2"
                  style={selected
                    ? { borderColor: t.text, background: t.surface, color: t.text, boxShadow: `0 0 0 1px ${t.text}` }
                    : { borderColor: t.border, background: "transparent", color: t.secondary }}>
                  <ClientMark id={setup.id} />
                  {setup.label}
                </button>
              );
            })}
          </div>
          <span aria-hidden="true" className="flex items-center gap-2">
            <ArrowRight size={14} />
            <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium" style={{ background: t.primary, color: t.primaryFg }}>
              <Waypoints size={12} /> Matrix
            </span>
            <ArrowRight size={14} />
            {count > 0 ? <McpServiceLogoStack services={connectedServices} size={24} /> : (
              <span className="flex items-center gap-1 opacity-50">
                {["linear", "hubspot", "gmail", "notion"].map(id => <McpServiceLogo key={id} presetId={id} name={id} size={20} />)}
              </span>
            )}
          </span>
        </div>

        <div role="tabpanel" id="matrix-mcp-client-panel" aria-labelledby={`matrix-mcp-tab-${active.id}`} className="space-y-2">
          <div className="overflow-hidden rounded-xl border" style={{ borderColor: t.border, background: t.sunken }}>
            <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5" style={{ borderColor: t.border }}>
              <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: t.muted }}>{active.label} · {active.snippetLabel}</span>
              <CopyButton compact label={`Copy ${active.label} setup`} done={copied === active.id} failed={failed === active.id} onClick={() => { void copy(active.id, active.snippet); }} />
            </div>
            <pre className="overflow-x-auto px-3 py-2.5 text-xs leading-relaxed" style={{ fontFamily: t.mono, color: t.text }}>{active.snippet}</pre>
          </div>
          <p className="text-xs" style={{ color: t.muted }}>{active.hint} Writes from outside Matrix wait for your approval below.</p>
        </div>
      </div>
    </section>
  );
}
