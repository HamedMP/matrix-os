import { Suspense } from "react";
import { RoutineActionCompletion } from "@/components/auth/RoutineActionCompletion";
export default function Page() { return <Suspense fallback={<p>Loading confirmation…</p>}><RoutineActionCompletion/></Suspense>; }
