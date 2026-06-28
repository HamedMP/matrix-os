import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Log in",
  description: "Sign in to your Matrix OS account and continue to your cloud computer.",
};

export default function LoginPage() {
  redirect("/sign-in");
}
