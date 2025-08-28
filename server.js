// server.js — DriveDen GPS v2 (Leaflet) + GI proxy (multi-endpoint search)
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const GI_BASE      = process.env.GI_BASE || "https://api.golfintelligence.com";
const GI_CLIENT_ID = process.env.GI_CLIENT_ID || "";
const GI_API_TOKEN = process.env.GI_API_TOKEN || "";
const PORT         = process.env.PORT || 8080;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "web")));

// --- simple caches to save credits ---
let accessToken = null;
let tokenExpiry = 0;
const cache = new Map();
const SEARCH_TTL_MS = 2 * 60 * 1000;
const GPS_TTL_MS    = 10 * 60 * 1000;

function setCache(k, v, ttl) { cache.set(k, { v, t: Date.now() + ttl }); }
function getCache(k) {
  const e = cache.get(k); if (!e) return null;
  if (Date.now() > e.t) { cache.delete(k); return null; }
  return e.v;
}

// === GI auth: application/x-www-form-urlencoded ===
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpiry - 10_000) return accessToken;

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("code", GI_API_TOKEN);
  params.append("client_id", GI_CLIENT_ID);

  const r = await fetch(`${GI_BASE}/auth/authenticateToken`, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GI auth failed ${r.status}: ${text}`);
  }

  const data = await r.json();
  accessToken = data?.accessToken || data?.access_token;
  const exp   = data?.expiresIn || data?.expires_in || 3300;
  tokenExpiry = now + exp * 1000;
  if (!accessToken) throw new Error("No accessToken in GI auth response");
  return accessToken;
}

// healthcheck (Railway)
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// debug: confirm auth quickly
app.get("/gi/_auth", async (_req, res) => {
  try {
    const t = await getAccessToken();
    res.json({ ok: true, tokenPreview: t ? (t.slice(0, 8) + "…") : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// search courses (multi-endpoint with GPS + ZA fallback)
app.get("/gi/courses", async (req, res) => {
  try {
    const q   = String(req.query.q || "").trim();
    const lat = req.query.lat ? Number(req.query.lat) : null;
    const lng = req.query.lng ? Number(req.query.lng) : null;

    const key = `search:${q}:${lat ?? "x"}:${lng ?? "x"}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const token = await getAccessToken();

    const fallbackGPS = { latitude: -25.746, longitude: 28.188 }; // Pretoria CBD
    const gps = (lat && lng) ? { latitude: lat, longitude: lng } : fallbackGPS;

    async function postJson(path, body) {
      const r = await fetch(`${GI_BASE}${path}`, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify(body)
      });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      if (!r.ok) {
        console.warn(`[SEARCH] ${path} -> ${r.status}`, text.slice(0, 200));
        return [];
      }
      const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
      return list || [];
    }

    const baseBody = {
      rows: 50,
      offset: 0,
      keywords: q,
      countryCode: "",
      regionCode: "",
      gpsCoordinate: gps
    };

    // 1) Try course GROUPS first
    let list = await postJson("/courses/searchCourseGroups", baseBody);

    // 2) If empty, try plain COURSES
    if (!list.length) list = await postJson("/courses/searchCourses", baseBody);

    // 3) If still empty, force ZA and retry both
    if (!list.length) {
      const zaBody = { ...baseBody, countryCode: "ZA" };
      list = await postJson("/courses/searchCourseGroups", zaBody);
      if (!list.length) list = await postJson("/courses/searchCourses", zaBody);
    }

    // 4) Optional sanity check (US)
    if (!list.length && !q.toLowerCase().includes("scottsdale")) {
      const usBody = { ...baseBody, keywords: "Scottsdale", countryCode: "US" };
      const sanity = await postJson("/courses/searchCourses", usBody);
      if (sanity.length) {
        console.warn("[SEARCH] No results for query/region; API returned data for US (coverage likely limited).");
      }
    }

    setCache(key, list, SEARCH_TTL_MS);
    return res.json(list);
  } catch (e) {
    console.error("[SEARCH] error", e);
    res.status(500).json({ error: String(e) });
  }
});

// course GPS by publicId
app.get("/gi/courses/:publicId/gps", async (req, res) => {
  try {
    const { publicId } = req.params;
    const key = `gps:${publicId}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const token = await getAccessToken();
    const r = await fetch(`${GI_BASE}/courses/getCourseGroupGPS?publicId=${encodeURIComponent(publicId)}`, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "Authorization": `Bearer ${token}`
      }
    });

    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) {
      console.error("[GPS] status", r.status, text);
      return res.status(r.status).send(text || `GPS failed (${r.status})`);
    }

    setCache(key, json, GPS_TTL_MS);
    res.json(json);
  } catch (e) {
    console.error("[GPS] error", e);
    res.status(500).json({ error: String(e) });
  }
});

// front-end
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "web", "index.html")));

// listen on 0.0.0.0 for Railway
app.listen(PORT, "0.0.0.0", () => {
  console.log(`DriveDen GPS running on port ${PORT}`);
});
