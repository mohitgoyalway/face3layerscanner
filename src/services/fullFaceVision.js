const PILLAR_NAMES = [
  "Oil_Balance",
  "Breakouts_Skin_Calmness",
  "Evenness_Marks",
  "Skin_Strength_Sensitivity",
  "Smoothness_Pore_Look",
  "Firmness_Fine_Lines"
];

const EMPTY_PILLARS = Object.fromEntries(PILLAR_NAMES.map(name => [name, null]));

const STATE_OPTIONS = {
  Oil_Balance: ["Fresh & Balanced", "Slightly Oily", "Oil-Prone", "Very Oily", "Shine & Congestion Heavy"],
  Breakouts_Skin_Calmness: ["Clear & Calm", "Occasional Pimples", "Flare-Prone", "Frequent Breakouts", "Highly Reactive"],
  Evenness_Marks: ["Even & Bright", "Mild Marks", "Uneven Tone", "Stubborn Dark Spots", "Heavy Mark Memory"],
  Skin_Strength_Sensitivity: ["Strong & Resilient", "Slightly Sensitive", "Easily Irritated", "Weak & Reactive", "Highly Sensitive"],
  Smoothness_Pore_Look: ["Smooth & Refined", "Mild Texture", "Visible Pores", "Rough & Uneven", "Deep Texture Concerns"],
  Firmness_Fine_Lines: ["Firm & Youthful", "Early Fine Lines", "Mild Firmness Drop", "Visible Aging Signs", "Advanced Firmness Loss"]
};

const REGION_VALUES = ["forehead", "nose", "chin", "left_cheek", "right_cheek", "jawline", "full_face"];

function unavailable(reason) {
  return {
    available: false,
    label: "Diagnosis 2: Full-Face AI Review",
    data_source: "full_face_openai_vision",
    confidence: 0,
    demographics: { age: 35, gender: "female" },
    pillars: EMPTY_PILLARS,
    dermatology_summary: {
      primary_finding: "Full-face AI review unavailable",
      clinical_standard: "Visible full-face skin signal review",
      professional_grade: "Unavailable"
    },
    analysis_warnings: [reason]
  };
}

function stripDataUrlPrefix(base64Image) {
  if (typeof base64Image !== "string") return null;
  const trimmed = base64Image.trim();
  return trimmed.startsWith("data:image/") ? trimmed : `data:image/jpeg;base64,${trimmed}`;
}

function clampInt(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampIntWithDefault(value, fallback, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, 260);
}

function normalizePillar(name, pillar) {
  if (!pillar || typeof pillar !== "object") return null;
  const score = clampInt(pillar.score);
  const state = STATE_OPTIONS[name].includes(pillar.state)
    ? pillar.state
    : STATE_OPTIONS[name][Math.min(STATE_OPTIONS[name].length - 1, Math.floor((100 - score) / 20))];
  const driver = REGION_VALUES.includes(pillar.driver_region) ? pillar.driver_region : "full_face";

  return {
    score,
    state,
    driver_region: driver,
    evidence_signals: Array.isArray(pillar.evidence_signals)
      ? pillar.evidence_signals.map(v => cleanText(v)).filter(Boolean).slice(0, 5)
      : ["full_face_visible_review"],
    insight: cleanText(pillar.insight, "Visible full-face signals were reviewed conservatively.")
  };
}

function normalizeVisionResult(payload) {
  const pillars = {};
  PILLAR_NAMES.forEach(name => {
    pillars[name] = normalizePillar(name, payload?.pillars?.[name]);
  });

  const confidence = clampInt(payload?.confidence, 5, 92);
  const summary = payload?.dermatology_summary || {};
  return {
    available: true,
    label: "Diagnosis 2: Full-Face AI Review",
    data_source: "full_face_openai_vision",
    confidence,
    demographics: {
      age: clampIntWithDefault(payload?.demographics?.age, 35, 10, 90),
      gender: ["male", "female"].includes(payload?.demographics?.gender) ? payload.demographics.gender : "female"
    },
    pillars,
    dermatology_summary: {
      primary_finding: cleanText(summary.primary_finding, "Full-face visible skin signal review"),
      clinical_standard: "Visible full-face skin signal review",
      professional_grade: "AI full-face image review"
    },
    analysis_warnings: [
      "Diagnosis 2 is generated from the single full-face stabilization image only.",
      "This is an AI visible-signal review, not a medical diagnosis."
    ]
  };
}

function getSchema() {
  const pillarSchema = {
    type: "object",
    additionalProperties: false,
    required: ["score", "state", "driver_region", "evidence_signals", "insight"],
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      state: { type: "string" },
      driver_region: { type: "string", enum: REGION_VALUES },
      evidence_signals: {
        type: "array",
        maxItems: 5,
        items: { type: "string" }
      },
      insight: { type: "string", maxLength: 260 }
    }
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["confidence", "demographics", "pillars", "dermatology_summary"],
    properties: {
      confidence: { type: "integer", minimum: 5, maximum: 92 },
      demographics: {
        type: "object",
        additionalProperties: false,
        required: ["age", "gender"],
        properties: {
          age: { type: "integer", minimum: 10, maximum: 90 },
          gender: { type: "string", enum: ["male", "female"] }
        }
      },
      pillars: {
        type: "object",
        additionalProperties: false,
        required: PILLAR_NAMES,
        properties: Object.fromEntries(PILLAR_NAMES.map(name => [name, pillarSchema]))
      },
      dermatology_summary: {
        type: "object",
        additionalProperties: false,
        required: ["primary_finding"],
        properties: {
          primary_finding: { type: "string", maxLength: 160 }
        }
      }
    }
  };
}

async function analyzeFullFaceImage(faceImageBase64) {
  const apiKey = process.env.OPENAI_API_KEY;
  const imageUrl = stripDataUrlPrefix(faceImageBase64);
  if (!apiKey) return unavailable("Full-face AI review is not configured yet; Diagnosis 2 was skipped.");
  if (!imageUrl) return unavailable("No full-face stabilization image was available for Diagnosis 2.");

  const model = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Analyze this full-face skin image as a conservative visible-signal AI review.",
                "Return the same six-pillar skin report shape used by the app.",
                "Use only visible image evidence. Do not diagnose disease. Do not claim clinical certainty.",
                "Score 0-100 where higher is better/healthier. Keep insights concise and trust-building.",
                "If an area is hard to see, lower confidence and mention visible limitations indirectly."
              ].join(" ")
            },
            { type: "input_image", image_url: imageUrl, detail: "high" }
          ]
        }],
        text: {
          format: {
            type: "json_schema",
            name: "full_face_skin_signal_review",
            strict: true,
            schema: getSchema()
          }
        },
        store: false
      })
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      payload = null;
    }

    if (!response.ok) {
      const msg = payload?.error?.message || raw.slice(0, 180) || `OpenAI vision error (${response.status})`;
      return unavailable(`Diagnosis 2 unavailable: ${msg}`);
    }

    const outputContent = Array.isArray(payload?.output)
      ? payload.output.flatMap(item => item.content || [])
      : [];
    const text = payload?.output_text || outputContent.find(item => item.type === "output_text")?.text;
    if (!text) return unavailable("Diagnosis 2 returned no structured full-face result.");

    return normalizeVisionResult(JSON.parse(text));
  } catch (error) {
    return unavailable(`Diagnosis 2 unavailable: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { analyzeFullFaceImage };
