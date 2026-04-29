const { handleMissingMetrics } = require("../utils/missingHandler");
const { runLayerB } = require("../services/layerB");
const { runLayerC } = require("../services/layerC");
const { computeConfidence } = require("../services/confidence");
const { calibrateLayerB } = require("../services/confidenceCalibration");
const { estimateAgeFromFaceImage } = require("../services/huggingfaceAge");

async function analyzeFace(req, res) {
  try {
    let input = req.body;

    const cleanedInput = handleMissingMetrics(input);
    const estimatedAge = await estimateAgeFromFaceImage(input?.face_image_base64);
    if (typeof estimatedAge === "number") {
      cleanedInput.global = cleanedInput.global || {};
      cleanedInput.global.age = estimatedAge;
    }

    const layerBOutput = runLayerB(cleanedInput);
    const calibratedLayerB = calibrateLayerB(layerBOutput);

    // This now returns { demographics, pillars, dermatology_summary }
    const finalAnalysis = runLayerC(calibratedLayerB, cleanedInput);
    
    const confidence = computeConfidence(cleanedInput);

    return res.json({
      success: true,
      ...finalAnalysis,
      confidence,
      data_source: "verified_region_visible_signal_proxies",
      analysis_warnings: cleanedInput.analysis_warnings || [],
      age_estimation: {
        source: "huggingface",
        estimated_age: estimatedAge ?? null
      }
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
