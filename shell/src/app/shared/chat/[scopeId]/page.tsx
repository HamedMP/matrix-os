import { CollaborationPage } from "@/components/collaboration/CollaborationPage";

export default async function SharedChatPage({ params }: {
  params: Promise<{ scopeId: string }>;
}) {
  const { scopeId } = await params;
  return <CollaborationPage view={{ kind: "chat", scopeId }} />;
}
