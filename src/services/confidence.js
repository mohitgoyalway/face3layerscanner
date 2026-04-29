const EXPECTED_CORE_METRICS = 28;
const EXPECTED_REGIONS = 6;

function countValidMetrics(regions = {}) {
  let count = 0;
  Object.values(regions).forEach(region => {
    if (!region || typeof region !== "object") return;
    Object.entries(region).forEach(([key, value]) => {
      if (key === "_meta") return;
      if (typeof value === "number" && Number.isFinite(value)) count++;
    });
  });
  return count;
}

function getRegionMeta(input = {}) {
  const merged = { ...(input.region_meta || {}) };
  Object.entries(input.regions || {}).forEach(([name, region]) => {
    if (region?._meta) merged[name] = { ...(merged[name] || {}), ...region._meta };
  });
  return merged;
}

function averageQuality(metaEntries) {
  const values = metaEntries
    .map(([, meta]) => meta?.quality)
    .filter(v => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeConfidence(input = {}) {
  const meta = getRegionMeta(input);
  const regionEntries = Object.entries(input.regions || {});
  const selectedMetaEntries = Object.entries(meta).filter(([, m]) => m?.selected !== false);
  const selectedCount = selectedMetaEntries.length || regionEntries.length;
  const metricCount = countValidMetrics(input.regions);
  const lockedCount = selectedMetaEntries.filter(([, m]) => m?.locked === true).length;
  const clientProxyCount = selectedMetaEntries.filter(([, m]) => m?.source === "client_image_proxy").length;

  if (selectedCount === 0 || metricCount === 0) return 5;

  const coverageScore = Math.min(selectedCount / EXPECTED_REGIONS, 1) * 25;
  const metricScore = Math.min(metricCount / EXPECTED_CORE_METRICS, 1) * 35;
  const qualityScore = Math.min(averageQuality(selectedMetaEntries) / 100, 1) * 25;
  const lockScore = Math.min(lockedCount / Math.max(1, selectedCount), 1) * 10;
  const sourceScore = Math.min(clientProxyCount / Math.max(1, selectedCount), 1) * 5;

  return Math.max(5, Math.min(98, Math.round(
    coverageScore + metricScore + qualityScore + lockScore + sourceScore
  )));
}

module.exports = { computeConfidence };
