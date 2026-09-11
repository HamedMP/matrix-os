import { CollaborationPage } from "@/components/collaboration/CollaborationPage";

export default async function SharedProjectPage({ params }: { params: Promise<{ scopeId: string }> }) {
  const { scopeId } = await params;
  return <CollaborationPage view={{ kind: "project", scopeId }} />;
}
