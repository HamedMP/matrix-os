import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { provisionUser } from "@/inngest/provision-user";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [provisionUser],
});
