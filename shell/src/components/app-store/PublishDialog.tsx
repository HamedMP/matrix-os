"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, UploadIcon } from "lucide-react";
import { SecurityBadge } from "./SecurityBadge";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface PublishDialogProps {
  appSlug: string;
  appName: string;
  onClose: () => void;
  onPublished?: (result: { listingId: string; storeUrl: string; auditStatus: string }) => void;
}

const CATEGORIES = [
  "utility", "productivity", "games", "developer-tools", "education",
  "finance", "health-fitness", "social", "music", "photo-video",
  "news", "entertainment", "lifestyle",
];

export function PublishDialog({ appSlug, appName, onClose, onPublished }: PublishDialogProps) {
  const [description, setDescription] = useState("");
  const [longDescription, setLongDescription] = useState("");
  const [category, setCategory] = useState("utility");
  const [tagsInput, setTagsInput] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [changelog, setChangelog] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    listingId: string;
    auditStatus: string;
    auditFindings: Array<{ rule: string; message: string; severity: string }>;
    storeUrl: string;
  } | null>(null);

  const handlePublish = useCallback(async () => {
    if (!description.trim()) {
      setError("Description is required");
      return;
    }
    if (!version.trim()) {
      setError("Version is required");
      return;
    }

    setPublishing(true);
    setError(null);

    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await fetch(`${GATEWAY_URL}/api/apps/${appSlug}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          longDescription: longDescription || undefined,
          category,
          tags: tags.length > 0 ? tags : undefined,
          version,
          changelog: changelog || undefined,
          visibility,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Publication failed");
        return;
      }

      setResult(data);
      onPublished?.(data);
    } catch {
      setError("Network error - please try again");
    } finally {
      setPublishing(false);
    }
  }, [appSlug, description, longDescription, category, tagsInput, version, changelog, visibility, onPublished]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 z-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Publish {appName}</h2>
          <button
            onClick={onClose}
            className="size-7 flex items-center justify-center rounded-md hover:bg-muted"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {result ? (
          <div className="space-y-4">
            <div className="text-center py-4">
              <SecurityBadge status={result.auditStatus as "passed" | "pending" | "failed"} size="md" />
              <p className="text-sm mt-2">
                {result.auditStatus === "passed"
                  ? "Your app passed the security audit and is now live!"
                  : "Your app was published but the security audit found issues."}
              </p>
            </div>

            {result.auditFindings.length > 0 && (
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">Audit Findings</h4>
                {result.auditFindings.map((f, i) => (
                  <div
                    key={i}
                    className={`text-xs p-2 rounded ${
                      f.severity === "error" ? "bg-red-500/10 text-red-500" : "bg-amber-500/10 text-amber-600"
                    }`}
                  >
                    <span className="font-mono">{f.rule}</span>: {f.message}
                  </div>
                ))}
              </div>
            )}

            <Button className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Description *
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description for the gallery listing..."
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none h-20 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Full Description
              </label>
              <textarea
                value={longDescription}
                onChange={(e) => setLongDescription(e.target.value)}
                placeholder="Detailed description for the detail page..."
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none h-28 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Category *
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Version *
                </label>
                <input
                  type="text"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Tags
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="tag1, tag2, tag3"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Changelog
              </label>
              <textarea
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder="What changed in this version..."
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Visibility
              </label>
              <div className="flex gap-2 mt-1">
                {(["public", "unlisted"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setVisibility(v)}
                    className={`flex-1 rounded-lg border p-2 text-sm transition-colors ${
                      visibility === v
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-muted-foreground/30"
                    }`}
                  >
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onClose}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handlePublish} disabled={publishing}>
                {publishing ? (
                  "Publishing..."
                ) : (
                  <>
                    <UploadIcon className="size-4 mr-2" />
                    Publish
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
