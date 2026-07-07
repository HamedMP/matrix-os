import { redirect } from "next/navigation";

type SignupAliasPageProps = {
  params: Promise<{
    signup?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignupAliasPage({ params, searchParams }: SignupAliasPageProps) {
  const segments = (await params).signup ?? [];
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
  redirect(`/sign-up${suffix}${queryString ? `?${queryString}` : ""}`);
}
