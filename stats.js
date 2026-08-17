// GET /api/stats
// Returns the public aggregate. Cached for 60 seconds at the edge, so a million
// page views cost about 1,440 Redis reads a day instead of a million.

const DAYS = 14;

async function redis(cmds) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !tok) throw new Error("Redis env vars are missing");
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map((x) => x.result);
}

const dayKeys = () => {
  const out = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

// Upstash returns hashes as a flat array: [field, value, field, value, ...]
const toObj = (flat) => {
  const o = {};
  if (!Array.isArray(flat)) return o;
  for (let i = 0; i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]) || 0;
  return o;
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  try {
    const keys = dayKeys();
    const cmds = [["HGETALL", "dbi:agg"]].concat(keys.map((k) => ["HGETALL", "dbi:day:" + k]));
    const out = await redis(cmds);
    const agg = toObj(out[0]);

    const days = {};
    keys.forEach((k, i) => {
      const d = toObj(out[i + 1]);
      if (d.n > 0) days[k] = { n: d.n, sD: d.sD, sC: d.sC, sR: d.sR, sB: d.sB };
    });

    res.status(200).json({
      n: agg.n || 0,
      sD: agg.sD || 0, sC: agg.sC || 0, sR: agg.sR || 0,
      sB: agg.sB || 0, sDe: agg.sDe || 0, sG: agg.sG || 0,
      hist: Array.from({ length: 10 }, (_, i) => agg["h" + i] || 0),
      days,
    });
  } catch (e) {
    res.status(200).json({ n: 0, sD: 0, sC: 0, sR: 0, sB: 0, sDe: 0, sG: 0,
      hist: new Array(10).fill(0), days: {}, error: "index unavailable" });
  }
}
