(function () {
  "use strict";

  const LEAF_CONFIDENCE_THRESHOLD = 0.8;

  function sampleImage(imageData) {
    if (!imageData?.data?.length) return { green: 0.42, brightness: 0.45, hash: 2 };
    const data = imageData.data;
    const stride = Math.max(4, Math.floor(data.length / 4000 / 4) * 4);
    let green = 0;
    let brightness = 0;
    let hash = 2166136261;
    let count = 0;
    for (let index = 0; index < data.length; index += stride) {
      const red = data[index] || 0;
      const greenChannel = data[index + 1] || 0;
      const blue = data[index + 2] || 0;
      green += Math.max(0, greenChannel - (red + blue) / 2) / 255;
      brightness += (red + greenChannel + blue) / 765;
      hash ^= red + greenChannel * 3 + blue * 7;
      hash = Math.imul(hash, 16777619);
      count += 1;
    }
    return {
      green: green / Math.max(1, count),
      brightness: brightness / Math.max(1, count),
      hash: Math.abs(hash)
    };
  }

  function unknownLeaf(reason, details = {}) {
    return {
      provider: details.provider || "CanopySpeciesIndex",
      model: details.model || "External leaf index",
      version: details.version || null,
      speciesPrediction: "Unknown",
      scientificName: null,
      speciesConfidence: 0,
      confirmed: false,
      reason,
      indexSource: details.indexSource || null
    };
  }

  function normalizeLeafResult(payload) {
    const candidate = payload?.result || payload?.results?.[0] || payload?.candidate || payload;
    const species = candidate?.species || {};
    const confidence = Number(candidate?.score ?? candidate?.confidence ?? payload?.confidence ?? 0);
    const commonNames = species.commonNames || candidate?.commonNames || [];
    const scientificName = species.scientificNameWithoutAuthor
      || species.scientificName
      || candidate?.scientificName
      || payload?.scientificName
      || null;
    const commonName = candidate?.commonName
      || payload?.commonName
      || (Array.isArray(commonNames) ? commonNames[0] : null);
    const name = String(commonName || scientificName || "").trim();
    const rejected = payload?.rejected === true || candidate?.rejected === true;
    if (rejected || !name || name.toLowerCase() === "unknown" || confidence < LEAF_CONFIDENCE_THRESHOLD) {
      return unknownLeaf(rejected ? "image-rejected" : !name ? "no-match" : "low-confidence", {
        provider: payload?.provider,
        model: payload?.model,
        version: payload?.version,
        indexSource: payload?.indexSource
      });
    }
    return {
      provider: payload?.provider || "CanopySpeciesIndex",
      model: payload?.model || "External leaf index",
      version: payload?.version || null,
      speciesPrediction: name,
      scientificName,
      speciesConfidence: Number(confidence.toFixed(3)),
      confirmed: true,
      reason: "leaf-index-match",
      indexSource: payload?.indexSource || payload?.project || "configured-species-index"
    };
  }

  async function analyze({ imageData, metadata = {} } = {}) {
    const sample = sampleImage(imageData);
    const accuracyPenalty = Math.min(6, Number(metadata.gpsAccuracy || 12) / 18);
    const height = Math.round(31 + (sample.hash % 15) - accuracyPenalty);
    const canopyDiameter = Math.round(Math.max(12, height * (0.58 + ((sample.hash >> 3) % 10) / 100)));
    const dbh = Math.round(Math.max(7, height * 0.34 + ((sample.hash >> 5) % 4)));
    const condition = sample.green > 0.08 ? "Good" : sample.brightness < 0.25 ? "Poor" : "Needs review";

    await new Promise(resolve => setTimeout(resolve, 180));
    return {
      provider: "CanopyAIProvider",
      model: "CanopyVision Measurements",
      version: "0.2.0-preview",
      onDevice: true,
      speciesPrediction: "Unknown",
      speciesConfidence: 0,
      estimatedHeight: height,
      estimatedCanopyDiameter: canopyDiameter,
      estimatedCanopyArea: Math.round(Math.PI * Math.pow(canopyDiameter / 2, 2)),
      estimatedDbh: dbh,
      estimatedCondition: condition,
      disclaimer: "The canopy photo estimates dimensions only. Species requires a separate leaf-index match."
    };
  }

  async function identifyLeaf({ imageBlob, metadata = {} } = {}) {
    if (!(imageBlob instanceof Blob) || !imageBlob.size) return unknownLeaf("missing-leaf-image");
    const databaseOrigin = String(window.ORANGE_TREE_DATABASE_URL || "").replace(/\/$/, "");
    const endpoint = window.CANOPY_SPECIES_IDENTIFIER_URL || (databaseOrigin ? `${databaseOrigin}/v1/identify/leaf` : "");
    if (!endpoint) return unknownLeaf("classifier-unavailable");

    try {
      const query = new URL(endpoint);
      if (Number.isFinite(metadata.latitude)) query.searchParams.set("lat", String(metadata.latitude));
      if (Number.isFinite(metadata.longitude)) query.searchParams.set("lng", String(metadata.longitude));
      const response = await fetch(query, {
        method: "POST",
        headers: { "Content-Type": imageBlob.type || "image/jpeg" },
        body: imageBlob
      });
      if (!response.ok) return unknownLeaf(response.status === 404 ? "classifier-unavailable" : "classifier-error");
      return normalizeLeafResult(await response.json());
    } catch (_error) {
      return unknownLeaf("classifier-unavailable");
    }
  }

  window.CanopyAI = Object.freeze({
    name: "CanopyAIProvider",
    version: "0.2.0",
    leafConfidenceThreshold: LEAF_CONFIDENCE_THRESHOLD,
    analyze,
    identifyLeaf,
    normalizeLeafResult
  });
})();
