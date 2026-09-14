import { CollaborationPage } from "@/components/collaboration/CollaborationPage";

export default async function SharedInvitationPage({ params }: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  return <CollaborationPage view={{ kind: "invitation", invitationId }} />;
}
