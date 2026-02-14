import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AdminDashboard } from "./admin-dashboard";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";

async function getContainers() {
  try {
    const res = await fetch(`${PLATFORM_API_URL}/containers`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const metadata = user.publicMetadata as Record<string, unknown>;
  if (metadata?.role !== "admin") {
    redirect("/dashboard");
  }

  const containers = await getContainers();

  return <AdminDashboard containers={containers} apiUrl={PLATFORM_API_URL} />;
}
