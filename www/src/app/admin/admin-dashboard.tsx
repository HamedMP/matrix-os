"use client";

import { useState } from "react";
import posthog from "posthog-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Container {
  handle: string;
  status: string;
  port: number;
  shell_port: number;
  created_at: string;
  last_active: string;
}

export function AdminDashboard({
  containers: initial,
  apiUrl,
}: {
  containers: Container[];
  apiUrl: string;
}) {
  const [containers, setContainers] = useState(initial);
  const [loading, setLoading] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`${apiUrl}/containers`);
    if (res.ok) setContainers(await res.json());
  }

  async function action(handle: string, method: string, path: string) {
    setLoading(`${handle}-${path}`);

    const actionType = path.includes("/start")
      ? "start"
      : path.includes("/stop")
        ? "stop"
        : "destroy";

    posthog.capture("admin_container_action", {
      action: actionType,
      target_handle: handle,
      method,
    });

    await fetch(`${apiUrl}${path}`, { method });
    await refresh();
    setLoading(null);
  }

  const running = containers.filter((c) => c.status === "running").length;
  const stopped = containers.filter((c) => c.status === "stopped").length;

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Admin Dashboard
          </h1>
          <p className="text-muted-foreground mt-2">Container management</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Card className="rounded-xl shadow-sm">
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Total Users</p>
              <p className="text-2xl font-bold">{containers.length}</p>
            </CardContent>
          </Card>
          <Card className="rounded-xl shadow-sm">
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Running</p>
              <p className="text-2xl font-bold text-success">{running}</p>
            </CardContent>
          </Card>
          <Card className="rounded-xl shadow-sm">
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Stopped</p>
              <p className="text-2xl font-bold text-muted-foreground">{stopped}</p>
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-xl shadow-sm overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle>Containers</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <th className="p-3 px-6">Handle</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Ports</th>
                  <th className="p-3">Last Active</th>
                  <th className="p-3 px-6">Actions</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.handle} className="border-b last:border-0">
                    <td className="p-3 px-6 font-mono text-sm">{c.handle}</td>
                    <td className="p-3">
                      <Badge
                        variant="outline"
                        className={
                          c.status === "running"
                            ? "rounded-full border-success/30 bg-success/10 text-success"
                            : "rounded-full border-border bg-muted text-muted-foreground"
                        }
                      >
                        {c.status}
                      </Badge>
                    </td>
                    <td className="p-3 text-muted-foreground font-mono text-xs">
                      gw:{c.port} sh:{c.shell_port}
                    </td>
                    <td className="p-3 text-muted-foreground text-xs">
                      {new Date(c.last_active).toLocaleString()}
                    </td>
                    <td className="p-3 px-6 space-x-2">
                      {c.status === "stopped" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            action(c.handle, "POST", `/containers/${c.handle}/start`)
                          }
                          disabled={loading !== null}
                          className="rounded-full border-success/30 text-success hover:bg-success/10"
                        >
                          {loading === `${c.handle}-/containers/${c.handle}/start`
                            ? "..."
                            : "Start"}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            action(c.handle, "POST", `/containers/${c.handle}/stop`)
                          }
                          disabled={loading !== null}
                          className="rounded-full border-warning/30 text-warning hover:bg-warning/10"
                        >
                          {loading === `${c.handle}-/containers/${c.handle}/stop`
                            ? "..."
                            : "Stop"}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (confirm(`Destroy ${c.handle}? This cannot be undone.`)) {
                            action(c.handle, "DELETE", `/containers/${c.handle}`);
                          }
                        }}
                        disabled={loading !== null}
                        className="rounded-full border-destructive/30 text-destructive hover:bg-destructive/10"
                      >
                        Destroy
                      </Button>
                    </td>
                  </tr>
                ))}
                {containers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">
                      No containers provisioned yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
