import { Hono } from "hono";

const syncApp = new Hono();

// Stub routes -- implementation in subsequent phases
syncApp.get("/manifest", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.post("/presign", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.post("/commit", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.get("/status", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.post("/resolve-conflict", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.post("/share", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.delete("/share", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.post("/share/accept", (c) => c.json({ error: "Not implemented" }, 501));
syncApp.get("/shares", (c) => c.json({ error: "Not implemented" }, 501));

export { syncApp };
