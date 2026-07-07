import type { MetadataRoute } from "next";
import { source } from "@/lib/source";
import { getBlogPostUrl, getBlogPosts } from "@/lib/blog";
import { solutionPages } from "./solutions/data";

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
      url: `${BASE_URL}/contact`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/use-cases`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/solutions`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/blog`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.75,
    },
    {
      url: `${BASE_URL}/team`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/whitepaper`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];

  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${BASE_URL}/docs/${page.slugs.join("/")}`,
    lastModified: page.data.lastModified ? new Date(page.data.lastModified) : new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  const solutionSitemapPages: MetadataRoute.Sitemap = solutionPages.map((page) => ({
    url: `${BASE_URL}/solutions/${page.slug}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: 0.75,
  }));

  const blogPages: MetadataRoute.Sitemap = getBlogPosts().map((post) => ({
    url: `${BASE_URL}${getBlogPostUrl(post)}`,
    lastModified: new Date(post.updatedAt ?? post.publishedAt),
    changeFrequency: "monthly" as const,
    priority: 0.65,
  }));

  return [...staticPages, ...solutionSitemapPages, ...blogPages, ...docPages];
}
