
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
      high: `Significant sebaceous activity in the ${r}. For a ${gender} profile, this indicates localized congestion requiring targeted mattifying care.`,
      low: `Balanced oil levels observed. Barrier function is maintaining optimal surface lipids for your demographic.`
    },
    Breakouts_Skin_Calmness: {
      high: `Active inflammatory markers concentrated in the ${r}. At age ${age}, this localized congestion is a clinical priority.`,
      low: `Minimal inflammatory signals detected. Your skin shows excellent resilience and clarity in the ${r}.`
    },
    Evenness_Marks: {
      high: `Localized tone variance detected in the ${r}. Proactive management of marks is recommended to maintain brightness.`,
      low: `Superior tone evenness. Your skin maintains a bright, uniform appearance across all analyzed regions.`
    },
    Skin_Strength_Sensitivity: {
      high: `Barrier integrity appears compromised in the ${r}. At age ${age}, restorative hydration is essential to reduce reactivity.`,
      low: `Resilient barrier function. Your skin shows optimal hydration retention and minimal sensitivity markers.`
    },
    Smoothness_Pore_Look: {
      high: `Textural variance detected around the ${r}, often correlating with sebaceous activity and follicular congestion.`,
      low: `Refined surface texture. Your skin maintains a smooth, polished appearance with minimal pore visibility.`
    },
    Firmness_Fine_Lines: {
      high: `Early expression lines detected in the ${r}. At age ${age}, support for collagen and elasticity is recommended.`,
      low: `Superior resilience. Your firmness levels are excellent compared to the clinical baseline for age ${age}.`
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
  const priorities = [];
  if (results.Breakouts_Skin_Calmness?.score < 50) priorities.push("Active Inflammation");
  if (results.Oil_Balance?.score < 50) priorities.push("Sebum Dysregulation");
  if (results.Skin_Strength_Sensitivity?.score < 50) priorities.push("Barrier Compromise");

  const primaryFinding = priorities.length > 0 ? priorities.join(" & ") : "Maintenance & Prevention";

  return {
    primary_finding: primaryFinding,
    clinical_standard: `${input.global?.age || 35}yo ${input.global?.gender || 'Female'} Profile`,
    professional_grade: "Dermatology-Aligned Assessment"
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
