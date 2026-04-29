
function band(score, thresholds) {
  for (let i = 0; i < thresholds.length; i++) {
    if (score >= thresholds[i]) return i;
  }
  return thresholds.length;
}

const thresholds = {
  Oil_Balance: [75, 55, 35, 15],
  Breakouts_Skin_Calmness: [80, 60, 40, 20],
  Evenness_Marks: [80, 60, 40, 20],
  Skin_Strength_Sensitivity: [75, 55, 35, 15],
  Smoothness_Pore_Look: [75, 55, 35, 15],
  Firmness_Fine_Lines: [80, 60, 40, 20]
};

const states = {
  Oil_Balance: ["Fresh & Balanced", "Slightly Oily", "Oil-Prone", "Very Oily", "Shine & Congestion Heavy"],
  Breakouts_Skin_Calmness: ["Clear & Calm", "Occasional Pimples", "Flare-Prone", "Frequent Breakouts", "Highly Reactive"],
  Evenness_Marks: ["Even & Bright", "Mild Marks", "Uneven Tone", "Stubborn Dark Spots", "Heavy Mark Memory"],
  Skin_Strength_Sensitivity: ["Strong & Resilient", "Slightly Sensitive", "Easily Irritated", "Weak & Reactive", "Highly Sensitive"],
  Smoothness_Pore_Look: ["Smooth & Refined", "Mild Texture", "Visible Pores", "Rough & Uneven", "Deep Texture Concerns"],
  Firmness_Fine_Lines: ["Firm & Youthful", "Early Fine Lines", "Mild Firmness Drop", "Visible Aging Signs", "Advanced Firmness Loss"]
};

/**
 * COMPREHENSIVE: Professional Insight Engine
 * Detailed templates for all 6 pillars with demographic context.
 */
function generateClinicalInsight(pillar, model, input) {
  const r = model.driver_region;
  const score = model.score;
  const age = input.global?.age || 35;
  const gender = input.global?.gender || 'female';

  const templates = {
    Oil_Balance: {
      high: `Visible shine and pore signals are strongest around the ${r}. This suggests that area may need targeted oil-control care.`,
      low: `Visible oil signals look balanced across the captured regions.`
    },
    Breakouts_Skin_Calmness: {
      high: `Visible redness and breakout-like texture are most noticeable near the ${r}. Consider tracking this area over repeated scans.`,
      low: `Few visible breakout-like signals were found in the captured regions.`
    },
    Evenness_Marks: {
      high: `Tone variation and mark-like signals are most noticeable around the ${r}.`,
      low: `The captured regions show relatively even visible tone.`
    },
    Skin_Strength_Sensitivity: {
      high: `Visible dryness or redness signals are strongest near the ${r}.`,
      low: `The captured regions show fewer visible dryness or sensitivity signals.`
    },
    Smoothness_Pore_Look: {
      high: `Texture and pore-look signals are most visible around the ${r}.`,
      low: `The captured regions show relatively smooth visible texture.`
    },
    Firmness_Fine_Lines: {
      high: `Fine-line-like texture signals are most noticeable around the ${r}.`,
      low: `The captured regions show fewer visible fine-line-like signals.`
    }
  };

  const category = score < 60 ? 'high' : 'low';
  return templates[pillar]?.[category] || `Signals (${model.signals_used.join(", ")}) are most influential in the ${r} region.`;
}

function build(pillar, model, input) {
  if (!model) return null;
  const b = band(model.score, thresholds[pillar]);
  return {
    score: model.score,
    state: states[pillar][b],
    driver_region: model.driver_region,
    evidence_signals: model.signals_used,
    insight: generateClinicalInsight(pillar, model, input)
  };
}

function generateDermatologySummary(results, input) {
  const available = Object.values(results || {}).filter(Boolean);
  if (available.length === 0) {
    return {
      primary_finding: "Insufficient selected region data",
      clinical_standard: "Visible skin signal scan",
      professional_grade: "Low-confidence AI skin signal review"
    };
  }

  const priorities = [];
  if (results.Breakouts_Skin_Calmness?.score < 50) priorities.push("Active Inflammation");
  if (results.Oil_Balance?.score < 50) priorities.push("Sebum Dysregulation");
  if (results.Skin_Strength_Sensitivity?.score < 50) priorities.push("Barrier Compromise");

  const primaryFinding = priorities.length > 0 ? priorities.join(" & ") : "Maintenance & Prevention";

  return {
    primary_finding: primaryFinding,
    clinical_standard: "Visible skin signal scan",
    professional_grade: "AI skin signal review"
  };
}

function runLayerC(layerB, input) {
  const results = {
    Oil_Balance: build("Oil_Balance", layerB.oil_model, input),
    Breakouts_Skin_Calmness: build("Breakouts_Skin_Calmness", layerB.acne_model, input),
    Evenness_Marks: build("Evenness_Marks", layerB.pigment_model, input),
    Skin_Strength_Sensitivity: build("Skin_Strength_Sensitivity", layerB.barrier_model, input),
    Smoothness_Pore_Look: build("Smoothness_Pore_Look", layerB.surface_model, input),
    Firmness_Fine_Lines: build("Firmness_Fine_Lines", layerB.aging_model, input)
  };

  return {
    demographics: { age: input.global?.age || 35, gender: input.global?.gender || 'female' },
    pillars: results,
    dermatology_summary: generateDermatologySummary(results, input)
  };
}

module.exports = { runLayerC };
