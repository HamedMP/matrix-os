import { CollaborationIdSchema } from "@matrix-os/contracts";
import { notFound } from "next/navigation";
import { CollaborationFrame } from "@/components/collaboration/CollaborationFrame";
import { CollaborationPage } from "@/components/collaboration/CollaborationPage";
import { isPlatformShellSurface } from "@/lib/shell-surface";

export default async function SharedProjectPage({ params }: { params: Promise<{ scopeId: string }> }) {
  const result = CollaborationIdSchema.safeParse((await params).scopeId);
  if (!result.success) notFound();
  const scopeId = result.data;
  if (await isPlatformShellSurface()) return <CollaborationFrame view={{ kind: "project", scopeId }} />;
  return <CollaborationPage view={{ kind: "project", scopeId }} />;
}
