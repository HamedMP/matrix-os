"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDownIcon, ChevronUpIcon, CheckIcon, LoaderIcon } from "lucide-react";

interface ChannelCardProps {
  id: string;
  name: string;
  icon: React.ReactNode;
  status: string;
  config?: Record<string, unknown>;
  fields: Array<{ key: string; label: string; type?: string; placeholder?: string }>;
  onSave?: (config: Record<string, string>) => Promise<boolean>;
}

const STATUS_STYLES: Record<string, string> = {
  connected: "bg-green-500/10 text-green-600 border-green-500/20",
  configured: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  error: "bg-red-500/10 text-red-600 border-red-500/20",
  disabled: "bg-muted text-muted-foreground",
  stopped: "bg-muted text-muted-foreground",
};

export function ChannelCard({ id, name, icon, status, config, fields, onSave }: ChannelCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) {
      init[f.key] = (config?.[f.key] as string) ?? "";
    }
    return init;
  });

  useEffect(() => {
    if (!config) return;
    const updated: Record<string, string> = {};
    for (const f of fields) {
      updated[f.key] = (config[f.key] as string) ?? "";
    }
    setValues(updated);
  }, [config, fields]);

  const statusClass = STATUS_STYLES[status] ?? STATUS_STYLES.disabled;

  async function handleSave() {
    if (!onSave) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const ok = await onSave(values);
      if (ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError("Failed to save");
      }
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="gap-0">
      <CardHeader
        className="cursor-pointer py-3 px-4"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {icon}
            <CardTitle className="text-sm font-medium">{name}</CardTitle>
            <Badge variant="outline" className={`text-xs ${statusClass}`}>
              {status}
            </Badge>
          </div>
          {expanded ? (
            <ChevronUpIcon className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-4 text-muted-foreground" />
          )}
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="px-4 pb-4 pt-0 space-y-3">
          {fields.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`${id}-${field.key}`} className="text-xs">
                {field.label}
              </Label>
              <Input
                id={`${id}-${field.key}`}
                type={field.type ?? "text"}
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                className="h-8 text-sm"
              />
            </div>
          ))}
          {error && <p className="text-xs text-red-500">{error}</p>}
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? (
              <><LoaderIcon className="size-3 animate-spin mr-1" /> Saving...</>
            ) : saved ? (
              <><CheckIcon className="size-3 mr-1" /> Saved</>
            ) : (
              "Save"
            )}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
