// GET /api/health
// Open this in a browser to find out exactly what is broken.
// It never prints a token, only whether one was found.

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  const out = {
    ok: false,
    node: process.version,
    modulesLoad: true,
    redisUrlFound: !!url,
    redisTokenFound: !!tok,
    matchingEnvNames: Object.keys(process.env).filter((k) => /UPSTASH|REDIS|KV_/i.test(k)).sort(),
    redis: "not tested",
    reportsFiled: null,
    fix: null,
  };

  if (!url || !tok) {
    out.fix =
      "No database is connected. In Vercel open the project, go to Storage, " +
      "create an Upstash for Redis database, connect it to this project, then " +
      "go to Deployments and redeploy the latest one.";
    return res.status(200).json(out);
  }

  try {
    const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify([["PING"], ["HGET", "dbi:agg", "n"]]),
    });
    if (!r.ok) {
      out.redis = "rejected with status " + r.status;
      out.fix =
        r.status === 401
          ? "The token is wrong. Disconnect the database in Vercel Storage, reconnect it, then redeploy."
          : "The database refused the request. Check that it is still running in Upstash.";
      return res.status(200).json(out);
    }
    const body = await r.json();
    out.redis = "connected";
    out.reportsFiled = Number(body[1] && body[1].result) || 0;
    out.ok = true;
    out.fix =
      out.reportsFiled === 0
        ? "Everything is wired up correctly. No reports have been filed yet, so take the test once and reload this page."
        : null;
    return res.status(200).json(out);
  } catch (e) {
    out.redis = "unreachable";
    out.fix = "The database address is set but could not be reached. Redeploy, and if it persists recreate the database.";
    return res.status(200).json(out);
  }
}
