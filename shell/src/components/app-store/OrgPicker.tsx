"use client";

import { useEffect, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  role: string;
}

interface OrgPickerProps {
  value: string | null;
  onChange: (orgId: string | null) => void;
  userId?: string;
}

export function OrgPicker({ value, onChange, userId }: OrgPickerProps) {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    const controller = new AbortController();
    fetch(`${GATEWAY_URL}/api/store/orgs`, {
      headers: { "x-user-id": userId },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : { orgs: [] }))
      .then((data: { orgs: OrgSummary[] }) => setOrgs(data.orgs))
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [userId]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground py-1">
        Loading organizations...
      </div>
    );
  }

  if (orgs.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        Install to
      </label>
      <select
        value={value ?? "personal"}
        onChange={(e) =>
          onChange(e.target.value === "personal" ? null : e.target.value)
        }
        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="personal">Personal</option>
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </div>
  );
}
