import { haversineMeters } from "./geo.js";

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const cache = new Map();

function validCoordinate(point) {
  return point &&
    Number.isFinite(Number(point.lat)) &&
    Number.isFinite(Number(point.lng)) &&
    Number(point.lat) >= -90 &&
    Number(point.lat) <= 90 &&
    Number(point.lng) >= -180 &&
    Number(point.lng) <= 180;
}

function cacheKey(center, radiusM) {
  return `${Number(center.lat).toFixed(3)},${Number(center.lng).toFixed(3)},${Math.round(Number(radiusM) / 100) * 100}`;
}

function pointInPolygon(point, geometry) {
  if (!Array.isArray(geometry) || geometry.length < 3) return false;
  let inside = false;
  for (let i = 0, j = geometry.length - 1; i < geometry.length; j = i++) {
    const a = geometry[i];
    const b = geometry[j];
    if ((Number(a.lat) > point.lat) !== (Number(b.lat) > point.lat)) {
      const intersection =
        ((Number(b.lon) - Number(a.lon)) * (point.lat - Number(a.lat))) /
          (Number(b.lat) - Number(a.lat) || 1e-18) +
        Number(a.lon);
      if (point.lng < intersection) inside = !inside;
    }
  }
  return inside;
}

function isAccessibleWay(element) {
  const tags = element?.tags || {};
  if (element?.type !== "way" || !Array.isArray(element.geometry) || element.geometry.length < 2) {
    return false;
  }
  if (/^(private|no)$/.test(String(tags.access || ""))) return false;
  return /^(footway|path|pedestrian|steps|corridor|crossing|cycleway|track|service|living_street|residential|tertiary|secondary|primary|unclassified)$/.test(String(tags.highway || "")) ||
    /^(both|left|right|yes|separate)$/.test(String(tags.sidewalk || ""));
}

function candidatePoints(data) {
  const blocked = data.blockedAreas || [];
  const points = [];
  for (const way of data.walkways || []) {
    for (const node of way.geometry || []) {
      const point = { lat: Number(node.lat), lng: Number(node.lon) };
      if (validCoordinate(point) && !blocked.some((area) => pointInPolygon(point, area.geometry))) {
        points.push({ ...point, source: "osm", osmWayId: way.id });
      }
    }
  }
  for (const node of data.crossingNodes || []) {
    const point = { lat: Number(node.lat), lng: Number(node.lon) };
    if (validCoordinate(point) && !blocked.some((area) => pointInPolygon(point, area.geometry))) {
      points.push({ ...point, source: "osm", osmNodeId: node.id });
    }
  }
  return points;
}

async function fetchCandidates(center, radiusM, options) {
  const key = cacheKey(center, radiusM);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < options.cacheTtlMs) return cached.data;

  const radius = Math.max(50, Math.min(1_200, Math.round(radiusM)));
  const query = `[out:json][timeout:8];(
    way(around:${radius},${center.lat},${center.lng})["highway"~"^(footway|path|pedestrian|steps|corridor|crossing|cycleway|track|service|living_street|residential|tertiary|secondary|primary|unclassified)$"]["access"!~"^(private|no)$"];
    way(around:${radius},${center.lat},${center.lng})["sidewalk"~"^(both|left|right|yes|separate)$"]["access"!~"^(private|no)$"];
    node(around:${radius},${center.lat},${center.lng})["highway"="crossing"]["access"!~"^(private|no)$"];
    way(around:${radius},${center.lat},${center.lng})["building"];
    way(around:${radius},${center.lat},${center.lng})["natural"~"^(water|wetland)$"];
    way(around:${radius},${center.lat},${center.lng})["landuse"~"^(farmland|farmyard|quarry|industrial)$"];
  );out center geom;`;

  const urls = options.overpassUrls?.length ? options.overpassUrls : [options.overpassUrl || process.env.OVERPASS_URL || DEFAULT_OVERPASS_URL];
  let lastError = null;
  for (const url of urls) {
    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await (options.fetchImpl || fetch)(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", accept: "application/json" },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
        const json = await response.json();
        const elements = Array.isArray(json.elements) ? json.elements : [];
        const data = {
          walkways: elements.filter(isAccessibleWay),
          crossingNodes: elements.filter((x) => x.type === "node" && x.tags?.highway === "crossing"),
          blockedAreas: elements.filter((x) => x.type === "way" && (
            x.tags?.building ||
            /^(water|wetland)$/.test(String(x.tags?.natural || "")) ||
            /^(farmland|farmyard|quarry|industrial)$/.test(String(x.tags?.landuse || ""))
          )),
        };
        cache.set(key, { at: now, data });
        return data;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw Object.assign(new Error(`Placement OSM indisponible: ${lastError?.message || "erreur réseau"}`), { code: "OSM_UNAVAILABLE" });
}

function isSafe(point, center, radiusM, options) {
  if (!validCoordinate(point)) return false;
  if (haversineMeters(point.lat, point.lng, center.lat, center.lng) > radiusM - (options.beaconRadiusM || 0)) return false;
  const insideZone = options.isInsideZone || (() => true);
  if (!insideZone(point.lat, point.lng)) return false;
  const playerDistance = options.minBeaconSpawnDistanceM ?? 30;
  if ((options.players || []).some((player) =>
    validCoordinate(player) &&
    haversineMeters(point.lat, point.lng, player.lat, player.lng) < playerDistance
  )) return false;
  const spacing = options.minBeaconSpacingM ?? 180;
  if ((options.existingBeacons || []).some((beacon) =>
    validCoordinate(beacon) &&
    haversineMeters(point.lat, point.lng, beacon.lat, beacon.lng) < spacing
  )) return false;
  return true;
}

export async function findAccessibleBeaconPosition(center, radiusM, options = {}) {
  if (!validCoordinate(center) || !Number.isFinite(Number(radiusM)) || Number(radiusM) <= 0) {
    throw Object.assign(new Error("Centre ou rayon de zone invalide."), { code: "INVALID_ZONE" });
  }
  const settings = {
    cacheTtlMs: DEFAULT_CACHE_TTL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    ...options,
  };
  let data;
  let source = "osm";
  try {
    data = await fetchCandidates(center, Number(radiusM), settings);
  } catch (error) {
    source = "validated_cache";
    const cached = cache.get(cacheKey(center, Number(radiusM)));
    data = cached?.data;
    if (!data && !settings.validatedPositions?.length) throw error;
  }
  const candidates = [
    ...(settings.onlyValidatedPositions ? [] : candidatePoints(data || {})),
    ...(settings.validatedPositions || []).filter(validCoordinate).map((point) => ({ ...point, source: "validated_cache" })),
  ];
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const selected = shuffled.find((point) => isSafe(point, center, Number(radiusM), settings));
  if (!selected) {
    throw Object.assign(new Error("Aucune position de balise accessible et sûre n'a été trouvée."), {
      code: "NO_SAFE_BEACON_POSITION",
      source,
    });
  }
  return selected;
}

export function beaconCountForPlayers(playerCount, random = Math.random) {
  const count = Math.max(0, Math.floor(Number(playerCount) || 0));
  if (count <= 1) return 0;
  if (count === 2) return 2 + (random() < 0.5 ? 0 : 1);
  if (count === 3) return 4 + (random() < 0.5 ? 0 : 1);
  if (count === 4 || count === 5) return 6 + (random() < 0.5 ? 0 : 1);
  if (count === 6 || count === 7) return 6 + Math.floor(random() * 3);
  return 10 + Math.floor(random() * 3);
}

export function clearBeaconPositionCache() {
  cache.clear();
}
