// One endpoint for everything. CommonJS, so no package.json is needed.
//
//   GET  /api/dbi            the public aggregate
//   GET  /api/dbi?health=1   plain language diagnosis of what is wrong
//   POST /api/dbi            file a report, body { "answers": [20 numbers] }

const V = [0, 33, 67, 100];
const WINDOW = 86400;
const DAYS = 14;

const env = () => ({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  tok: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

async function redis(cmds) {
  const { url, tok } = env();
  if (!url || !tok) throw new Error("no database connected");
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("database returned " + r.status);
  return (await r.json()).map(function (x) { return x.result; });
}

function erf(z) {
  const s = z < 0 ? -1 : 1; z = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * z);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z));
}
const CDF = function (r) { return 0.5 * (1 + erf((r - 50) / 15 / Math.SQRT2)); };
const C0 = CDF(0), C1 = CDF(100);
const cal = function (r) { return Math.max(0, Math.min(100, ((CDF(r) - C0) / (C1 - C0)) * 100)); };

function score(a) {
  const m = function (x) { return x.reduce(function (p, q) { return p + q; }, 0) / x.length; };
  const read = m(a.slice(0, 7)), balls = m(a.slice(7, 15)), degen = m(a.slice(15, 20));
  const dbi = 0.7 * read + 0.2 * balls + 0.1 * degen;
  return { read: read, balls: balls, degen: degen, dbi: dbi, c: cal(dbi), gap: Math.abs(balls - (100 - read)) };
}

function toObj(flat) {
  const o = {};
  if (!Array.isArray(flat)) return o;
  for (let i = 0; i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]) || 0;
  return o;
}
function dayKeys() {
  const out = [];
  for (let i = DAYS - 1; i >= 0; i--)
    out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  return out;
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || "{}"); } catch (e) { return {}; }
}

module.exports = async function handler(req, res) {
  const wantsHealth = String(req.url || "").indexOf("health") > -1;

  // ---------- health ----------
  if (req.method === "GET" && wantsHealth) {
    res.setHeader("Cache-Control", "no-store");
    const e = env();
    const out = {
      ok: false,
      endpointReached: true,
      node: process.version,
      databaseUrlFound: !!e.url,
      databaseTokenFound: !!e.tok,
      matchingEnvNames: Object.keys(process.env).filter(function (k) {
        return /UPSTASH|REDIS|KV_/i.test(k);
      }).sort(),
      database: "not tested",
      reportsFiled: null,
      whatToDo: null,
    };
    if (!e.url || !e.tok) {
      out.whatToDo = "No database is connected. In Vercel open this project, go to Storage, "
        + "create an Upstash for Redis database, connect it to the project, then open "
        + "Deployments and redeploy the newest one.";
      return res.status(200).json(out);
    }
    try {
      const r = await redis([["PING"], ["HGET", "dbi:agg", "n"]]);
      out.database = "connected";
      out.reportsFiled = Number(r[1]) || 0;
      out.ok = true;
      out.whatToDo = out.reportsFiled === 0
        ? "Everything is wired up. Take the test once, then reload this page and the count will move."
        : "Everything is working.";
    } catch (err) {
      out.database = String(err.message);
      out.whatToDo = /401|403/.test(err.message)
        ? "The token is stale. In Vercel Storage disconnect the database, connect it again, then redeploy."
        : "The database address is set but did not answer. Redeploy, and if it keeps failing recreate the database.";
    }
    return res.status(200).json(out);
  }

  // ---------- file a report ----------
  if (req.method === "POST") {
    res.setHeader("Cache-Control", "no-store");
    const body = await readBody(req);
    const a = body.answers;
    if (!Array.isArray(a) || a.length !== 20 || !a.every(function (x) { return V.indexOf(x) > -1; }))
      return res.status(400).json({ error: "Twenty answers required, each 0, 33, 67 or 100" });

    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || req.headers["x-real-ip"] || "unknown";
    try {
      const claimed = await redis([["SET", "dbi:rl:" + ip, "1", "NX", "EX", String(WINDOW)]]);
      if (claimed[0] === null)
        return res.status(429).json({ error: "One report per day, come back tomorrow" });

      const s = score(a);
      const bucket = Math.max(0, Math.min(9, Math.floor(s.c / 10)));
      const dk = "dbi:day:" + new Date().toISOString().slice(0, 10);
      const out = await redis([
        ["HINCRBY", "dbi:agg", "n", "1"],
        ["HINCRBYFLOAT", "dbi:agg", "sD", String(s.dbi)],
        ["HINCRBYFLOAT", "dbi:agg", "sC", String(s.c)],
        ["HINCRBYFLOAT", "dbi:agg", "sR", String(s.read)],
        ["HINCRBYFLOAT", "dbi:agg", "sB", String(s.balls)],
        ["HINCRBYFLOAT", "dbi:agg", "sDe", String(s.degen)],
        ["HINCRBYFLOAT", "dbi:agg", "sG", String(s.gap)],
        ["HINCRBY", "dbi:agg", "h" + bucket, "1"],
        ["HINCRBY", dk, "n", "1"],
        ["HINCRBYFLOAT", dk, "sD", String(s.dbi)],
        ["HINCRBYFLOAT", dk, "sC", String(s.c)],
        ["HINCRBYFLOAT", dk, "sR", String(s.read)],
        ["HINCRBYFLOAT", dk, "sB", String(s.balls)],
        ["EXPIRE", dk, String(86400 * 90)],
      ]);
      return res.status(200).json({ no: Number(out[0]) || 1, you: s });
    } catch (err) {
      return res.status(503).json({ error: "The index is not reachable right now" });
    }
  }

  // ---------- the public aggregate ----------
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    try {
      const keys = dayKeys();
      const cmds = [["HGETALL", "dbi:agg"]].concat(keys.map(function (k) {
        return ["HGETALL", "dbi:day:" + k];
      }));
      const out = await redis(cmds);
      const agg = toObj(out[0]);
      const days = {};
      keys.forEach(function (k, i) {
        const d = toObj(out[i + 1]);
        if (d.n > 0) days[k] = { n: d.n, sD: d.sD, sC: d.sC, sR: d.sR, sB: d.sB };
      });
      const hist = [];
      for (let i = 0; i < 10; i++) hist.push(agg["h" + i] || 0);
      return res.status(200).json({
        n: agg.n || 0, sD: agg.sD || 0, sC: agg.sC || 0, sR: agg.sR || 0,
        sB: agg.sB || 0, sDe: agg.sDe || 0, sG: agg.sG || 0,
        hist: hist, days: days,
      });
    } catch (err) {
      res.setHeader("Cache-Control", "no-store");
      const empty = [];
      for (let i = 0; i < 10; i++) empty.push(0);
      return res.status(200).json({
        n: 0, sD: 0, sC: 0, sR: 0, sB: 0, sDe: 0, sG: 0,
        hist: empty, days: {}, error: String(err.message),
      });
    }
  }

  return res.status(405).json({ error: "GET or POST only" });
};
