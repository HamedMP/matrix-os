import type { MetadataRoute } from "next";

const BASE_URL = "https://matrix-os.com";

const docSlugs = [
  "",
  "guide",
  "guide/getting-started",
  "guide/agents",
  "guide/channels",
  "guide/apps",
  "guide/file-system",
  "guide/storage",
  "guide/social",
  "guide/app-store",
  "guide/design-system",
  "developer",
  "developer/architecture",
  "developer/contributing",
  "developer/testing",
  "developer/ipc-tools",
  "developer/logging",
  "developer/skills",
];

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

  const docPages: MetadataRoute.Sitemap = docSlugs.map((slug) => ({
    url: slug ? `${BASE_URL}/docs/${slug}` : `${BASE_URL}/docs`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: slug === "" ? 0.9 : 0.7,
  }));

  return [...staticPages, ...docPages];
}
