// Winter Watch proxy (Cloudflare Worker)
// Lets visitors of the Winter Watch page use the owner's Anthropic key without ever seeing it.
// The key lives only in Cloudflare as the secret ANTHROPIC_API_KEY; it is never in this file or on GitHub.
//
// Safeguards
//  - Only the Winter Watch page (ALLOWED_ORIGIN) may call it (browser Origin check + CORS).
//  - Only POST /v1/messages, only the allowed model, capped max_tokens, no tools, body size limit.
//  - At most HOURLY_LIMIT questions per visitor (IP) per hour, counted in KV.
//  - The real money cap is the spend limit on the Anthropic workspace that owns the key.

const ALLOWED_ORIGIN = "https://jaydenwong15.github.io";
const ALLOWED_MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 16000;
const MAX_BODY_BYTES = 200_000;
const HOURLY_LIMIT = 20;
const ALLOWED_EFFORT = ["low", "medium"];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Expose-Headers": "x-ww-remaining",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function error(status, message, origin, extra = {}) {
  return new Response(JSON.stringify({ error: { type: "proxy_error", message } }), {
    status,
    headers: { "content-type": "application/json", ...cors(origin), ...extra }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (origin !== ALLOWED_ORIGIN) return error(403, "This service only answers the Winter Watch page.", origin);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") return error(404, "Not found.", origin);
    if (!env.ANTHROPIC_API_KEY) return error(503, "The shared key has not been set up yet. Use your own key in Settings.", origin);

    // Read and check the body
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return error(413, "Request too large.", origin);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return error(400, "Invalid JSON.", origin); }
    if (body.model !== ALLOWED_MODEL) return error(400, `Only ${ALLOWED_MODEL} is allowed through the shared key.`, origin);
    if (!Array.isArray(body.messages) || body.messages.length === 0) return error(400, "No messages.", origin);
    const effort = body.output_config && body.output_config.effort;
    if (effort && !ALLOWED_EFFORT.includes(effort)) return error(400, "Effort must be low or medium.", origin);

    // Rate limit: HOURLY_LIMIT per visitor per clock hour
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const hour = Math.floor(Date.now() / 3_600_000);
    const rlKey = `rl:${ip}:${hour}`;
    const used = parseInt((await env.RATE.get(rlKey)) || "0", 10);
    if (used >= HOURLY_LIMIT) {
      return error(429, `Hourly limit reached (${HOURLY_LIMIT} questions per visitor per hour). Try again later, or use your own API key in Settings.`, origin, { "x-ww-remaining": "0" });
    }
    await env.RATE.put(rlKey, String(used + 1), { expirationTtl: 7200 });

    // Forward only the fields the page uses (no tools, no other models)
    const forward = {
      model: ALLOWED_MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
      system: body.system,
      messages: body.messages
    };
    if (body.output_config) {
      forward.output_config = {};
      if (effort) forward.output_config.effort = effort;
      if (body.output_config.format) forward.output_config.format = body.output_config.format;
    }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(forward)
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "x-ww-remaining": String(HOURLY_LIMIT - used - 1),
        ...cors(origin)
      }
    });
  }
};
