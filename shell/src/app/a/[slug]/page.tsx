"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

export default function PersonalAppPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The app is loaded from the user's ~/apps/{slug}/ directory
    // and rendered via the gateway's app serving mechanism.
    // This page serves as a wrapper/entry point.
    setLoading(false);
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading {slug}...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <h1 className="text-lg font-semibold mb-2">App not found</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  // Render the app in an iframe pointing to the gateway app server
  return (
    <div className="min-h-screen bg-background">
      <iframe
        src={`${GATEWAY_URL}/apps/${slug}/`}
        className="w-full h-screen border-0"
        title={slug}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
