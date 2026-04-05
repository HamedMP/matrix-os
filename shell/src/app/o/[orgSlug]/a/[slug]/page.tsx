"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface OrgApp {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  iconUrl: string | null;
  installsCount: number;
  avgRating: string;
  ratingsCount: number;
}

export default function OrgAppPage() {
  const params = useParams<{ orgSlug: string; slug: string }>();
  const [app, setApp] = useState<OrgApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.orgSlug || !params.slug) return;

    const controller = new AbortController();
    setLoading(true);

    fetch(`${GATEWAY_URL}/api/store/orgs/${params.orgSlug}/apps`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (res.status === 403) throw new Error("Not a member of this organization");
        if (!res.ok) throw new Error("Failed to load org apps");
        return res.json();
      })
      .then((data: { apps: OrgApp[] }) => {
        const found = data.apps.find((a) => a.slug === params.slug);
        if (!found) throw new Error("App not found in this organization");
        setApp(found);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [params.orgSlug, params.slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
        <div className="text-center max-w-md p-8">
          <h1 className="text-lg font-semibold mb-2">Access Denied</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (!app) return null;

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-6">
          <span>{params.orgSlug}</span>
          <span>/</span>
          <span>{app.slug}</span>
        </div>

        <div className="flex items-start gap-4 mb-6">
          <div className="h-16 w-16 rounded-xl bg-muted flex items-center justify-center text-2xl shrink-0">
            {app.iconUrl ? (
              <img
                src={app.iconUrl}
                alt=""
                className="h-16 w-16 rounded-xl object-cover"
              />
            ) : (
              app.name.charAt(0).toUpperCase()
            )}
          </div>
          <div>
            <h1 className="text-xl font-semibold">{app.name}</h1>
            {app.description && (
              <p className="text-sm text-muted-foreground mt-1">
                {app.description}
              </p>
            )}
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              <span>{app.category}</span>
              <span>{app.installsCount} installs</span>
              {Number(app.avgRating) > 0 && (
                <span>
                  {app.avgRating} ({app.ratingsCount} ratings)
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
