const { handleMissingMetrics } = require("../utils/missingHandler");
const { runLayerB } = require("../services/layerB");
const { runLayerC } = require("../services/layerC");
const { computeConfidence } = require("../services/confidence");
const { calibrateLayerB } = require("../services/confidenceCalibration");

async function analyzeFace(req, res) {
  try {
    let input = req.body;

    const cleanedInput = handleMissingMetrics(input);
    const layerBOutput = runLayerB(cleanedInput);
    const calibratedLayerB = calibrateLayerB(layerBOutput);

    // This now returns { demographics, pillars, dermatology_summary }
    const finalAnalysis = runLayerC(calibratedLayerB, cleanedInput);
    
    const confidence = computeConfidence(cleanedInput);

    return res.json({
      success: true,
      ...finalAnalysis,
      confidence
    });

  } catch (error) {
    console.error("Dermatology Service Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error during clinical analysis"
    });
  }
}

module.exports = { analyzeFace };
