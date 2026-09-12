import { CollaborationPage } from "@/components/collaboration/CollaborationPage";

export default async function SharedTerminalPage({ params }: {
  params: Promise<{ scopeId: string }>;
}) {
  const { scopeId } = await params;
  return <CollaborationPage view={{ kind: "terminal", scopeId }} />;
}
