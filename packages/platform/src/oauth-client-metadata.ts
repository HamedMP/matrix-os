/** Fixed Matrix origin: request Host headers never select an OAuth client identity. */
export const MATRIX_OAUTH_CLIENT_METADATA_URL = "https://app.matrix-os.com/api/mcp-servers/oauth/client-metadata";
export const MATRIX_OAUTH_CLIENT_METADATA = Object.freeze({
  client_id: MATRIX_OAUTH_CLIENT_METADATA_URL,
  client_name: "Matrix OS",
  client_uri: "https://matrix-os.com",
  redirect_uris: ["https://app.matrix-os.com/api/mcp-servers/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});
