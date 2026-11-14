import { Suspense } from "react";
import { RoutineFullAccessCompletion } from "@/components/auth/RoutineFullAccessCompletion";
export default function Page() { return <Suspense fallback={<p>Loading routine CLI access…</p>}><RoutineFullAccessCompletion/></Suspense>; }
