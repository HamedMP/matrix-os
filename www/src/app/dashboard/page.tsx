import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

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
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold font-[family-name:var(--font-jetbrains)]">
            Matrix OS
          </h1>
          <p className="text-zinc-400 mt-2">
            Welcome back, {user.firstName ?? handle}
          </p>
        </div>

        <div className="border border-zinc-800 rounded-lg p-6 space-y-4">
          <h2 className="text-xl font-semibold">Your Instance</h2>

          {container ? (
            <>
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    container.status === "running"
                      ? "bg-green-500"
                      : "bg-zinc-500"
                  }`}
                />
                <span className="text-sm text-zinc-300 capitalize">
                  {container.status}
                </span>
              </div>

              <div className="text-sm text-zinc-400 space-y-1">
                <p>Handle: @{handle}:matrix-os.com</p>
                <p>Last active: {new Date(container.last_active).toLocaleString()}</p>
              </div>

              <a
                href={`https://${handle}.matrix-os.com`}
                className="inline-block bg-white text-black px-4 py-2 rounded font-medium text-sm hover:bg-zinc-200 transition-colors"
              >
                Open Matrix OS
              </a>
            </>
          ) : (
            <div className="text-zinc-400 space-y-4">
              <p>Your instance is being provisioned...</p>
              <p className="text-sm">
                This usually takes about 30 seconds. Refresh this page to check.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
