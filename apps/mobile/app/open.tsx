import { Redirect, useLocalSearchParams } from "expo-router";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
/** Always enter the existing sign-in/journey gate; this route grants no access. */
export default function MessagingHandoff() {
  const params = useLocalSearchParams();
  const chat = CanonicalChatIdSchema.safeParse(params.chat);
  return (
    <Redirect
      href={chat.success ? { pathname: "/", params: { chat: chat.data } } : "/"}
    />
  );
}
