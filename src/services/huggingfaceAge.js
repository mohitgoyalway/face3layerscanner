function stripDataUrlPrefix(base64Image) {
  if (typeof base64Image !== "string") return null;
  const m = base64Image.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
  return m ? m[1] : base64Image;
}

function parseAgeFromLabel(label) {
  if (!label || typeof label !== "string") return null;

  // Examples: "25-32", "age_30_39", "42"
  const range = label.match(/(\d{1,3})\D+(\d{1,3})/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.round((a + b) / 2);
  }

  const single = label.match(/(\d{1,3})/);
  if (single) {
    const n = Number(single[1]);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function parseAgeFromHFResponse(payload) {
  if (payload == null) return null;

  if (typeof payload === "number" && Number.isFinite(payload)) return Math.round(payload);
  if (typeof payload?.age === "number" && Number.isFinite(payload.age)) return Math.round(payload.age);

  if (Array.isArray(payload) && payload.length > 0) {
    // Classification-style output: [{ label, score }, ...]
    if (typeof payload[0] === "object" && payload[0] !== null && "label" in payload[0]) {
      const sorted = [...payload].sort((a, b) => (b.score || 0) - (a.score || 0));
      return parseAgeFromLabel(sorted[0]?.label);
    }

    // Some models may return nested arrays.
    if (Array.isArray(payload[0]) && payload[0].length > 0) {
      const top = payload[0][0];
      if (typeof top?.label === "string") return parseAgeFromLabel(top.label);
    }
  }

  return null;
}

async function estimateAgeFromFaceImage(faceImageBase64) {
  const token = process.env.HF_API_TOKEN;
  const model = process.env.HF_AGE_MODEL || "nateraw/vit-age-classifier";

  if (!token || !faceImageBase64) return null;

  const cleanBase64 = stripDataUrlPrefix(faceImageBase64);
  if (!cleanBase64) return null;

  const bytes = Buffer.from(cleanBase64, "base64");
  const url = `https://router.huggingface.co/hf-inference/models/${model}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        Accept: "application/json"
      },
      body: bytes,
      signal: controller.signal
    });

    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    let payload = null;
    if (contentType.includes("application/json")) {
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        payload = null;
      }
    }

    if (!response.ok) {
      const msg = payload?.error || raw?.slice(0, 200) || `Hugging Face error (${response.status})`;
      console.warn("HF age inference failed:", msg);
      return null;
    }

    const age = parseAgeFromHFResponse(payload);
    if (!Number.isFinite(age)) return null;

    // Guardrails for UX consistency.
    return Math.max(10, Math.min(90, age));
  } catch (error) {
    console.warn("HF age inference exception:", error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { estimateAgeFromFaceImage };
