
const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const scale = (v, factor = 1.0) => 100 - Math.round(clamp(v * factor) * 100);

function exists(v) { return typeof v === "number" && !isNaN(v); }

/**
 * COMPREHENSIVE: Demographic Calibration Factors
 * Every pillar now has a demographic baseline.
 */
function getDemographicFactors(global) {
  const age = global?.age || 35;
  const gender = global?.gender || 'female';

  const factors = {
    oil: gender === 'male' ? 0.8 : 1.0,     // Men naturally produce more sebum
    aging: 1.0,
    acne: age > 25 ? 1.2 : 0.9,             // Adult acne is clinically more significant
    pigment: age > 50 ? 0.7 : 1.1,          // Lenient for age spots in seniors; strict for PIH in youth
    barrier: age > 60 ? 1.2 : 1.0           // Thinner skin in seniors is more high-risk
  };

  if (age > 60) factors.aging = 0.5;
  else if (age > 45) factors.aging = 0.8;
  else if (age < 25) factors.aging = 1.5;

  return factors;
}

function clinicalScore(metrics) {
  let sum = 0, weightSum = 0, maxVal = 0;
  let hasData = false;
  metrics.forEach(m => {
    if (exists(m.value)) {
      sum += m.value * m.weight;
      weightSum += m.weight;
      if (m.value > maxVal) maxVal = m.value;
      hasData = true;
    }
  });
  if (!hasData) return null;
  return ((sum / weightSum) * 0.4) + (maxVal * 0.6);
}

function weightedRegionScore(regionScores, weights, globalContext = {}) {
  let sum = 0, weightSum = 0, hasData = false;
  const envMultiplier = globalContext.environment_type === 'urban' ? 1.1 : 1.0;
  Object.entries(regionScores).forEach(([r, v]) => {
    if (weights[r] !== undefined) {
      let w = weights[r];
      if (['nose', 'forehead'].includes(r)) w *= envMultiplier;
      sum += v * w;
      weightSum += w;
      hasData = true;
    }
  });
  return hasData ? sum / weightSum : null;
}

function driverRegion(regionScores) {
  let max = -1, driver = null;
  Object.entries(regionScores).forEach(([r, v]) => {
    if (v > max) { max = v; driver = r; }
  });
  return driver;
}

function evaluateRegions(regions, calculator) {
  const regionScores = {}, signals = new Set();
  Object.entries(regions || {}).forEach(([name, region]) => {
    const result = calculator(region);
    if (result && result.score !== null) {
      regionScores[name] = result.score;
      result.signals.forEach(s => {
        if (exists(region?.[s])) signals.add(s);
      });
    }
  });
  return { regionScores, signals: [...signals] };
}

/* ---------------- MODELS ---------------- */

function oilModel(input, factors) {
  const weights = { nose: 0.40, forehead: 0.30, chin: 0.20, left_cheek: 0.05, right_cheek: 0.05 };
  const result = evaluateRegions(input.regions, r => ({
    score: clinicalScore([{value:r.gloss_reflectance_score,weight:0.5},{value:r.pore_diameter_variance,weight:0.3},{value:r.comedone_density,weight:0.2}]),
    signals: ["gloss_reflectance_score", "pore_diameter_variance", "comedone_density"]
  }));
  const final = weightedRegionScore(result.regionScores, weights, input.global);
  return final !== null ? { score: scale(final, factors.oil), driver_region: driverRegion(result.regionScores), signals_used: result.signals, confidence: Object.keys(result.regionScores).length / 5 } : null;
}

function acneModel(input, factors) {
  const weights = { jawline: 0.35, forehead: 0.25, left_cheek: 0.20, right_cheek: 0.20 };
  const result = evaluateRegions(input.regions, r => ({
    score: clinicalScore([{value:r.papule_density,weight:0.4},{value:r.pustule_density,weight:0.3},{value:r.nodule_probability,weight:0.2},{value:r.erythema_index,weight:0.1}]),
    signals: ["papule_density", "pustule_density", "nodule_probability", "erythema_index"]
  }));
  const final = weightedRegionScore(result.regionScores, weights, input.global);
  return final !== null ? { score: scale(final, factors.acne), driver_region: driverRegion(result.regionScores), signals_used: result.signals, confidence: Object.keys(result.regionScores).length / 4 } : null;
}

