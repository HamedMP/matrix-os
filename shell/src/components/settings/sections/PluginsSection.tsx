"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { getGatewayUrl } from "@/lib/gateway";
import { PuzzleIcon, PlusIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  origin: string;
  status: string;
  contributions: {
    tools: number;
    hooks: number;
    channels: number;
    routes: number;
    services: number;
    skills: number;
  };
}

const ORIGIN_STYLES: Record<string, string> = {
  bundled: "bg-blue-500/10 text-blue-600",
  workspace: "bg-green-500/10 text-green-600",
  config: "bg-yellow-500/10 text-yellow-600",
};

const CONFIG_EXAMPLE = `{
  "plugins": {
    "list": [
      "~/plugins/my-plugin"
    ]
  }
}`;

export function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [error, setError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    fetch(`${GATEWAY}/api/plugins`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setPlugins)
      .catch(() => setError(true));
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Plugins</h2>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setDialogOpen(true)}>
          <PlusIcon className="size-3 mr-1" />
          Install Plugin
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="py-8 text-center">
            <PuzzleIcon className="size-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              Could not load plugins. The gateway may not be running.
            </p>
          </CardContent>
        </Card>
      )}

      {!error && plugins.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <PuzzleIcon className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No plugins installed</p>
            <p className="text-xs text-muted-foreground mt-1">
              Place plugins in ~/plugins/ or add paths in config.json.
            </p>
          </CardContent>
        </Card>
      )}

      {plugins.length > 0 && (
        <div className="space-y-3">
          {plugins.map((plugin) => {
            const c = plugin.contributions;
            const caps = [
              c.tools > 0 && `${c.tools} tools`,
              c.hooks > 0 && `${c.hooks} hooks`,
              c.channels > 0 && `${c.channels} channels`,
              c.routes > 0 && `${c.routes} routes`,
              c.services > 0 && `${c.services} services`,
              c.skills > 0 && `${c.skills} skills`,
            ].filter((x): x is string => Boolean(x));

            return (
              <Card key={plugin.id} className="gap-0">
                <CardHeader className="py-3 px-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <PuzzleIcon className="size-4 text-primary" />
                      <CardTitle className="text-sm font-medium">{plugin.name}</CardTitle>
                      <Badge variant="secondary" className="text-xs font-mono">
                        v{plugin.version}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${ORIGIN_STYLES[plugin.origin] ?? ""}`}>
                        {plugin.origin}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`text-xs ${plugin.status === "loaded" ? "text-green-600" : "text-red-600"}`}
                      >
                        {plugin.status}
                      </Badge>
                    </div>
                  </div>
                  {plugin.description && (
                    <p className="text-xs text-muted-foreground mt-1 ml-7">
                      {plugin.description}
                    </p>
                  )}
                  {caps.length > 0 && (
                    <div className="flex gap-2 mt-2 ml-7">
                      {caps.map((cap) => (
                        <span key={cap} className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded">
                          {cap}
                        </span>
                      ))}
                    </div>
                  )}
                </CardHeader>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install Plugin</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-1">Option 1: Workspace plugins</p>
              <p className="text-xs text-muted-foreground">
                Place your plugin folder in <code className="bg-muted px-1 rounded">~/plugins/</code>.
                It will be auto-discovered on the next gateway restart.
              </p>
            </div>
            <div>
              <p className="text-sm font-medium mb-1">Option 2: Config path</p>
              <p className="text-xs text-muted-foreground mb-2">
                Add the plugin path to your <code className="bg-muted px-1 rounded">config.json</code> under
                the <code className="bg-muted px-1 rounded">plugins.list</code> array:
              </p>
              <pre className="text-xs bg-muted/30 p-3 rounded-md overflow-x-auto">
                {CONFIG_EXAMPLE}
              </pre>
            </div>
            <p className="text-xs text-muted-foreground">
              Plugins must include a <code className="bg-muted px-1 rounded">plugin.json</code> manifest
              with an id, version, and entry point. See the docs for the full plugin API.
            </p>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </div>
  );
}
