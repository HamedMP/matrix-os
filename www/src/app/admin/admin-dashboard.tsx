"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";

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
    await fetch(`${apiUrl}${path}`, { method });
    await refresh();
    setLoading(null);
  }

  const running = containers.filter((c) => c.status === "running").length;
  const stopped = containers.filter((c) => c.status === "stopped").length;

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold font-[family-name:var(--font-jetbrains)]">
            Admin Dashboard
          </h1>
          <p className="text-zinc-400 mt-2">Container management</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="border border-zinc-800 rounded-lg p-4">
            <p className="text-sm text-zinc-400">Total Users</p>
            <p className="text-2xl font-bold">{containers.length}</p>
          </div>
          <div className="border border-zinc-800 rounded-lg p-4">
            <p className="text-sm text-zinc-400">Running</p>
            <p className="text-2xl font-bold text-green-500">{running}</p>
          </div>
          <div className="border border-zinc-800 rounded-lg p-4">
            <p className="text-sm text-zinc-400">Stopped</p>
            <p className="text-2xl font-bold text-zinc-500">{stopped}</p>
          </div>
        </div>

        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                <th className="p-3">Handle</th>
                <th className="p-3">Status</th>
                <th className="p-3">Ports</th>
                <th className="p-3">Last Active</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.handle} className="border-b border-zinc-800/50">
                  <td className="p-3 font-mono">{c.handle}</td>
                  <td className="p-3">
                    <Badge
                      variant={c.status === "running" ? "default" : "secondary"}
                      className={
                        c.status === "running"
                          ? "bg-green-500/20 text-green-400 border-green-500/30"
                          : "bg-zinc-700/20 text-zinc-400 border-zinc-600/30"
                      }
                    >
                      {c.status}
                    </Badge>
                  </td>
                  <td className="p-3 text-zinc-400 font-mono text-xs">
                    gw:{c.port} sh:{c.shell_port}
                  </td>
                  <td className="p-3 text-zinc-400 text-xs">
                    {new Date(c.last_active).toLocaleString()}
                  </td>
                  <td className="p-3 space-x-2">
                    {c.status === "stopped" ? (
                      <button
                        onClick={() =>
                          action(c.handle, "POST", `/containers/${c.handle}/start`)
                        }
                        disabled={loading !== null}
                        className="px-2 py-1 rounded text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-50"
                      >
                        {loading === `${c.handle}-/containers/${c.handle}/start`
                          ? "..."
                          : "Start"}
                      </button>
                    ) : (
                      <button
                        onClick={() =>
                          action(c.handle, "POST", `/containers/${c.handle}/stop`)
                        }
                        disabled={loading !== null}
                        className="px-2 py-1 rounded text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50"
                      >
                        {loading === `${c.handle}-/containers/${c.handle}/stop`
                          ? "..."
                          : "Stop"}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm(`Destroy ${c.handle}? This cannot be undone.`)) {
                          action(c.handle, "DELETE", `/containers/${c.handle}`);
                        }
                      }}
                      disabled={loading !== null}
                      className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
                    >
                      Destroy
                    </button>
                  </td>
                </tr>
              ))}
              {containers.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-zinc-500">
                    No containers provisioned yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
