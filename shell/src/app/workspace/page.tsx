import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SharedWorkspaceDesktop } from "@/components/workspace/SharedWorkspaceDesktop";
import { sharedWorkspaceAccess } from "./access";

export const dynamic = "force-dynamic";

export default async function SharedWorkspacePage() {
  const access = await sharedWorkspaceAccess(await headers());
  if (access.status === 404) notFound();
  if (access.status === 401) redirect("/sign-in?redirect_url=%2Fworkspace");
  if (access.status !== 200) return <p>Workspace access is temporarily unavailable. Please try again.</p>;
  // No provisioning, billing, bootstrap or compute call blocks this document.
  return <SharedWorkspaceDesktop />;
}
