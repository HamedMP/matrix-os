import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";

type ContainerResult =
  | { state: "running" | "stopped"; data: Record<string, unknown> }
  | { state: "not_provisioned" }
  | { state: "platform_unavailable" };

async function getContainerInfo(handle: string): Promise<ContainerResult> {
  try {
    const res = await fetch(`${PLATFORM_API_URL}/containers/${handle}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      return { state: data.status === "running" ? "running" : "stopped", data };
    }
    return { state: "not_provisioned" };
  } catch {
    return { state: "platform_unavailable" };
  }
}

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const handle = user.username ?? user.id;
  const hasUsername = !!user.username;
  const result = await getContainerInfo(handle);

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Matrix OS
          </h1>
          <p className="text-muted-foreground mt-2">
            Welcome back, {user.firstName ?? handle}
          </p>
        </div>

        {!hasUsername && (
          <Card className="rounded-xl shadow-sm border-warning/30 bg-warning/5">
            <CardContent className="pt-6">
              <p className="text-sm text-foreground">
                <span className="font-medium">Set a username</span> in your account settings to get a clean handle like <span className="font-mono text-primary">@alice:matrix-os.com</span> instead of your user ID.
              </p>
            </CardContent>
          </Card>
        )}

        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle>Your Instance</CardTitle>
            {hasUsername && (
              <CardDescription>
                @{handle}:matrix-os.com
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {result.state === "running" || result.state === "stopped" ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={
                      result.state === "running"
                        ? "rounded-full border-success/30 bg-success/10 text-success"
                        : "rounded-full border-border bg-muted text-muted-foreground"
                    }
                  >
                    {result.state}
                  </Badge>
                </div>

                <p className="text-sm text-muted-foreground">
                  Last active: {new Date(result.data.last_active as string).toLocaleString()}
                </p>

                <a
                  href={`https://${handle}.matrix-os.com`}
                  className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  Open Matrix OS
                </a>
              </>
            ) : result.state === "not_provisioned" ? (
              <div className="space-y-3 py-4 text-center">
                <p className="text-muted-foreground">
                  No instance provisioned yet.
                </p>
                <p className="text-sm text-muted-foreground/70">
                  Your instance will be created automatically when the platform is deployed.
                </p>
              </div>
            ) : (
              <div className="space-y-3 py-4 text-center">
                <p className="text-muted-foreground">
                  Platform service is not available.
                </p>
                <p className="text-sm text-muted-foreground/70">
                  The platform hasn&apos;t been deployed yet. Check back later.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
