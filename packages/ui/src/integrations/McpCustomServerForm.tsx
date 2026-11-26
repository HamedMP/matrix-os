"use client";

import { Button } from "../Button.js";
import { mcpTokens as t } from "./mcp-settings-tokens.js";

export type McpCustomAuthMode = "none" | "oauth" | "bearer" | "api_key";

export interface McpCustomServerFormProps {
  name: string;
  url: string;
  authMode: McpCustomAuthMode;
  credential: string;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onAuthModeChange: (value: McpCustomAuthMode) => void;
  onCredentialChange: (value: string) => void;
  /** True while the add button may be pressed (surface owns busy/validation state). */
  canSubmit: boolean;
  onSubmit: () => void;
}

const field = "min-h-9 max-[520px]:min-h-11 w-full rounded-lg border px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-current";
const fieldGrid = "grid min-w-0 grid-cols-1 gap-3 @min-[29rem]/mcp-form:grid-cols-2";
const fieldLabel = "grid min-w-0 gap-1.5 text-xs font-medium";

/** "Add a custom MCP server" card, presentational only; each surface owns the request. */
export function McpCustomServerForm(props: McpCustomServerFormProps) {
  const { name, url, authMode, credential, canSubmit } = props;
  const needsCredential = authMode === "bearer" || authMode === "api_key";
  const fieldStyle = { borderColor: t.borderStrong, background: "var(--bg-app, var(--background))", color: t.text };
  return (
    <section aria-label="Add a custom MCP server" className="@container/mcp-form grid min-w-0 gap-4 rounded-2xl border p-4" style={{ borderColor: t.border, background: t.surface }}>
      <div className="space-y-0.5">
        <p className="text-sm font-semibold" style={{ color: t.text }}>Paste any MCP server URL</p>
        <p className="text-xs" style={{ color: t.muted }}>Not in the list? Add any remote HTTPS MCP server. It joins your Matrix MCP like the others.</p>
      </div>
      <div className={fieldGrid}>
        <label className={fieldLabel} style={{ color: t.secondary }}>
          <span>Name</span>
          <input aria-label="MCP server name" value={name} onChange={event => props.onNameChange(event.target.value)} placeholder="Research tools" maxLength={100} className={field} style={fieldStyle} />
        </label>
        <label className={fieldLabel} style={{ color: t.secondary }}>
          <span>Server URL</span>
          <input aria-label="MCP server URL" value={url} onChange={event => props.onUrlChange(event.target.value)} placeholder="https://example.com/mcp" maxLength={2048} className={field} style={{ ...fieldStyle, fontFamily: t.mono }} />
        </label>
      </div>
      <div role="group" aria-label="MCP sign-in" className={fieldGrid}>
        <label className={fieldLabel} style={{ color: t.secondary }}>
          <span>Sign-in</span>
          <select aria-label="Authentication mode" value={authMode} onChange={event => props.onAuthModeChange(event.target.value as McpCustomAuthMode)} className={field} style={fieldStyle}>
            <option value="oauth">MCP OAuth</option>
            <option value="none">No authentication</option>
            <option value="bearer">Bearer token</option>
            <option value="api_key">X-API-Key</option>
          </select>
        </label>
        {needsCredential ? (
          <label className={fieldLabel} style={{ color: t.secondary }}>
            <span>Secret</span>
            <input aria-label="MCP credential" type="password" autoComplete="off" value={credential} onChange={event => props.onCredentialChange(event.target.value)} placeholder="Secret credential" maxLength={4096} className={field} style={fieldStyle} />
          </label>
        ) : null}
      </div>
      <Button
        disabled={!canSubmit}
        onClick={props.onSubmit}
        className="min-h-9 justify-self-start max-[520px]:min-h-11 focus-visible:ring-2 focus-visible:ring-[var(--ring,var(--accent))]"
        style={canSubmit ? { background: t.primary, color: t.primaryFg } : undefined}
      >
        Add MCP server
      </Button>
    </section>
  );
}
