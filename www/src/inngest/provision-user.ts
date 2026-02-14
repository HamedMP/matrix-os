import { inngest } from "./client";

const PLATFORM_API_URL = process.env.PLATFORM_API_URL ?? "https://api.matrix-os.com";

export const provisionUser = inngest.createFunction(
  { id: "provision-matrix-os" },
  { event: "clerk/user.created" },
  async ({ event, step }) => {
    const user = event.data;
    const handle = user.username ?? user.id;

    await step.run("provision-container", async () => {
      const res = await fetch(`${PLATFORM_API_URL}/containers/provision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, clerkUserId: user.id }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Provision failed: ${res.status} ${body}`);
      }

      return await res.json();
    });

    await step.sleep("wait-for-boot", "10s");

    await step.run("verify-running", async () => {
      const res = await fetch(`${PLATFORM_API_URL}/containers/${handle}`);
      if (!res.ok) throw new Error("Container not found after provision");
      const info = await res.json();
      return { status: info.status };
    });
  },
);
