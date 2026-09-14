import type { ServiceDefinition } from "./types.js";

const X_ID_PATTERN = "^[0-9]{1,19}$";
const X_USERNAME_PATTERN = "^[A-Za-z0-9_]{1,15}$";
const X_POST_FIELDS = "author_id,conversation_id,created_at,lang,public_metrics,referenced_tweets";
const X_USER_FIELDS = "created_at,description,location,profile_image_url,protected,public_metrics,url,verified";

function cappedPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export const X_SERVICE_REGISTRY: Record<string, ServiceDefinition> = {
  twitter: {
    // Pipedream retains `twitter` as the connector slug even though the
    // provider and user-facing product name are now X. Keeping the registry
    // ID aligned with that slug lets webhook and account-sync payloads map to
    // this definition without a second alias layer.
    id: "twitter",
    name: "X",
    category: "social",
    connectorKind: "pipedream",
    pipedreamApp: "twitter",
    icon: "x",
    logoUrl: "/integration-logos/x.svg",
    actions: {
      get_authenticated_user: {
        description: "Get the connected X account profile",
        risk: "read",
        params: {},
        directApi: {
          method: "GET",
          url: "https://api.x.com/2/users/me",
          mapParams: () => ({ "user.fields": X_USER_FIELDS }),
        },
      },
      get_user_by_username: {
        description: "Get an X user profile by username",
        risk: "read",
        params: {
          username: {
            type: "string",
            required: true,
            pattern: X_USERNAME_PATTERN,
            patternMessage: "must be a valid X username without @",
          },
        },
        directApi: {
          method: "GET",
          url: (params) => `https://api.x.com/2/users/by/username/${encodeURIComponent(String(params.username))}`,
          mapParams: () => ({ "user.fields": X_USER_FIELDS }),
        },
      },
      list_user_posts: {
        description: "List recent posts authored by an X user ID",
        risk: "read",
        params: {
          userId: {
            type: "string",
            required: true,
            pattern: X_ID_PATTERN,
            patternMessage: "must be a 1-19 digit X user ID",
          },
          maxResults: { type: "number", minimum: 5, maximum: 100 },
        },
        directApi: {
          method: "GET",
          url: (params) => `https://api.x.com/2/users/${encodeURIComponent(String(params.userId))}/tweets`,
          mapParams: (params) => ({
            max_results: String(cappedPositiveInt(params.maxResults, 10, 100)),
            "tweet.fields": X_POST_FIELDS,
          }),
        },
      },
      search_recent_posts: {
        description: "Search X posts from the last seven days",
        risk: "read",
        params: {
          // Recent search accepts 512 characters for self-serve accounts.
          // Enterprise supports more, but the managed action targets the
          // capability shared by every X developer account.
          query: { type: "string", required: true, minLength: 1, maxLength: 512 },
          maxResults: { type: "number", minimum: 10, maximum: 100 },
          nextToken: { type: "string", minLength: 1, maxLength: 1024 },
        },
        directApi: {
          method: "GET",
          url: "https://api.x.com/2/tweets/search/recent",
          mapParams: (params) => ({
            query: String(params.query),
            max_results: String(cappedPositiveInt(params.maxResults, 10, 100)),
            ...(params.nextToken ? { next_token: String(params.nextToken) } : {}),
            "tweet.fields": X_POST_FIELDS,
            expansions: "author_id",
            "user.fields": "name,profile_image_url,username,verified",
          }),
        },
      },
      create_post: {
        description: "Publish a text post or reply from the connected X account",
        risk: "write",
        params: {
          text: { type: "string", required: true, minLength: 1, maxLength: 25_000 },
          replyToPostId: {
            type: "string",
            pattern: X_ID_PATTERN,
            patternMessage: "must be a 1-19 digit X post ID",
          },
        },
        directApi: {
          method: "POST",
          url: "https://api.x.com/2/tweets",
          mapBody: (params) => ({
            text: String(params.text),
            ...(params.replyToPostId
              ? { reply: { in_reply_to_tweet_id: String(params.replyToPostId) } }
              : {}),
          }),
        },
      },
    },
  },
};
