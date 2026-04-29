const { handleMissingMetrics } = require("../utils/missingHandler");
const { runLayerB } = require("../services/layerB");
const { runLayerC } = require("../services/layerC");
const { computeConfidence } = require("../services/confidence");
const { calibrateLayerB } = require("../services/confidenceCalibration");
const { estimateAgeFromFaceImage } = require("../services/huggingfaceAge");
const { analyzeFullFaceImage } = require("../services/fullFaceVision");

async function analyzeFace(req, res) {
  try {
    let input = req.body;

    const cleanedInput = handleMissingMetrics(input);
    const [estimatedAge, fullFaceAnalysis] = await Promise.all([
      estimateAgeFromFaceImage(input?.face_image_base64),
      analyzeFullFaceImage(input?.face_image_base64)
    ]);

    if (typeof estimatedAge === "number") {
      cleanedInput.global = cleanedInput.global || {};
      cleanedInput.global.age = estimatedAge;
    }

    const layerBOutput = runLayerB(cleanedInput);
    const calibratedLayerB = calibrateLayerB(layerBOutput);

    // This now returns { demographics, pillars, dermatology_summary }
    const finalAnalysis = runLayerC(calibratedLayerB, cleanedInput);
    
    const confidence = computeConfidence(cleanedInput);
    const diagnosis1 = {
      available: true,
      label: "Diagnosis 1: Region Scan",
      data_source: "verified_region_visible_signal_proxies",
      ...finalAnalysis,
      confidence,
      analysis_warnings: cleanedInput.analysis_warnings || [],
      age_estimation: {
        source: "huggingface",
        estimated_age: estimatedAge ?? null
      }
    };

    return res.json({
      success: true,
      ...diagnosis1,
      confidence,
      data_source: "verified_region_visible_signal_proxies",
      analysis_warnings: cleanedInput.analysis_warnings || [],
      age_estimation: {
        source: "huggingface",
        estimated_age: estimatedAge ?? null
      },
      diagnoses: {
        diagnosis_1: diagnosis1,
        diagnosis_2: fullFaceAnalysis
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
