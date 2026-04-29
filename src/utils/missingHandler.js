const KNOWN_REGIONS = new Set([
  "forehead",
  "nose",
  "chin",
  "left_cheek",
  "right_cheek",
  "jawline"
]);

const ALLOWED_REGION_METRICS = new Set([
  "gloss_reflectance_score",
  "pore_diameter_variance",
  "comedone_density",
  "papule_density",
  "pustule_density",
  "nodule_probability",
  "erythema_index",
  "pih_density",
  "hyperpigmented_lesion_count",
  "melanin_variance_score",
  "tone_asymmetry_score",
  "hydration_proxy",
  "micro_scaling_density",
  "texture_variance",
  "fine_line_density",
  "wrinkle_depth_index",
  "sagging_index",
  "elasticity_proxy"
]);

function clampNumber(value, min = 0, max = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
}

function sanitizeMeta(meta = {}) {
  const clean = {};
  if (typeof meta.selected === "boolean") clean.selected = meta.selected;
  if (typeof meta.locked === "boolean") clean.locked = meta.locked;
  if (typeof meta.source === "string") clean.source = meta.source.slice(0, 80);
  if (typeof meta.metrics_version === "string") clean.metrics_version = meta.metrics_version.slice(0, 80);

  const quality = clampNumber(meta.quality, 0, 100);
  if (quality !== null) clean.quality = Math.round(quality);

  const framesBuffered = clampNumber(meta.frames_buffered, 0, 100);
  if (framesBuffered !== null) clean.frames_buffered = Math.round(framesBuffered);

  const cropWidth = clampNumber(meta.crop_width, 0, 4000);
  const cropHeight = clampNumber(meta.crop_height, 0, 4000);
  if (cropWidth !== null) clean.crop_width = Math.round(cropWidth);
  if (cropHeight !== null) clean.crop_height = Math.round(cropHeight);

  return clean;
}

function sanitizeRegions(regions = {}, regionMeta = {}) {
  const cleanRegions = {};
  const cleanMeta = {};
  const warnings = [];

  Object.entries(regionMeta || {}).forEach(([name, meta]) => {
    if (!KNOWN_REGIONS.has(name)) return;
    cleanMeta[name] = sanitizeMeta(meta);
  });

  Object.entries(regions || {}).forEach(([name, region]) => {
    if (!KNOWN_REGIONS.has(name)) {
      warnings.push(`Ignored unknown region: ${name}`);
      return;
    }
    if (!region || typeof region !== "object") {
      warnings.push(`Ignored invalid region payload: ${name}`);
      return;
    }

    const cleaned = {};
    Object.entries(region).forEach(([metric, value]) => {
      if (metric === "_meta") {
        cleaned._meta = sanitizeMeta(value);
        return;
      }
      if (!ALLOWED_REGION_METRICS.has(metric)) {
        warnings.push(`Ignored unsupported metric: ${name}.${metric}`);
        return;
      }
      const clamped = clampNumber(value, 0, 1);
      if (clamped === null) {
        warnings.push(`Ignored non-numeric metric: ${name}.${metric}`);
        return;
      }
      cleaned[metric] = Math.round(clamped * 1000) / 1000;
    });

    const meta = { ...(cleanMeta[name] || {}), ...(cleaned._meta || {}) };
    cleaned._meta = sanitizeMeta(meta);
    if (Object.keys(cleaned).some(k => k !== "_meta")) {
      cleanRegions[name] = cleaned;
      cleanMeta[name] = cleaned._meta;
    }
  });

  return { regions: cleanRegions, region_meta: cleanMeta, warnings };
}

function sanitizeGlobal(global = {}) {
  const clean = {};
  const age = clampNumber(global.age, 10, 90);
  if (age !== null) clean.age = Math.round(age);

  if (["male", "female"].includes(global.gender)) clean.gender = global.gender;
  if (["urban", "rural", "suburban"].includes(global.environment_type)) {
    clean.environment_type = global.environment_type;
  }

  return clean;
}

function handleMissingMetrics(input = {}) {
  const { regions, region_meta, warnings } = sanitizeRegions(input.regions || {}, input.region_meta || {});
  return {
    regions,
    region_meta,
    global: sanitizeGlobal(input.global || {}),
    biometrics: input.biometrics || {},
    longitudinal: input.longitudinal || {},
    analysis_warnings: warnings
  };
}

module.exports = { handleMissingMetrics };
