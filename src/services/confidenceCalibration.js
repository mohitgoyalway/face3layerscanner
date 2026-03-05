
// Confidence Calibration Layer

function calibrateConfidence(model) {
  if (!model) return null;

  let c = model.confidence * 100; // Convert to percentage for logic

  if (c > 80) c = Math.min(95, c);
  if (c < 30) c = Math.max(15, c);

  return {
    ...model,
    confidence: Math.round(c)
  };
}

function calibrateLayerB(layerB) {
  return {
    oil_model: calibrateConfidence(layerB.oil_model),
    acne_model: calibrateConfidence(layerB.acne_model),
    pigment_model: calibrateConfidence(layerB.pigment_model),
    barrier_model: calibrateConfidence(layerB.barrier_model),
    surface_model: calibrateConfidence(layerB.surface_model),
    aging_model: calibrateConfidence(layerB.aging_model)
  };
}

module.exports = { calibrateLayerB };
