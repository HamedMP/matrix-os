import type { MetadataRoute } from "next";
import { source } from "@/lib/source";

const BASE_URL = "https://matrix-os.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE_URL}/whitepaper`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];

  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${BASE_URL}/docs/${page.slugs.join("/")}`,
    lastModified: page.data.lastModified ? new Date(page.data.lastModified) : new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  return [...staticPages, ...docPages];
}
