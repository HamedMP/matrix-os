import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";

async function getContainerInfo(handle: string) {
  try {
    const res = await fetch(`${PLATFORM_API_URL}/containers/${handle}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const handle = user.username ?? user.id;
  const container = await getContainerInfo(handle);

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

        <Card className="rounded-xl shadow-sm">
          <CardHeader>
            <CardTitle>Your Instance</CardTitle>
            <CardDescription>
              @{handle}:matrix-os.com
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {container ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={
                      container.status === "running"
                        ? "rounded-full border-success/30 bg-success/10 text-success"
                        : "rounded-full border-border bg-muted text-muted-foreground"
                    }
                  >
                    {container.status}
                  </Badge>
                </div>

                <p className="text-sm text-muted-foreground">
                  Last active: {new Date(container.last_active).toLocaleString()}
                </p>

                <a
                  href={`https://${handle}.matrix-os.com`}
                  className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  Open Matrix OS
                </a>
              </>
            ) : (
              <div className="space-y-3 py-4 text-center">
                <p className="text-muted-foreground">
                  Your instance is being provisioned...
                </p>
                <p className="text-sm text-muted-foreground/70">
                  This usually takes about 30 seconds. Refresh to check.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
