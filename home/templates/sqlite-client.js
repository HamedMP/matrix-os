// SQLite client for Matrix OS apps
// Copy this into your app to use the bridge SQL API

const SQL_API = "/api/bridge/sql";

export async function query(appName, sql, params = []) {
  const res = await fetch(SQL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appName, action: "query", sql, params }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function run(appName, sql, params = []) {
  const res = await fetch(SQL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appName, action: "run", sql, params }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function get(appName, sql, params = []) {
  const result = await query(appName, sql, params);
  return result.rows[0] ?? null;
}
