// Nova AI chat backend.
//
// The original Hugging Face Space loaded a 27B model onto a GPU with Python/Gradio,
// which Netlify can't host. This server sends the conversation to a hosted model through
// Netlify AI Gateway instead (no GPU, no API key) and streams the reply back
// to the page as newline-delimited JSON events:
//   {"type":"think","text":"..."}   reasoning tokens (when reasoning is on)
//   {"type":"text","text":"..."}    answer tokens
//   {"type":"done","truncated":bool}
//   {"type":"error","message":"..."}
import OpenAI from "openai";

// Netlify injects the AI Gateway credentials and base URL; the default constructor picks them up.
const openai = new OpenAI();

// Models the page may request. Anything else is rejected.
const MODELS = {
  "qwen/qwen3.8-27b": { label: "Qwen3.8 27B", reasoning: true },
  "qwen/qwen3-vl-235b-a22b-instruct": { label: "Qwen3 VL 235B (vision)", reasoning: false },
  "gpt-5.4-mini": { label: "GPT-5.4 mini", reasoning: false },
};
const DEFAULT_MODEL = "qwen/qwen3.8-27b";

// Mirrors the original app: 1024 new tokens per turn, Qwen's recommended sampling.
const MAX_NEW_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 40;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const SYSTEM_PROMPT =
  "You are Nova, a helpful, knowledgeable and direct AI assistant. Answer clearly, " +
  "use Markdown for structure and code, and say so when you are unsure.";

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// Accept only the message shapes the page sends: text, plus data-URL images.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw.slice(-MAX_HISTORY_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content) || m.role !== "user") continue;
    const parts = [];
    for (const p of m.content) {
      if (p?.type === "text" && typeof p.text === "string" && p.text) {
        parts.push({ type: "text", text: p.text });
      } else if (
        p?.type === "image_url" &&
        typeof p.image_url?.url === "string" &&
        /^data:image\/(png|jpeg|webp|gif);base64,/.test(p.image_url.url)
      ) {
        parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
      }
    }
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out.length && out[out.length - 1].role === "user" ? out : null;
}

async function chat(req) {
  if (req.method !== "POST") {
    return Response.json({ error: "Use POST" }, { status: 405, headers: { Allow: "POST" } });
  }
  const length = Number(req.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) {
    return Response.json({ error: "Request too large — attach fewer or smaller files." }, { status: 413 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages) {
    return Response.json({ error: "Nothing to send — type a message or attach a file." }, { status: 400 });
  }
  const model = MODELS[body.model] ? body.model : DEFAULT_MODEL;
  const effort = ["off", "low", "medium", "high"].includes(body.reasoning) ? body.reasoning : "off";

  const params = {
    model,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    stream: true,
  };
  if (model.startsWith("gpt-")) {
    params.max_completion_tokens = MAX_NEW_TOKENS * 2;
  } else {
    params.max_tokens = MAX_NEW_TOKENS;
    params.temperature = clamp(body.temperature, 0, 2, 1.0);
    params.top_p = clamp(body.top_p, 0, 1, 0.95);
    params.top_k = Math.round(clamp(body.top_k, 1, 100, 20));
  }
  if (MODELS[model].reasoning) {
    // OpenRouter-style reasoning control, passed through by AI Gateway.
    params.reasoning = effort === "off" ? { enabled: false } : { effort };
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        let completion;
        try {
          completion = await openai.chat.completions.create(params, { signal: req.signal });
        } catch (err) {
          // If the provider rejects the optional knobs (reasoning control, top_k),
          // retry once with only the standard OpenAI parameters.
          if (err?.status !== 400 || !("reasoning" in params || "top_k" in params)) throw err;
          const { reasoning, top_k, ...basic } = params;
          completion = await openai.chat.completions.create(basic, { signal: req.signal });
        }
        let finish = null;
        for await (const chunk of completion) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const d = choice.delta ?? {};
          const thought = d.reasoning ?? d.reasoning_content;
          if (thought) send({ type: "think", text: thought });
          if (d.content) send({ type: "text", text: d.content });
          if (choice.finish_reason) finish = choice.finish_reason;
        }
        send({ type: "done", truncated: finish === "length" });
      } catch (err) {
        if (!req.signal.aborted) {
          console.error("chat failed:", err?.status, err?.message);
          send({ type: "error", message: friendlyError(err) });
        }
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function friendlyError(err) {
  if (err?.status === 429) return "The model is busy (rate limited). Wait a few seconds and try again.";
  if (err?.status === 400) return "The model rejected this request. If you attached an image, try a vision model.";
  return "Generation failed. Please try again.";
}

export default async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/api/chat") return chat(req);
  if (pathname === "/api/models") {
    return Response.json({
      default: DEFAULT_MODEL,
      models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })),
    });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
};

export const config = { path: "/api/*" };