function pigmentModel(input, factors) {
  const weights = { left_cheek: 0.35, right_cheek: 0.35, forehead: 0.15, nose: 0.10, chin: 0.05 };
  const result = evaluateRegions(input.regions, r => ({
    score: clinicalScore([{value:r.pih_density,weight:0.4},{value:r.hyperpigmented_lesion_count,weight:0.3},{value:r.melanin_variance_score,weight:0.2},{value:r.tone_asymmetry_score,weight:0.1}]),
    signals: ["pih_density", "hyperpigmented_lesion_count", "melanin_variance_score", "tone_asymmetry_score"]
  }));
  const final = weightedRegionScore(result.regionScores, weights, input.global);
  return final !== null ? { score: scale(final, factors.pigment), driver_region: driverRegion(result.regionScores), signals_used: result.signals, confidence: Object.keys(result.regionScores).length / 5 } : null;
}

function barrierModel(input, factors) {
  const weights = { left_cheek: 0.30, right_cheek: 0.30, forehead: 0.20, chin: 0.20 };
  const result = evaluateRegions(input.regions, r => ({
    score: clinicalScore([{value:exists(r.hydration_proxy)?1-r.hydration_proxy:undefined,weight:0.4},{value:r.micro_scaling_density,weight:0.3},{value:r.erythema_index,weight:0.3}]),
    signals: ["hydration_proxy", "micro_scaling_density", "erythema_index"]
  }));
  const final = weightedRegionScore(result.regionScores, weights, input.global);
  return final !== null ? { score: scale(final, factors.barrier), driver_region: driverRegion(result.regionScores), signals_used: result.signals, confidence: Object.keys(result.regionScores).length / 4 } : null;
}

function surfaceModel(input, factors) {
  const weights = { left_cheek: 0.30, right_cheek: 0.30, nose: 0.20, forehead: 0.20 };
  const result = evaluateRegions(input.regions, r => ({
    score: clinicalScore([{value:r.texture_variance,weight:0.4},{value:r.pore_diameter_variance,weight:0.3},{value:r.fine_line_density,weight:0.3}]),
    signals: ["texture_variance", "pore_diameter_variance", "fine_line_density"]
  }));
  const final = weightedRegionScore(result.regionScores, weights, input.global);
  return final !== null ? { score: scale(final, factors.oil), driver_region: driverRegion(result.regionScores), signals_used: result.signals, confidence: Object.keys(result.regionScores).length / 4 } : null;
}

function agingModel(input, factors) {
  const weights = { forehead: 0.30, left_cheek: 0.20, right_cheek: 0.20, jawline: 0.30 };
  const result = evaluateRegions(input.regions, r => ({
    score: clinicalScore([{value:r.wrinkle_depth_index,weight:0.4},{value:r.sagging_index,weight:0.3},{value:exists(r.elasticity_proxy)?1-r.elasticity_proxy:undefined,weight:0.3}]),
    signals: ["wrinkle_depth_index", "sagging_index", "elasticity_proxy"]
  }));
  const final = weightedRegionScore(result.regionScores, weights, input.global);
  return final !== null ? { score: scale(final, factors.aging), driver_region: driverRegion(result.regionScores), signals_used: result.signals, confidence: Object.keys(result.regionScores).length / 4 } : null;
}

function runLayerB(input) {
  const factors = getDemographicFactors(input.global);
  return {
    oil_model: oilModel(input, factors),
    acne_model: acneModel(input, factors),
    pigment_model: pigmentModel(input, factors),
    barrier_model: barrierModel(input, factors),
    surface_model: surfaceModel(input, factors),
    aging_model: agingModel(input, factors)
  };
}

module.exports = { runLayerB };
