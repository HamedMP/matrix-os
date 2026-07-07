import type { Metadata } from "next";
import { redirect } from "next/navigation";

type LoginAliasPageProps = {
  params: Promise<{
    login?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = {
  title: "Log in",
  description: "Sign in to your Matrix OS account and continue to your cloud computer.",
};

export default async function LoginPage({ params, searchParams }: LoginAliasPageProps) {
  const segments = (await params).login ?? [];
  const suffix = segments.length > 0 ? `/${segments.map(encodeURIComponent).join("/")}` : "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  const queryString = query.toString();
  redirect(`/sign-in${suffix}${queryString ? `?${queryString}` : ""}`);
}
