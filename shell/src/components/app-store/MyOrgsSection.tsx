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

interface OrgAppCard {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
}

interface MyOrgsSectionProps {
  userId?: string;
}

export function MyOrgsSection({ userId }: MyOrgsSectionProps) {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [orgApps, setOrgApps] = useState<Record<string, OrgAppCard[]>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    const controller = new AbortController();
    fetch(`${GATEWAY_URL}/api/store/orgs`, {
      // Auth handled by platform proxy (x-platform-user-id)
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : { orgs: [] }))
      .then(async (data: { orgs: OrgSummary[] }) => {
        setOrgs(data.orgs);
        const appsMap: Record<string, OrgAppCard[]> = {};
        await Promise.all(
          data.orgs.map(async (org) => {
            try {
              const res = await fetch(
                `${GATEWAY_URL}/api/store/orgs/${org.slug}/apps`,
                {
                  // Auth handled by platform proxy (x-platform-user-id)
                  signal: controller.signal,
                },
              );
              if (res.ok) {
                const appData = await res.json();
                appsMap[org.slug] = appData.apps ?? [];
              }
            } catch {
              // ignore fetch errors
            }
          }),
        );
        setOrgApps(appsMap);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [userId]);

  if (loading || orgs.length === 0) return null;

  const orgsWithApps = orgs.filter(
    (org) => (orgApps[org.slug] ?? []).length > 0,
  );

  if (orgsWithApps.length === 0) return null;

  return (
    <section className="mb-8">
      <h3 className="text-sm font-semibold mb-3 px-1">My Organizations</h3>
      {orgsWithApps.map((org) => (
        <div key={org.slug} className="mb-4">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-xs font-medium">{org.name}</span>
            <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">
              {org.role}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
            {(orgApps[org.slug] ?? []).map((app) => (
              <a
                key={app.id}
                href={`/o/${org.slug}/a/${app.slug}`}
                className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors"
              >
                <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center text-lg shrink-0">
                  {app.iconUrl ? (
                    <img
                      src={app.iconUrl}
                      alt=""
                      className="h-10 w-10 rounded-lg object-cover"
                    />
                  ) : (
                    app.name.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{app.name}</div>
                  {app.description && (
                    <div className="text-xs text-muted-foreground truncate">
                      {app.description}
                    </div>
                  )}
                </div>
              </a>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
