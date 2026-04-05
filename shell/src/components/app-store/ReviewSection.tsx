"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { StarRating } from "./StarRating";
import { FlagIcon, MessageSquareIcon, SendIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface Review {
  id: string;
  reviewer_id: string;
  rating: number;
  body: string | null;
  author_response: string | null;
  author_responded_at: string | null;
  flagged: boolean;
  created_at: string;
}

interface ReviewSectionProps {
  listingId: string;
  authorId: string;
  currentUserId?: string;
  isInstalled: boolean;
}

export function ReviewSection({ listingId, authorId, currentUserId, isInstalled }: ReviewSectionProps) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [distribution, setDistribution] = useState<Record<number, number>>({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  const [averageRating, setAverageRating] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitRating, setSubmitRating] = useState(5);
  const [submitBody, setSubmitBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/gallery/apps/${listingId}/reviews`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const data = await res.json();
      setReviews(data.reviews ?? []);
      setDistribution(data.distribution ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
      setAverageRating(data.averageRating ?? 0);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [listingId]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const handleSubmit = useCallback(async () => {
    if (!currentUserId) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${GATEWAY_URL}/api/gallery/apps/${listingId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: submitRating, body: submitBody || undefined }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to submit review" }));
        setError(data.error);
        return;
      }

      setSubmitBody("");
      setSubmitRating(5);
      fetchReviews();
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }, [currentUserId, listingId, submitRating, submitBody, fetchReviews]);

  const totalRatings = Object.values(distribution).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Ratings & Reviews
      </h3>

      {/* Rating summary */}
      <div className="flex items-start gap-6">
        <div className="text-center">
          <div className="text-4xl font-bold">{averageRating.toFixed(1)}</div>
          <StarRating rating={averageRating} size="md" />
          <div className="text-xs text-muted-foreground mt-1">{totalRatings} ratings</div>
        </div>

        {/* Distribution bars */}
        <div className="flex-1 space-y-1">
          {[5, 4, 3, 2, 1].map((star) => {
            const count = distribution[star] ?? 0;
            const pct = totalRatings > 0 ? (count / totalRatings) * 100 : 0;
            return (
              <div key={star} className="flex items-center gap-2 text-xs">
                <span className="w-3 text-right">{star}</span>
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-400 rounded-full transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-6 text-right text-muted-foreground">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Submit review form */}
      {currentUserId && isInstalled && (
        <div className="border border-border rounded-lg p-4 space-y-3">
          <h4 className="text-sm font-medium">Write a review</h4>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Rating:</span>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setSubmitRating(star)}
                  className={`text-lg ${star <= submitRating ? "text-amber-400" : "text-muted"}`}
                >
                  *
                </button>
              ))}
            </div>
          </div>

          <textarea
            value={submitBody}
            onChange={(e) => setSubmitBody(e.target.value)}
            placeholder="Share your experience (optional)..."
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none h-16 focus:outline-none focus:ring-1 focus:ring-ring"
          />

          {error && (
            <div className="text-xs text-destructive">{error}</div>
          )}

          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            <SendIcon className="size-3 mr-1" />
            {submitting ? "Submitting..." : "Submit Review"}
          </Button>
        </div>
      )}

      {!currentUserId && (
        <p className="text-xs text-muted-foreground">Sign in to leave a review.</p>
      )}

      {currentUserId && !isInstalled && (
        <p className="text-xs text-muted-foreground">Install this app to leave a review.</p>
      )}

      {/* Review list */}
      {loading ? (
        <div className="text-xs text-muted-foreground">Loading reviews...</div>
      ) : reviews.length === 0 ? (
        <div className="text-xs text-muted-foreground">No reviews yet. Be the first!</div>
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <ReviewItem
              key={review.id}
              review={review}
              listingId={listingId}
              isAuthor={currentUserId === authorId}
              currentUserId={currentUserId}
              onUpdated={fetchReviews}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewItem({
  review,
  listingId,
  isAuthor,
  currentUserId,
  onUpdated,
}: {
  review: Review;
  listingId: string;
  isAuthor: boolean;
  currentUserId?: string;
  onUpdated: () => void;
}) {
  const [responding, setResponding] = useState(false);
  const [responseText, setResponseText] = useState("");

  const handleRespond = async () => {
    if (!currentUserId || !responseText.trim()) return;
    try {
      await fetch(`${GATEWAY_URL}/api/gallery/apps/${listingId}/reviews/${review.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: responseText }),
      });
      setResponding(false);
      setResponseText("");
      onUpdated();
    } catch {
      // ignore
    }
  };

  const handleFlag = async () => {
    if (!currentUserId) return;
    try {
      await fetch(`${GATEWAY_URL}/api/gallery/apps/${listingId}/reviews/${review.id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      onUpdated();
    } catch {
      // ignore
    }
  };

  return (
    <div className="border-b border-border pb-4 last:border-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StarRating rating={review.rating} />
          <span className="text-xs text-muted-foreground">
            {new Date(review.created_at).toLocaleDateString()}
          </span>
        </div>
        {currentUserId && (
          <button onClick={handleFlag} className="text-muted-foreground hover:text-foreground">
            <FlagIcon className="size-3" />
          </button>
        )}
      </div>

      {review.body && (
        <p className="text-sm mt-1">{review.body}</p>
      )}

      {review.author_response && (
        <div className="mt-2 ml-4 pl-3 border-l-2 border-primary/30">
          <p className="text-xs font-medium text-primary">Developer Response</p>
          <p className="text-xs mt-0.5">{review.author_response}</p>
        </div>
      )}

      {isAuthor && !review.author_response && (
        <div className="mt-2">
          {responding ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={responseText}
                onChange={(e) => setResponseText(e.target.value)}
                placeholder="Write a response..."
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button size="sm" variant="outline" onClick={handleRespond}>
                Reply
              </Button>
            </div>
          ) : (
            <button
              onClick={() => setResponding(true)}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <MessageSquareIcon className="size-3" />
              Respond
            </button>
          )}
        </div>
      )}
    </div>
  );
}
