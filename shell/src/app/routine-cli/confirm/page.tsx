import { connection } from "next/server";
import { Suspense } from "react";
import { RoutineActionCompletion } from "@/components/auth/RoutineActionCompletion";
export default async function Page() {
  // The root layout picks Clerk or the self-hosted identity from the runtime
  // MATRIX_SELF_HOSTED setting, so this page must not be prerendered at build time.
  await connection();
  return <Suspense fallback={<p>Loading confirmation…</p>}><RoutineActionCompletion/></Suspense>;
}
