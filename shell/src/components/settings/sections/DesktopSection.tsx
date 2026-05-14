"use client";

import { MonitorIcon, ShieldCheckIcon, UploadCloudIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function DesktopSection() {
  return (
    <div className="space-y-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">Desktop</h2>
        <p className="mt-1 text-sm text-muted-foreground">Native Matrix shell, cloud development policy, and desktop release status.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheckIcon className="size-4" />
            Cloud-only coding agents
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Agent runtime</span>
            <Badge>Cloud enforced</Badge>
          </div>
          <p className="text-xs text-muted-foreground">Local agent execution cannot be enabled from desktop settings.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <UploadCloudIcon className="size-4" />
            Update channel
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Desktop builds</span>
            <span className="font-medium">dev, canary, beta, stable</span>
          </div>
          <p className="text-xs text-muted-foreground">Desktop release artifacts are signed, checksummed, and published through the Matrix desktop release workflow.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <MonitorIcon className="size-4" />
            Slay-style import guidance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Connect Matrix projects, ticket sources, and Symphony rules here; imported Slay-style workflows stay cloud-scoped in Matrix.</p>
          <p>Provider credentials and cloud runner secrets remain server-side and are never exposed to the desktop shell.</p>
        </CardContent>
      </Card>
    </div>
  );
}
