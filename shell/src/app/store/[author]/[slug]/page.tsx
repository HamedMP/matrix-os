import { notFound } from "next/navigation";
import { SecurityBadge } from "@/components/app-store/SecurityBadge";

interface StoreListingPageProps {
  params: Promise<{ author: string; slug: string }>;
}

async function fetchListing(author: string, slug: string) {
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${gatewayUrl}/api/gallery/apps/${author}/${slug}`, {
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function StoreListingPage({ params }: StoreListingPageProps) {
  const { author, slug } = await params;
  const listing = await fetchListing(author, slug);

  if (!listing) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-start gap-6 mb-8">
          <div
            className="flex size-24 shrink-0 items-center justify-center rounded-[24px] text-4xl shadow-lg"
            style={{ backgroundColor: "#6b7280" }}
          >
            <span className="text-white font-bold">{listing.name.charAt(0)}</span>
          </div>

          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold">{listing.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">{listing.category}</p>

            <div className="flex items-center gap-4 mt-3">
              {listing.avg_rating && Number(listing.avg_rating) > 0 && (
                <div className="text-sm">
                  <span className="font-medium">{Number(listing.avg_rating).toFixed(1)}</span>
                  <span className="text-muted-foreground"> ({listing.ratings_count} ratings)</span>
                </div>
              )}
              {listing.installs_count > 0 && (
                <div className="text-sm text-muted-foreground">
                  {listing.installs_count} installs
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Description */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Description
          </h2>
          <p className="text-sm leading-relaxed">
            {listing.long_description ?? listing.description ?? "No description provided."}
          </p>
        </section>

        {/* Screenshots */}
        {listing.screenshots && listing.screenshots.length > 0 && (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Screenshots
            </h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {listing.screenshots.map((url: string, i: number) => (
                <img
                  key={i}
                  src={url}
                  alt={`Screenshot ${i + 1}`}
                  className="h-48 rounded-lg border border-border object-cover"
                />
              ))}
            </div>
          </section>
        )}

        {/* Details grid */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Details
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <DetailItem label="Version" value={listing.version ?? "1.0.0"} />
            <DetailItem label="Category" value={listing.category} />
            <DetailItem label="Visibility" value={listing.visibility} />
            <DetailItem label="Price" value={listing.price === 0 ? "Free" : `${listing.price} credits`} />
          </div>
        </section>

        {/* Permissions */}
        {listing.permissions && listing.permissions.length > 0 && (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Permissions
            </h2>
            <ul className="space-y-1">
              {listing.permissions.map((perm: string) => (
                <li key={perm} className="text-sm flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-green-500" />
                  {perm}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Tags */}
        {listing.tags && listing.tags.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Tags
            </h2>
            <div className="flex flex-wrap gap-2">
              {listing.tags.map((tag: string) => (
                <span
                  key={tag}
                  className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm font-medium mt-0.5 capitalize">{value}</p>
    </div>
  );
}
