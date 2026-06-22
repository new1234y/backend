import { v4 as uuidv4 } from "uuid";
import { saveGameSummary, saveGameMessage, saveTimelineEvent, saveSession, deleteSession, deleteActiveRoom, saveActivePower, removeActivePower, getActivePowers, cleanupExpiredPowers } from "./supabase.js";
import {
  haversineMeters,
  randomOffsetPoint,
  isInsideRadius,
  isInsideAnyPolygon,
  offsetMeters,
} from "./geo.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CAPTURE_DISTANCE_M = 15;
// Multiple Overpass API endpoints for fallback
const OVERPASS_URLS = [
  process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];
const OSM_BALISE_CACHE_TTL_MS = 10 * 60 * 1000;
const osmBaliseCache = new Map();

function isValidCoordinates(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && 
         lat >= -90 && lat <= 90 && 
         lng >= -180 && lng <= 180;
}

const COLOR_PALETTE = [
  "#3b82f6",
  "#f97316",
  "#22c55e",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#eab308",
  "#ef4444",
  "#6366f1",
  "#84cc16",
  "#f43f5e",
  "#06b6d4",
];

function randomCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

function recordCoinTransaction(player, amount, source, reason) {
  if (!player.coinHistory) player.coinHistory = [];
  player.coinHistory.push({
    timestamp: Date.now(),
    amount,
    source,
    reason
  });
  // Keep only last 100 transactions
  if (player.coinHistory.length > 100) {
    player.coinHistory = player.coinHistory.slice(-100);
  }
}

function calculateAdaptivePhaseCount(timeLimitMinutes, globalRadiusM) {
  const R0 = globalRadiusM || 500;
  const Rmin = 70;
  const gapMinimum = 15; // Minimum de réduction entre phases (mètres) pour que ce soit visible

  // Base sur le temps : 1 phase tous les 5-6 minutes, min 3, max 8
  const timeBasedCount = Math.min(Math.max(3, Math.floor(timeLimitMinutes / 5)), 8);

  // Base sur le rayon : s'assurer que chaque réduction est significative
  const radiusBasedCount = Math.floor((R0 - Rmin) / gapMinimum);

  // Prendre le minimum des deux pour éviter trop de phases avec petits gaps
  return Math.min(timeBasedCount, radiusBasedCount);
}

function calculateFinalWaitRatio(timeLimitMinutes) {
  // Pour les parties courtes, réserver plus de temps pour la phase d'attente finale
  // Minimum 1 minute d'attente, maximum 5% du temps total
  const minWaitMinutes = 1;
  const maxRatio = 0.05; // 5%

  // Si la partie est très courte, réserver une plus grande proportion
  if (timeLimitMinutes <= 10) {
    // Pour 10 min ou moins, réserver au moins 1 minute (10% ou plus)
    return Math.max(minWaitMinutes / timeLimitMinutes, maxRatio);
  } else if (timeLimitMinutes <= 15) {
    // Pour 10-15 min, réserver environ 8-10%
    return Math.max(minWaitMinutes / timeLimitMinutes, 0.08);
  } else {
    // Pour les parties longues, garder 5%
    return maxRatio;
  }
}

function calculateDynamicCatDelay(timeLimitMinutes, globalRadiusM, playerCount) {
  // Base: 2-3% of game duration
  const baseRatio = 0.025; // 2.5%
  const delayMs = timeLimitMinutes * baseRatio * 60 * 1000;

  // Adjust based on circle size: larger circle = more time to spread out
  const R0 = globalRadiusM || 500;
  const radiusFactor = Math.max(1, R0 / 500); // 1x for 500m, 2x for 1000m, etc.

  // Adjust based on player count: more players = slightly more time
  const playerFactor = Math.max(1, playerCount / 4); // 1x for 4 players, 1.5x for 6 players

  // Calculate final delay
  const adjustedDelayMs = delayMs * radiusFactor * playerFactor;

  // Apply caps based on game length
  const minDelayMs = 2 * 60 * 1000; // 2 minutes minimum
  const maxRatio = 0.08; // 8% of game duration maximum
  const maxDelayMs = timeLimitMinutes * maxRatio * 60 * 1000;

  // For very short games, cap at a lower percentage
  if (timeLimitMinutes <= 10) {
    const shortGameMaxMs = timeLimitMinutes * 0.05 * 60 * 1000; // 5% max for short games
    return Math.max(minDelayMs, Math.min(adjustedDelayMs, shortGameMaxMs));
  }

  // For very long games, cap at a reasonable absolute value
  if (timeLimitMinutes >= 120) {
    const longGameMaxMs = 8 * 60 * 1000; // 8 minutes max for very long games
    return Math.max(minDelayMs, Math.min(adjustedDelayMs, longGameMaxMs));
  }

  return Math.max(minDelayMs, Math.min(adjustedDelayMs, maxDelayMs));
}

function calculateForcedWaitForNewCat(timeLimitMinutes, remainingTimeMs) {
  // For 2-player games, when a player becomes a cat after capture,
  // force a wait time to prevent immediate revenge hunting
  // Base: 1 minute minimum
  const minWaitMs = 1 * 60 * 1000; // 1 minute

  // Dynamic based on remaining time, but with less representation than initial cat wait
  // Use 1.5% of remaining time instead of 2.5%
  const dynamicRatio = 0.015; // 1.5%
  const dynamicWaitMs = remainingTimeMs * dynamicRatio;

  // Cap at 3 minutes maximum to keep it reasonable
  const maxWaitMs = 3 * 60 * 1000;

  return Math.max(minWaitMs, Math.min(dynamicWaitMs, maxWaitMs));
}

const defaultSettings = () => {
  const settings = {
  globalRadiusM: 500,
  jamRadiusM: 80,
  catCount: 1,
  catDelayMinutes: 0, // 0 = use dynamic calculation
  /** Zone globale qui rétrécit avec le temps */
  shrinkZoneEnabled: false,
  /** Fin forcée après X minutes (désactivable) */
  timeLimitEnabled: false,
  timeLimitMinutes: 30,
  /** random | manual — en manuel, l'hôte définit les chats avant « Démarrer la chasse » */
  catAssignmentMode: "random",
  gameMode: "tag_swap",
  /** Réservé à l'hôte : aperçu carte avec les mêmes cercles que les chats */
  hostCatMapPreview: false,
  };
  return settings;
};

/** Paliers de rayon + métadonnées pour l'UI (phase suivante, fin de palier). */
function getShrinkState(room) {
  const R0 = Number(room.settings.globalRadiusM) || 500;
  if (!room.settings.shrinkZoneEnabled || !room.huntStartedAt || !room.shrinkPhasesList) {
    return {
      currentRadius: (Number(room.powerZoneScale || 1) * R0),
      currentCenter: room.gameCenter,
      nextRadius: null,
      nextCenter: null,
      phaseEndsAt: null,
      currentPhase: 1,
      totalPhases: 1,
    };
  }

  const elapsed = Date.now() - room.huntStartedAt;
  const phases = room.shrinkPhasesList;
  const totalPhases = phases.length;
  
  // Find current phase
  let currentPhaseInfo = phases[totalPhases - 1]; // default to last
  let phaseIdx = totalPhases - 1;
  
  for (let i = 0; i < totalPhases; i++) {
    if (elapsed < phases[i].endTime) {
      currentPhaseInfo = phases[i];
      phaseIdx = i;
      break;
    }
  }

  // Wait time and shrink time are driven by the pre-calculated waitRatio
  const phaseDuration = currentPhaseInfo.endTime - currentPhaseInfo.startTime;
  const shrinkStartTime = currentPhaseInfo.startTime + phaseDuration * currentPhaseInfo.waitRatio;

  let currentRadius, currentCenter;
  
  if (elapsed < shrinkStartTime) {
    // Waiting: keep start zone
    currentRadius = currentPhaseInfo.startZone.radius;
    currentCenter = currentPhaseInfo.startZone.center;
  } else if (elapsed < currentPhaseInfo.endTime) {
    // Shrinking: interpolate between start and end
    const progress = (elapsed - shrinkStartTime) / (phaseDuration * currentPhaseInfo.shrinkRatio);
    currentRadius = currentPhaseInfo.startZone.radius + (currentPhaseInfo.endZone.radius - currentPhaseInfo.startZone.radius) * progress;
    
    const latOffset = (currentPhaseInfo.endZone.center.lat - currentPhaseInfo.startZone.center.lat) * progress;
    const lngOffset = (currentPhaseInfo.endZone.center.lng - currentPhaseInfo.startZone.center.lng) * progress;
    currentCenter = {
      lat: currentPhaseInfo.startZone.center.lat + latOffset,
      lng: currentPhaseInfo.startZone.center.lng + lngOffset
    };
  } else {
    // Past phase end (should only happen for last phase if game didn't end)
    currentRadius = currentPhaseInfo.endZone.radius;
    currentCenter = currentPhaseInfo.endZone.center;
  }

  const scale = Number(room.powerZoneScale || 1);

  // Ne pas afficher de nextZone pour la dernière phase (phase d'attente pure)
  const isLastPhase = phaseIdx === totalPhases - 1;
  const isPureWaitPhase = currentPhaseInfo.shrinkRatio === 0.0;
  const showNextZone = !(isLastPhase && isPureWaitPhase);

  return {
    currentRadius: currentRadius * scale,
    currentCenter,
    nextRadius: showNextZone ? currentPhaseInfo.endZone.radius * scale : null,
    nextCenter: showNextZone ? currentPhaseInfo.endZone.center : null,
    phaseEndsAt: room.huntStartedAt + currentPhaseInfo.endTime,
    shrinkStartsAt: room.huntStartedAt + shrinkStartTime,
    phaseState:
      elapsed < shrinkStartTime
        ? "waiting"
        : elapsed < currentPhaseInfo.endTime
          ? "shrinking"
          : "stopped",
    currentPhase: phaseIdx + 1,
    totalPhases,
  };
}

/** Compute shrink state for an absolute timestamp (ms since epoch). */
function getShrinkStateAtTimestamp(room, absT) {
  if (!room || !room.shrinkPhasesList || !room.huntStartedAt) return getShrinkState(room);
  const elapsed = absT - room.huntStartedAt;
  const phases = room.shrinkPhasesList;
  const totalPhases = phases.length;
  if (elapsed <= 0) {
    return {
      currentRadius: phases[0].startZone.radius * (Number(room.powerZoneScale || 1)),
      currentCenter: phases[0].startZone.center,
      nextRadius: phases[0].endZone ? phases[0].endZone.radius * (Number(room.powerZoneScale || 1)) : null,
      nextCenter: phases[0].endZone ? phases[0].endZone.center : null,
      phaseEndsAt: room.huntStartedAt + phases[0].endTime,
      shrinkStartsAt: room.huntStartedAt + (phases[0].startTime + (phases[0].endTime - phases[0].startTime) * phases[0].waitRatio),
      phaseState: 'waiting',
      currentPhase: 1,
      totalPhases
    };
  }

  let currentPhaseInfo = phases[totalPhases - 1];
  let phaseIdx = totalPhases - 1;
  for (let i = 0; i < totalPhases; i++) {
    if (elapsed < phases[i].endTime) {
      currentPhaseInfo = phases[i];
      phaseIdx = i;
      break;
    }
  }

  const phaseDuration = currentPhaseInfo.endTime - currentPhaseInfo.startTime;
  const shrinkStartTime = currentPhaseInfo.startTime + phaseDuration * currentPhaseInfo.waitRatio;
  let currentRadius, currentCenter;
  if (elapsed < shrinkStartTime) {
    currentRadius = currentPhaseInfo.startZone.radius;
    currentCenter = currentPhaseInfo.startZone.center;
  } else if (elapsed < currentPhaseInfo.endTime) {
    const progress = (elapsed - shrinkStartTime) / (phaseDuration * currentPhaseInfo.shrinkRatio);
    currentRadius = currentPhaseInfo.startZone.radius + (currentPhaseInfo.endZone.radius - currentPhaseInfo.startZone.radius) * progress;
    const latOffset = (currentPhaseInfo.endZone.center.lat - currentPhaseInfo.startZone.center.lat) * progress;
    const lngOffset = (currentPhaseInfo.endZone.center.lng - currentPhaseInfo.startZone.center.lng) * progress;
    currentCenter = {
      lat: currentPhaseInfo.startZone.center.lat + latOffset,
      lng: currentPhaseInfo.startZone.center.lng + lngOffset,
    };
  } else {
    currentRadius = currentPhaseInfo.endZone.radius;
    currentCenter = currentPhaseInfo.endZone.center;
  }

  const scale = Number(room.powerZoneScale || 1);
  const isLastPhase = phaseIdx === totalPhases - 1;
  const isPureWaitPhase = currentPhaseInfo.shrinkRatio === 0.0;
  const showNextZone = !(isLastPhase && isPureWaitPhase);
  return {
    currentRadius: currentRadius * scale,
    currentCenter,
    nextRadius: showNextZone ? currentPhaseInfo.endZone.radius * scale : null,
    nextCenter: showNextZone ? currentPhaseInfo.endZone.center : null,
    phaseEndsAt: room.huntStartedAt + currentPhaseInfo.endTime,
    shrinkStartsAt: room.huntStartedAt + shrinkStartTime,
    phaseState:
      elapsed < shrinkStartTime
        ? "waiting"
        : elapsed < currentPhaseInfo.endTime
          ? "shrinking"
          : "stopped",
    currentPhase: phaseIdx + 1,
    totalPhases,
  };
}

function getEffectiveGlobalRadius(room) {
  const result = getShrinkState(room).currentRadius;
  return result;
}

function isInsideGameZone(lat, lng, room) {
  const shrinkState = getShrinkState(room);
  const gc = shrinkState.currentCenter;
  const r = shrinkState.currentRadius;
  const result = isInsideRadius(lat, lng, gc, r);
  return result;
}

function pushTimeline(room, evt) {
  if (!room.timelineEvents) room.timelineEvents = [];
  room.timelineEvents.push({ t: Date.now(), ...evt });
  // Keep only last 100 timeline events to reduce memory
  if (room.timelineEvents.length > 100) {
    room.timelineEvents.splice(0, room.timelineEvents.length - 100);
  }
  // Save to Supabase for long-term persistence
  saveTimelineEvent(room.code, evt.type, evt).catch(e => {
    console.error('Failed to save timeline event to Supabase:', e);
  });
}

function assignPlayerColors(room) {
  room.playerColors = {};
  let i = 0;
  for (const p of room.players.values()) {
    room.playerColors[p.sessionId] = COLOR_PALETTE[i % COLOR_PALETTE.length];
    i++;
  }
}

/** Recalcule le cercle de brouillage : fixe tant que la position réelle reste dans le disque. */
function updatePreyJamCircle(prey, jamRadiusM) {
  if (prey.lat == null || prey.lng == null) return { regenerated: false };
  if (!prey.jamCircleCenter) {
    prey.jamCircleCenter = randomOffsetPoint(prey.lat, prey.lng, jamRadiusM);
    prey.jamAnchorLat = prey.lat;
    prey.jamAnchorLng = prey.lng;
    return { regenerated: true };
  }
  const d = haversineMeters(
    prey.lat,
    prey.lng,
    prey.jamCircleCenter.lat,
    prey.jamCircleCenter.lng
  );
  if (d > jamRadiusM) {
    prey.jamCircleCenter = randomOffsetPoint(prey.lat, prey.lng, jamRadiusM);
    prey.jamAnchorLat = prey.lat;
    prey.jamAnchorLng = prey.lng;
    return { regenerated: true };
  }
  return { regenerated: false };
}

function maybeRecordJam(room, prey, center, radiusM, regenerated) {
  if (!room.jamHistory) room.jamHistory = [];
  if (!room._lastJamSample) room._lastJamSample = {};
  const t = Date.now();
  const sid = prey.sessionId;
  const lastT = room._lastJamSample[sid] || 0;
  if (!regenerated && t - lastT < 12000) return;
  room._lastJamSample[sid] = t;
  room.jamHistory.push({
    t,
    sessionId: sid,
    nickname: prey.nickname,
    center: { lat: center.lat, lng: center.lng },
    radiusM,
  });
  if (room.jamHistory.length > 3000) room.jamHistory.splice(0, room.jamHistory.length - 3000);
}

/** Une seule fois par tick avant d’envoyer les états. */
function syncJamCircles(room) {
  const jamR = room.settings.jamRadiusM;
  const gc = room.gameCenter;
  if (!gc) return;
  for (const p of room.players.values()) {
    if (p.role !== "player" || p.captured || p.spectator) {
      p.jamCircleCenter = null;
      p.jamAnchorLat = null;
      p.jamAnchorLng = null;
      continue;
    }
    if (p.lat == null || p.lng == null) continue;
    if (p.invisUntil != null && Date.now() < p.invisUntil) {
      continue;
    }
    if (!isInsideGameZone(p.lat, p.lng, room)) {
      p.jamCircleCenter = null;
      p.jamAnchorLat = null;
      p.jamAnchorLng = null;
      continue;
    }
    const { regenerated } = updatePreyJamCircle(p, jamR);
    if (p.jamCircleCenter) {
      maybeRecordJam(room, p, p.jamCircleCenter, jamR, regenerated);
    }
  }
}

function overpassRadiusM(radiusM) {
  return Math.max(50, Math.min(1200, Math.round(radiusM)));
}

function osmCacheKey(center, radiusM) {
  return `${center.lat.toFixed(3)},${center.lng.toFixed(3)},${Math.round(radiusM / 100) * 100}`;
}

function pointInOsmPolygon(lat, lng, geometry) {
  if (!Array.isArray(geometry) || geometry.length < 3) return false;
  let inside = false;
  for (let i = 0, j = geometry.length - 1; i < geometry.length; j = i++) {
    const yi = Number(geometry[i].lat);
    const xi = Number(geometry[i].lon);
    const yj = Number(geometry[j].lat);
    const xj = Number(geometry[j].lon);
    if ((yi > lat) !== (yj > lat)) {
      const xInt = ((xj - xi) * (lat - yi)) / (yj - yi + 1e-18) + xi;
      if (lng < xInt) inside = !inside;
    }
  }
  return inside;
}

function pickPointOnWayGeometry(geometry) {
  if (!Array.isArray(geometry) || geometry.length === 0) return null;
  const idx = Math.floor(Math.random() * geometry.length);
  const node = geometry[idx];
  const lat = Number(node.lat);
  const lng = Number(node.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function isOsmCandidateSafe(candidate, blockedAreas, room, effectiveCenter, effectiveRadius, baliseRadiusM) {
  if (!isInsideGameZone(candidate.lat, candidate.lng, room)) return false;
  if (haversineMeters(candidate.lat, candidate.lng, effectiveCenter.lat, effectiveCenter.lng) > effectiveRadius - baliseRadiusM) return false;
  for (const area of blockedAreas) {
    if (pointInOsmPolygon(candidate.lat, candidate.lng, area.geometry)) return false;
  }
  return ![...room.players.values()].some((p) => {
    if (p.lat == null || p.lng == null) return false;
    return haversineMeters(p.lat, p.lng, candidate.lat, candidate.lng) < Math.max(35, baliseRadiusM);
  });
}

async function fetchOsmBaliseCandidates(center, radiusM, maxRetries = 2) {
  if (!isValidCoordinates(center.lat, center.lng)) {
    console.warn('Invalid coordinates for OSM balise candidates:', center);
    return { walkways: [], crossingNodes: [], blockedAreas: [] };
  }

  const radius = overpassRadiusM(radiusM);
  const key = osmCacheKey(center, radius);
  const cached = osmBaliseCache.get(key);
  if (cached && Date.now() - cached.at < OSM_BALISE_CACHE_TTL_MS) return cached.data;

  const query = `[out:json][timeout:8];
(
  // Voies 100% piétonnes
  way(around:${radius},${center.lat},${center.lng})["highway"~"^(footway|path|pedestrian|steps|corridor)$"]["access"!~"^(private|no)$"];

  // Trottoirs présents sur une voie
  way(around:${radius},${center.lat},${center.lng})["sidewalk"~"^(both|left|right|yes|separate)$"]["access"!~"^(private|no)$"];

  // Passages piétons (ways et nodes)
  way(around:${radius},${center.lat},${center.lng})["highway"="crossing"]["access"!~"^(private|no)$"];
  way(around:${radius},${center.lat},${center.lng})["footway"="crossing"]["access"!~"^(private|no)$"];
  node(around:${radius},${center.lat},${center.lng})["highway"="crossing"]["access"!~"^(private|no)$"];

  // Espaces publics ouverts (hors terrains en asphalte)
  way(around:${radius},${center.lat},${center.lng})["leisure"~"^(stadium|park|playground|sports_centre)$"]["access"!~"^(private|no)$"];
  way(around:${radius},${center.lat},${center.lng})["leisure"="pitch"]["surface"!~"^asphalt$"]["access"!~"^(private|no)$"];
  way(around:${radius},${center.lat},${center.lng})["landuse"~"^(grass|meadow|recreation_ground|village_green)$"]["access"!~"^(private|no)$"];

  // Zones à éviter (bloquantes)
  way(around:${radius},${center.lat},${center.lng})["amenity"~"^(school|university|college)$"];
  way(around:${radius},${center.lat},${center.lng})["landuse"="residential"];
  way(around:${radius},${center.lat},${center.lng})["building"];
);
out center geom;`;

  // Try each Overpass endpoint with retries
  for (const overpassUrl of OVERPASS_URLS) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);
      try {
        const res = await fetch(overpassUrl, {
          method: "POST",
          headers: { 
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "accept": "application/json"
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Overpass ${res.status} from ${overpassUrl}`);
        const json = await res.json();
        const elements = Array.isArray(json.elements) ? json.elements : [];
        const isAccessibleWay = (x) => x.type === "way" && x.geometry?.length && (
          (x.tags?.highway && /^(footway|path|pedestrian|steps|corridor|crossing)$/.test(x.tags.highway)) ||
          (x.tags?.footway === "crossing") ||
          (typeof x.tags?.sidewalk === "string" && /^(both|left|right|yes|separate)$/.test(x.tags.sidewalk)) ||
          (x.tags?.leisure && (/^(stadium|park|playground|sports_centre|pitch)$/.test(x.tags.leisure)) && (x.tags.leisure !== "pitch" || x.tags.surface !== "asphalt")) ||
          (x.tags?.landuse && /^(grass|meadow|recreation_ground|village_green)$/.test(x.tags.landuse))
        );
        const crossingNodes = elements.filter((x) => x.type === "node" && x.tags?.highway === "crossing" && Number.isFinite(x.lat) && Number.isFinite(x.lon));
        const walkways = elements.filter(isAccessibleWay);
        const blockedAreas = elements.filter((x) => x.type === "way" && (
          x.tags?.landuse === "residential" || x.tags?.building || /^(school|university|college)$/.test(x.tags?.amenity || "")
        ) && x.geometry?.length >= 3);
        const data = { walkways, crossingNodes, blockedAreas };
        osmBaliseCache.set(key, { at: Date.now(), data });
        console.log(`Successfully fetched OSM data from ${overpassUrl}`);
        return data;
      } catch (error) {
        if (attempt === maxRetries) {
          console.warn(`Overpass API failed after ${maxRetries + 1} attempts on ${overpassUrl}:`, error?.message || error);
          // Try next endpoint
          break;
        }
        // Exponential backoff: 1s, 2s, 4s...
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  
  // All endpoints failed, return empty data
  console.warn('All Overpass endpoints failed, using fallback');
  return { walkways: [], crossingNodes: [], blockedAreas: [] };
}

async function pickOsmBalisePosition(room, effectiveCenter, effectiveRadius, baliseRadiusM) {
  try {
    const { walkways, crossingNodes, blockedAreas } = await fetchOsmBaliseCandidates(effectiveCenter, effectiveRadius);

    // Build a mixed pool of candidates: points from ways (random geometry nodes) and crossing nodes directly
    const wayPool = [...walkways].sort(() => Math.random() - 0.5);
    for (const way of wayPool) {
      for (let i = 0; i < 8; i++) {
        const candidate = pickPointOnWayGeometry(way.geometry);
        if (candidate && isOsmCandidateSafe(candidate, blockedAreas, room, effectiveCenter, effectiveRadius, baliseRadiusM)) {
          return { ...candidate, source: "osm", osmWayId: way.id };
        }
      }
    }

    const nodePool = [...crossingNodes].sort(() => Math.random() - 0.5);
    for (const node of nodePool) {
      const candidate = { lat: Number(node.lat), lng: Number(node.lon) };
      if (isOsmCandidateSafe(candidate, blockedAreas, room, effectiveCenter, effectiveRadius, baliseRadiusM)) {
        return { ...candidate, source: "osm", osmNodeId: node.id };
      }
    }
  } catch (e) {
    console.warn("Placement OSM balise indisponible:", e?.message || e);
  }
  return null;
}

function pickFallbackBalisePosition(room, effectiveCenter, effectiveRadius, baliseRadiusM) {
  let position = null;
  for (let i = 0; i < 20; i++) {
    const candidate = randomOffsetPoint(
      effectiveCenter.lat,
      effectiveCenter.lng,
      Math.max(1, effectiveRadius - baliseRadiusM),
      0.15,
      0.9
    );
    const tooCloseToPlayer = [...room.players.values()].some((p) => {
      if (p.lat == null || p.lng == null) return false;
      return haversineMeters(p.lat, p.lng, candidate.lat, candidate.lng) < Math.max(35, baliseRadiusM);
    });
    if (!tooCloseToPlayer) {
      position = candidate;
      break;
    }
  }
  return position || randomOffsetPoint(
    effectiveCenter.lat,
    effectiveCenter.lng,
    Math.max(1, effectiveRadius - baliseRadiusM),
    0.15,
    0.9
  );
}

async function spawnBalise(room, spawnAt = null) {
  if (!room.gameCenter) return;
  const t = Number.isFinite(spawnAt) ? spawnAt : Date.now();
  const shrink = spawnAt ? getShrinkStateAtTimestamp(room, t) : getShrinkState(room);
  const effectiveCenter = shrink.currentCenter || room.gameCenter;
  const effectiveRadius = shrink.currentRadius || getEffectiveGlobalRadius(room);
  const radiusFactor = 0.04 + Math.random() * 0.04;
  const baliseRadiusM = Math.max(18, Math.min(55, Math.round(effectiveRadius * radiusFactor)));

  let position = null;
  // Si un chat a programmé une balise-leurre, on l'utilise pour la prochaine balise uniquement
  if (room.nextBaliseOverride &&
      Number.isFinite(room.nextBaliseOverride.lat) &&
      Number.isFinite(room.nextBaliseOverride.lng)) {
    position = {
      lat: Number(room.nextBaliseOverride.lat),
      lng: Number(room.nextBaliseOverride.lng),
      source: "override_cat",
      osmWayId: null,
    };
    room.nextBaliseOverride = null;
  } else {
    position = await pickOsmBalisePosition(room, effectiveCenter, effectiveRadius, baliseRadiusM) ||
      pickFallbackBalisePosition(room, effectiveCenter, effectiveRadius, baliseRadiusM);
  }
  
  // Remove all existing balises (only one active at a time)
  room.balises = [];
  
  const balise = {
    id: uuidv4(),
    lat: position.lat,
    lng: position.lng,
    radiusM: baliseRadiusM,
    visualScale: Number((baliseRadiusM / 30).toFixed(2)),
    placementHint: position.source === "osm" ? "osm_pedestrian_way" : position.source || "fallback_random",
    osmWayId: position.osmWayId || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + (2 * 60 * 1000), // 2 minutes
    capturedBy: null,
    captureProgress: 0,
    beingCapturedBy: null,
  };
  room.balises.push(balise);
  pushTimeline(room, {
    type: "balise_spawned",
    baliseId: balise.id,
  });
  return balise;
}

function updateBalises(room, io) {
  if (room.phase !== "playing") return;
  
  const now = Date.now();
  const baliseSpawnInterval = 2 * 60 * 1000; // 2 minutes
  
  // Spawn new balise every 2 minutes OR if no balise exists
  if (!room.lastBaliseSpawnAt || now - room.lastBaliseSpawnAt >= baliseSpawnInterval || room.balises.length === 0) {
    if (!room.baliseSpawnPending) {
      room.baliseSpawnPending = true;
      room.lastBaliseSpawnAt = now;
      spawnBalise(room, room.lastBaliseSpawnAt)
        .catch((e) => {
          console.warn("Erreur création balise:", e?.message || e);
        })
        .finally(() => {
          room.baliseSpawnPending = false;
        });
    }
  }
  
  // Update balise capture progress
  const captureTime = 20 * 1000; // 20 seconds
  const toRemove = [];
  
  for (const balise of room.balises) {
    if (balise.capturedBy) {
      toRemove.push(balise.id);
      continue;
    }

    // Remove expired balises
    if (balise.expiresAt && now >= balise.expiresAt) {
      toRemove.push(balise.id);
      continue;
    }
    
    let currentPlayerInside = null;
    
    for (const p of room.players.values()) {
      if ((p.role !== "player" && p.role !== "cat") || p.captured || p.spectator) continue;
      if (p.lat == null || p.lng == null) continue;
      
      const distance = haversineMeters(p.lat, p.lng, balise.lat, balise.lng);
      if (distance <= balise.radiusM) {
        currentPlayerInside = p;
        break;
      }
    }
    
    if (currentPlayerInside) {
      // Vérifier si la balise est déjà capturée ou en cours de capture par un autre joueur
      if (balise.beingCapturedBy && balise.beingCapturedBy !== currentPlayerInside.sessionId) {
        // Envoyer une notification au joueur qui tente de capturer
        try {
          if (io && room.code) {
            io.to(room.code).emit("balise_capture_blocked", {
              sessionId: currentPlayerInside.sessionId,
              message: "La balise est déjà en cours de capture, vous ne pouvez pas la capturer."
            });
          }
        } catch (e) {
          console.warn('Failed to emit balise_capture_blocked socket event:', e?.message || e);
        }
        // Ne pas permettre la capture
        continue;
      }
      
      if (balise.beingCapturedBy === currentPlayerInside.sessionId) {
        balise.captureProgress += 1000; // Add 1 second (called every second)
      } else {
        balise.beingCapturedBy = currentPlayerInside.sessionId;
        balise.captureProgress = 1000;
      }
      
      if (balise.captureProgress >= captureTime) {
        balise.capturedBy = currentPlayerInside.sessionId;
        const award = 20; // Award 20 coins per user request
        // Award coins to both players and cats
        currentPlayerInside.coins = (currentPlayerInside.coins || 0) + award;
        recordCoinTransaction(currentPlayerInside, award, "balise", "Capture de balise");
        pushTimeline(room, {
          type: "balise_captured",
          baliseId: balise.id,
          sessionId: currentPlayerInside.sessionId,
          nickname: currentPlayerInside.nickname,
          role: currentPlayerInside.role,
          awardedCoins: award,
        });
        try {
          // Notify clients immediately so UI can show coin feed / capture toast
          if (io && room.code) {
            io.to(room.code).emit("balise_captured", {
              baliseId: balise.id,
              sessionId: currentPlayerInside.sessionId,
              nickname: currentPlayerInside.nickname,
              role: currentPlayerInside.role,
              awardedCoins: award,
            });
          }
        } catch (e) {
          console.warn('Failed to emit balise_captured socket event:', e?.message || e);
        }
        toRemove.push(balise.id);
      }
    } else {
      balise.beingCapturedBy = null;
      balise.captureProgress = 0;
    }
  }
  
  // Remove captured or expired balises
  if (toRemove.length > 0) {
    room.balises = room.balises.filter(b => !toRemove.includes(b.id));
    // Immediately spawn a new balise if one was captured
    if (!room.baliseSpawnPending) {
      room.baliseSpawnPending = true;
      room.lastBaliseSpawnAt = now;
      spawnBalise(room, room.lastBaliseSpawnAt)
        .catch((e) => {
          console.warn("Erreur création balise après capture:", e?.message || e);
        })
        .finally(() => {
          room.baliseSpawnPending = false;
        });
    }
  }
}

function appendLocationSample(room, player) {
  if (room.phase !== "playing") return;
  if (player.lat == null || player.lng == null) return;
  if (!room.traceBySession) room.traceBySession = {};
  const id = player.sessionId;
  if (!room.traceBySession[id]) room.traceBySession[id] = [];
  const arr = room.traceBySession[id];
  const t = Date.now();
  const last = arr[arr.length - 1];
  if (last && t - last.t < 1200) return;
  arr.push({ t, lat: player.lat, lng: player.lng });
  if (arr.length > 6000) arr.splice(0, arr.length - 6000);
}

function effectiveGlobalRadiusAtTimestamp(room, absT) {
  const settings = room.settings || {};
  const R0 = Number(settings.globalRadiusM) || 500;
  if (!settings.shrinkZoneEnabled || !room.huntStartedAt || !room.shrinkPhasesList) return R0;
  
  const elapsed = absT - room.huntStartedAt;
  const phases = room.shrinkPhasesList;
  const totalPhases = phases.length;
  
  if (elapsed <= 0) return R0;
  
  let currentPhaseInfo = phases[totalPhases - 1];
  for (let i = 0; i < totalPhases; i++) {
    if (elapsed < phases[i].endTime) {
      currentPhaseInfo = phases[i];
      break;
    }
  }

  const phaseDuration = currentPhaseInfo.endTime - currentPhaseInfo.startTime;
  const shrinkStartTime = currentPhaseInfo.startTime + phaseDuration * currentPhaseInfo.waitRatio;
  
  if (elapsed < shrinkStartTime) {
    return currentPhaseInfo.startZone.radius;
  } else if (elapsed < currentPhaseInfo.endTime) {
    const progress = (elapsed - shrinkStartTime) / (phaseDuration * currentPhaseInfo.shrinkRatio);
    return currentPhaseInfo.startZone.radius + (currentPhaseInfo.endZone.radius - currentPhaseInfo.startZone.radius) * progress;
  } else {
    return currentPhaseInfo.endZone.radius;
  }
}

function calculateWaitTimeToExclude(gameDurationMs) {
  if (!gameDurationMs || gameDurationMs <= 0) return 0;
  
  const baseWaitTimeMs = 5 * 60 * 1000; // 5 minutes
  const shortGameThresholdMs = 50 * 60 * 1000; // 50 minutes
  const maxExclusionRatio = 0.10; // 10%
  
  // Si la partie dure moins de 50 minutes, ajuster proportionnellement
  if (gameDurationMs < shortGameThresholdMs) {
    const maxExclusionMs = gameDurationMs * maxExclusionRatio;
    return Math.min(baseWaitTimeMs, maxExclusionMs);
  }
  
  // Sinon, exclure les 5 minutes complètes
  return baseWaitTimeMs;
}

function computePlayerAnalytics(room, timeline) {
  const trace = room.traceBySession || {};
  const metrics = {};
  const jamHistory = room.jamHistory || [];
  const orderedTimeline = Array.isArray(timeline) ? timeline : [];
  const jamCountBySession = {};
  for (const jam of jamHistory) {
    if (!jam || !jam.sessionId) continue;
    jamCountBySession[jam.sessionId] = (jamCountBySession[jam.sessionId] || 0) + 1;
  }
  const gameCenter = room.gameCenter;
  const huntStart = room.huntStartedAt != null ? room.huntStartedAt : null;
  const finishedAt = room.finishedAt != null ? room.finishedAt : null;
  const effectiveEnd = finishedAt != null ? finishedAt : Date.now();
  const gameDurationMs =
    huntStart != null ? Math.max(0, effectiveEnd - huntStart) : null;
  
  // Calculer le temps d'attente à exclure
  const waitTimeToExcludeMs = calculateWaitTimeToExclude(gameDurationMs);
  
  let totalDistance = 0;

  for (const [sid, points] of Object.entries(trace)) {
    if (!Array.isArray(points) || points.length === 0) continue;
    let distance = 0;
    let totalMs = 0;
    let maxSpeedMs = 0;
    let outsideMs = 0;
    let prev = null;
    for (const point of points) {
      if (
        !point ||
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lng) ||
        !Number.isFinite(point.t)
      ) {
        prev = null;
        continue;
      }
      if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.lng)) {
        const dt = Math.max(1, point.t - prev.t);
        const d = haversineMeters(prev.lat, prev.lng, point.lat, point.lng);
        distance += d;
        totalMs += dt;
        if (dt > 0) {
          const speedMs = d / (dt / 1000);
          if (Number.isFinite(speedMs) && speedMs > maxSpeedMs) {
            maxSpeedMs = speedMs;
          }
        }
        if (gameCenter) {
          const radius = effectiveGlobalRadiusAtTimestamp(room, point.t);
          if (!isInsideRadius(point.lat, point.lng, gameCenter, radius)) {
            outsideMs += dt;
          }
        }
      }
      prev = point;
    }
    const first = points[0];
    const last = points[points.length - 1];
    metrics[sid] = {
      distanceMeters: Number(distance.toFixed(2)),
      averageSpeedKmh:
        totalMs > 0 ? Number(((distance / totalMs) * 3600).toFixed(2)) : 0,
      maxSpeedKmh: Number((maxSpeedMs * 3.6).toFixed(2)),
      samples: points.length,
      totalTrackedMs: totalMs,
      timeOutsideZoneMs: Math.round(outsideMs),
      jamEvents: jamCountBySession[sid] || 0,
      firstSampleAt: first?.t ?? null,
      lastSampleAt: last?.t ?? null,
      lastKnownPosition: last
        ? { lat: last.lat, lng: last.lng, at: last.t }
        : null,
    };
    totalDistance += distance;
  }

  const eventsBySession = {};
  for (const ev of orderedTimeline) {
    if (!ev || !ev.sessionId) continue;
    if (!eventsBySession[ev.sessionId]) eventsBySession[ev.sessionId] = [];
    eventsBySession[ev.sessionId].push({
      type: ev.type,
      t: ev.t,
      by: ev.byNickname || null,
    });
  }

  let totalCatTimeMs = 0;
  const playersArray = [...room.players.values()];
  for (const player of playersArray) {
    const sid = player.sessionId;
    if (!metrics[sid]) {
      metrics[sid] = {
        distanceMeters: 0,
        averageSpeedKmh: 0,
        maxSpeedKmh: 0,
        samples: 0,
        totalTrackedMs: 0,
        timeOutsideZoneMs: 0,
        jamEvents: jamCountBySession[sid] || 0,
        firstSampleAt: null,
        lastSampleAt: null,
        lastKnownPosition: null,
      };
    }
    let catTime = player.catTimeMs || 0;
    
    // Exclure le temps d'attente initial pour le premier chat
    const isFirstCat = player.originalRole === "cat";
    if (isFirstCat && waitTimeToExcludeMs > 0) {
      catTime = Math.max(0, catTime - waitTimeToExcludeMs);
    }
    
    // Exclure le temps d'attente forcé après capture (pour parties à 2 joueurs)
    const forcedWaitTimeMs = player.forcedWaitTimeMs || 0;
    if (forcedWaitTimeMs > 0) {
      catTime = Math.max(0, catTime - forcedWaitTimeMs);
    }
    
    totalCatTimeMs += catTime;
    const playerEvents = eventsBySession[sid] || [];
    metrics[sid] = {
      ...metrics[sid],
      nickname: player.nickname,
      originalRole: player.originalRole,
      finalRole: player.role,
      spectator: Boolean(player.spectator),
      captured: Boolean(player.captured),
      coins: player.coins || 0,
      coinHistory: player.coinHistory || [],
      catTimeMs: catTime,
      timeAsPlayerMs:
        gameDurationMs != null ? Math.max(0, gameDurationMs - catTime) : null,
      eventLog: playerEvents,
      catTransitions: playerEvents
        .filter((e) => e.type === "became_cat")
        .map((e) => e.t),
      capturedAt:
        playerEvents.find((e) => e.type === "captured")?.t ?? null,
    };
  }

  const catTimeRanking = playersArray
    .map((p) => ({
      sessionId: p.sessionId,
      catTimeMs: metrics[p.sessionId]?.catTimeMs || 0,
      distanceMeters: metrics[p.sessionId]?.distanceMeters || 0,
    }))
    .sort((a, b) => a.catTimeMs - b.catTimeMs);

  const infectionOrder = orderedTimeline
    .filter((ev) => ev.type === "became_cat" && ev.sessionId)
    .map((ev) => ev.sessionId);

  const capturedOrder = orderedTimeline
    .filter((ev) => ev.type === "captured" && ev.sessionId)
    .map((ev) => ev.sessionId);

  const survivors = playersArray.filter(
    (p) => !p.spectator && !p.captured && p.role === "player"
  );

  return {
    players: metrics,
    game: {
      mode: room.settings?.gameMode || "tag_swap",
      huntStartedAt: room.huntStartedAt || null,
      endedAt: room.finishedAt || null,
      durationMs: gameDurationMs,
      totalDistanceMeters: Number(totalDistance.toFixed(2)),
      totalCatTimeMs,
      totalJamEvents: jamHistory.length,
      playerCount: playersArray.filter((p) => !p.spectator).length,
      catTimeRanking,
      infectionOrder,
      capturedOrder,
      lastSurvivorSessionId:
        survivors.length === 1 ? survivors[0].sessionId : null,
    },
  };
}

function buildGameSummary(room) {
  const paths = {};
  for (const [sid, pts] of Object.entries(room.traceBySession || {})) {
    paths[sid] = pts.map((x) => ({ ...x }));
  }
  const timeline = [...(room.timelineEvents || [])].sort((a, b) => a.t - b.t);
  const analytics = computePlayerAnalytics(room, timeline);
  return {
    code: room.code,
    huntStartedAt: room.huntStartedAt,
    endedAt: room.finishedAt,
    gameCenter: room.gameCenter,
    globalRadiusM: room.settings.globalRadiusM,
    jamRadiusM: room.settings.jamRadiusM,
    settingsSnapshot: { ...room.settings },
    timeline,
    paths,
    jamHistory: [...(room.jamHistory || [])],
    players: [...room.players.values()].map((p) => {
      const playerAnalytics = analytics.players[p.sessionId] || {};
      return {
        sessionId: p.sessionId,
        nickname: p.nickname,
        role: p.role,
        originalRole: p.originalRole,
        spectator: Boolean(p.spectator),
        captured: Boolean(p.captured),
        coins: p.coins || 0,
        coinHistory: p.coinHistory || [],
        totalCatTimeMs:
          playerAnalytics.catTimeMs != null
            ? playerAnalytics.catTimeMs
            : p.catTimeMs || 0,
        totalPlayerTimeMs:
          playerAnalytics.timeAsPlayerMs != null
            ? playerAnalytics.timeAsPlayerMs
            : null,
      };
    }),
    colors: { ...(room.playerColors || {}) },
    partyChat: [...(room.partyChat || [])].slice(-200),
    shrinkPhasesList: room.shrinkPhasesList
      ? room.shrinkPhasesList.map((ph) => ({
          ...ph,
          startZone: ph.startZone ? { ...ph.startZone, center: { ...ph.startZone.center } } : null,
          endZone: ph.endZone ? { ...ph.endZone, center: { ...ph.endZone.center } } : null,
        }))
      : null,
    balises: [...(room.balises || [])],
    analytics,
  };
}

export function createRoomsStore({
  onSessionInvalidated,
  onRoomNuked,
} = {}) {
  const rooms = new Map();
  const socketToRoom = new Map();
  const emptyRoomTimers = new Map();

  function getRoomByCode(code) {
    const result = rooms.get(code?.toUpperCase());
    return result;
  }

  function leaveRoom(socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) {
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      socketToRoom.delete(socketId);
      return;
    }
    room.players.delete(socketId);
    socketToRoom.delete(socketId);
    if (room.players.size === 0) {
      clearRoomAbandonTimer(code);
      rooms.delete(code);
    } else if (room.hostId === socketId) {
      const first = room.players.keys().next().value;
      room.hostId = first;
    }
    if (room.phase === "lobby" && room.players.size <= 2 && room.settings?.gameMode === "infection") {
      room.settings.gameMode = "tag_swap";
    }
  }

  function isSocketConnected(io, socketId) {
    const s = io.sockets.sockets.get(socketId);
    return Boolean(s?.connected);
  }

  function isDisconnectedGhost(p, io) {
    if (p.disconnectedAt == null) return false;
    return !isSocketConnected(io, p.socketId);
  }

  function countActivePlayers(room, io) {
    let n = 0;
    for (const p of room.players.values()) {
      if (p.role !== "player" || p.captured || p.spectator) continue;
      if (io && isDisconnectedGhost(p, io)) continue;
      n++;
    }
    return n;
  }

  function countConnectedInRoom(io, room) {
    let n = 0;
    for (const sid of room.players.keys()) {
      if (isSocketConnected(io, sid)) n++;
    }
    return n;
  }

  function clearRoomAbandonTimer(code) {
    const t = emptyRoomTimers.get(code);
    if (t) clearTimeout(t);
    emptyRoomTimers.delete(code);
  }

  function nukeRoom(io, room, reason = "empty") {
    const code = room.code;
    clearRoomAbandonTimer(code);
    const playersCopy = [...room.players.values()];
    for (const p of playersCopy) {
      onSessionInvalidated?.(p.sessionId);
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) {
        sock.emit("room_destroyed", { reason, code });
        sock.leave(code);
      }
      socketToRoom.delete(p.socketId);
    }
    room.players.clear();
    rooms.delete(code);
    onRoomNuked?.({ code, reason });
  }

  function scheduleNukeIfAllAway(io, room) {
    const code = room.code;
    if (countConnectedInRoom(io, room) > 0) {
      clearRoomAbandonTimer(code);
      return;
    }
    if (emptyRoomTimers.has(code)) return;
    const id = setTimeout(() => {
      emptyRoomTimers.delete(code);
      const r = rooms.get(code);
      if (!r || countConnectedInRoom(io, r) > 0) return;
      nukeRoom(io, r, "empty");
    }, 12 * 60 * 1000);
    emptyRoomTimers.set(code, id);
  }

  function purgeStaleDisconnects(io, room) {
    const ttlMs = 5 * 60 * 1000;
    const now = Date.now();
    const toRemove = [];
    for (const [sockId, p] of room.players) {
      if (!p.disconnectedAt) continue;
      if (isSocketConnected(io, sockId)) continue;
      if (now - p.disconnectedAt < ttlMs) continue;
      toRemove.push(sockId);
    }
    for (const sockId of toRemove) {
      const p = room.players.get(sockId);
      if (p) onSessionInvalidated?.(p.sessionId);
      room.players.delete(sockId);
      socketToRoom.delete(sockId);
    }
    if (room.players.size === 0) {
      nukeRoom(io, room, "empty");
      return true;
    }
    if (room.hostId && !room.players.has(room.hostId)) {
      room.hostId = room.players.keys().next().value;
    }
    return toRemove.length > 0;
  }

  function createRoom(socketId, nickname) {
    leaveRoom(socketId);
    let code;
    do {
      code = randomCode(5);
    } while (rooms.has(code));
    const sessionId = uuidv4();
    const player = {
      socketId,
      sessionId,
      nickname: String(nickname || "Joueur").slice(0, 24),
      role: null,
      originalRole: null,
      lat: null,
      lng: null,
      captured: false,
      spectator: false,
      disconnectedAt: null,
      jamCircleCenter: null,
      jamAnchorLat: null,
      jamAnchorLng: null,
      coins: 0,
      coinHistory: [],
      invisUntil: null,
      invisSince: null,
      invisFrozenLat: null,
      invisFrozenLng: null,
      movementLockedUntil: null,
      outOfBoundsOverrideUntil: null,
      outOfBoundsSince: null,
      lastCoinsLostAtBounds: 0,
      powerCooldowns: {},
    };
    const settings = defaultSettings();
    const room = {
      code,
      hostId: socketId,
      phase: "lobby",
      settings,
      gameCenter: null,
      catMapUnlockAt: null,
      players: new Map([[socketId, player]]),
      pendingJoins: [],
      partyChat: [],
      balises: [],
      lastBaliseSpawnAt: null,
      nextBaliseOverride: null,
      powerZoneScale: 1,
      powerZoneRaisedByPlayers: false,
      powerZoneMorphCatUses: 0,
      powerCosts: {
        noise: 20,
        invisibility_self: 40,
        invisibility_single: 70,
        invisibility_all_role: 130,
        zone_morph_player: 120,
        zone_morph_cat: 100,
        no_boundaries: 80,
        freeze_cats_single: 45,
        freeze_cats_multi: 80,
        freeze_cats_all: 140,
        balise_leurre: 60,
        fake_position: 60,
      },
      powerUses: {}, // { [sessionId]: { [powerKey]: count } }
      powerMaxUses: {
        balise_leurre: 1,
      },
      jamRadiusBaseM: Number(settings.jamRadiusM || 80),
      jamRadiusScale: 1,
    };
    rooms.set(code, room);
    socketToRoom.set(socketId, code);
    console.log(`Salle ${code} créée par ${player.nickname}`);
    return { room, player };
  }

  function joinRoom(socketId, code, nickname, existingSessionId = null) {
    leaveRoom(socketId);
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) {
      return { error: "Salle introuvable." };
    }
    if (room.phase !== "lobby") {
      if (room.phase === "finished") {
        return { error: "Cette partie est terminée." };
      }

      // Check if we are trying to rejoin an existing session
      if (existingSessionId) {
        let foundPlayer = null;
        for (const p of room.players.values()) {
          if (p.sessionId === existingSessionId) {
            foundPlayer = p;
            break;
          }
        }
        if (foundPlayer) {
          const oldSocketId = foundPlayer.socketId;
          foundPlayer.socketId = socketId;
          foundPlayer.disconnectedAt = null;
          if (oldSocketId && oldSocketId !== socketId) {
            room.players.delete(oldSocketId);
            socketToRoom.delete(oldSocketId);
          }
          room.players.set(socketId, foundPlayer);
          socketToRoom.set(socketId, room.code);
          if (room.hostId === oldSocketId) {
            room.hostId = socketId;
          }
          console.log(`Reconnexion dans ${room.code} · ${foundPlayer.nickname}`);
          
          // Restore active powers from Supabase
          getActivePowers(room.code, foundPlayer.sessionId).then(powers => {
            const now = Date.now();
            for (const power of powers) {
              const powerType = power.power_type;
              const powerData = power.power_data;
              const endsAt = new Date(power.ends_at).getTime();
              
              if (endsAt <= now) continue; // Skip expired powers
              
              if (powerType === "noise") {
                foundPlayer.noiseEffect = {
                  startedAt: new Date(power.started_at).getTime(),
                  durationSec: powerData.durationSec,
                  volume: powerData.volume,
                  by: powerData.by
                };
              } else if (powerType === "invisibility") {
                foundPlayer.invisUntil = endsAt;
                foundPlayer.invisSince = new Date(power.started_at).getTime();
                foundPlayer.invisFrozenLat = foundPlayer.lat;
                foundPlayer.invisFrozenLng = foundPlayer.lng;
                foundPlayer.invisUsedBy = powerData.usedBy;
              } else if (powerType === "freeze") {
                foundPlayer.movementLockedUntil = Math.max(Number(foundPlayer.movementLockedUntil || 0), endsAt);
              } else if (powerType === "fake_position") {
                // Cannot restore fake position without current location
                // Skip restoration for fake_position
              }
            }
            // Broadcast updated state to restore powers on client
            if (io && room.code) {
              io.to(room.code).emit("state", buildPlayingState(room, foundPlayer.sessionId));
            }
          }).catch(e => console.error('Failed to restore active powers from Supabase:', e));
          
          return { room, player: foundPlayer, isRejoin: true };
        }
      }

      return {
        error: "La partie a déjà commencé. Demandez à l'hôte de vous accepter.",
        joinRequestPossible: true,
        roomCode: room.code,
      };
    }
    // Check for duplicate nickname
    const normalizedNickname = String(nickname || "Joueur").slice(0, 24).toLowerCase();
    for (const player of room.players.values()) {
      if (player.nickname.toLowerCase() === normalizedNickname) {
        return { error: "Ce pseudo est déjà utilisé dans cette partie." };
      }
    }
    const sessionId = uuidv4();
    const player = {
      socketId,
      sessionId,
      nickname: String(nickname || "Joueur").slice(0, 24),
      role: null,
      originalRole: null,
      lat: null,
      lng: null,
      captured: false,
      spectator: false,
      disconnectedAt: null,
      jamCircleCenter: null,
      jamAnchorLat: null,
      jamAnchorLng: null,
      coins: 0,
      coinHistory: [],
      invisUntil: null,
      invisSince: null,
      invisFrozenLat: null,
      invisFrozenLng: null,
      movementLockedUntil: null,
      outOfBoundsOverrideUntil: null,
      outOfBoundsSince: null,
      lastCoinsLostAtBounds: 0,
      powerCooldowns: {},
    };
    room.players.set(socketId, player);
    socketToRoom.set(socketId, room.code);
    console.log(`Rejoint salle ${room.code} · ${player.nickname}`);
    return { room, player };
  }

  function updateSettings(socketId, partial) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== socketId) {
      return { error: "Seul l'hôte peut modifier les paramètres." };
    }
    if (room.phase !== "lobby") {
      return { error: "Réglages modifiables uniquement avant la révélation des rôles." };
    }
    const s = room.settings;
    if (partial.globalRadiusM != null) {
      const v = Number(partial.globalRadiusM);
      if (v >= 50 && v <= 5000) s.globalRadiusM = v;
    }
    if (partial.jamRadiusM != null) {
      const v = Number(partial.jamRadiusM);
      if (v >= 10 && v <= 500) s.jamRadiusM = v;
    }
    if (partial.catCount != null) {
      const v = Math.floor(Number(partial.catCount));
      if (v >= 1 && v < room.players.size) s.catCount = v;
    }
    if (partial.catDelayMinutes != null) {
      const v = Number(partial.catDelayMinutes);
      if (v >= 0 && v <= 30) s.catDelayMinutes = v;
    }
    if (partial.shrinkZoneEnabled != null) {
      s.shrinkZoneEnabled = Boolean(partial.shrinkZoneEnabled);
    }
    if (partial.shrinkDurationMinutes != null) {
      const v = Number(partial.shrinkDurationMinutes);
      if (v >= 1 && v <= 120) s.shrinkDurationMinutes = v;
    }
    if (partial.shrinkMinRadiusM != null) {
      const v = Number(partial.shrinkMinRadiusM);
      if (v >= 20 && v <= 2000) s.shrinkMinRadiusM = v;
    }
    if (partial.timeLimitEnabled != null) {
      s.timeLimitEnabled = Boolean(partial.timeLimitEnabled);
    }
    if (partial.timeLimitMinutes != null) {
      const v = Number(partial.timeLimitMinutes);
      if (v >= 1 && v <= 180) s.timeLimitMinutes = v;
    }
    if (partial.shrinkPhases != null) {
      const v = Math.floor(Number(partial.shrinkPhases));
      if (v >= 2 && v <= 20) s.shrinkPhases = v;
    }
    if (partial.catAssignmentMode === "random" || partial.catAssignmentMode === "manual") {
      s.catAssignmentMode = partial.catAssignmentMode;
    }
    if (partial.gameMode === "infection") {
      if (room.players.size <= 2) {
        return { error: "Le mode chats cumulés est disponible à partir de 3 joueurs." };
      }
      s.gameMode = partial.gameMode;
    } else if (partial.gameMode === "tag_swap") {
      s.gameMode = partial.gameMode;
    }
    if (partial.hostCatMapPreview != null) {
      s.hostCatMapPreview = Boolean(partial.hostCatMapPreview);
    }
    return { ok: true, room };
  }

  function computeGameCenter(room) {
    const coords = [];
    for (const p of room.players.values()) {
      if (p.lat != null && p.lng != null) {
        coords.push({ lat: p.lat, lng: p.lng });
      }
    }
    if (coords.length === 0) return null;
    const lat =
      coords.reduce((a, c) => a + c.lat, 0) / coords.length;
    const lng =
      coords.reduce((a, c) => a + c.lng, 0) / coords.length;
    return { lat, lng };
  }

  function startRoles(socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) {
      return { error: "Pas dans une salle." };
    }
    const room = rooms.get(code);
    if (!room || room.hostId !== socketId) {
      return { error: "Seul l'hôte peut lancer la révélation." };
    }
    if (room.phase !== "lobby") {
      return { error: "Les rôles sont déjà attribués." };
    }
    const list = [...room.players.values()];
    if (list.length < 2) {
      return { error: "Au moins 2 joueurs sont nécessaires pour lancer." };
    }
    const { catCount } = room.settings;
    if (catCount >= list.length) {
      return { error: "Le nombre de chats doit être inférieur au nombre de joueurs." };
    }
    const center = computeGameCenter(room);
    if (!center) {
      return {
        error:
          "Position GPS indisponible pour le centre de la zone. Activez le GPS.",
      };
    }
    room.gameCenter = center;
    room.phase = "role_reveal";
    room.catMapUnlockAt = null;
    if ((room.settings.catAssignmentMode || "random") === "manual") {
      list.forEach((p) => {
        p.role = "player";
        p.originalRole = "player";
        p.captured = false;
        p.spectator = false;
        p.catTimeMs = 0;
        p.catSince = null;
        p.jamCircleCenter = null;
        p.jamAnchorLat = null;
        p.jamAnchorLng = null;
      });
    } else {
      const shuffled = [...list].sort(() => Math.random() - 0.5);
      shuffled.forEach((p, i) => {
        const r = i < catCount ? "cat" : "player";
        p.role = r;
        p.originalRole = r;
        p.captured = false;
        p.spectator = false;
        p.catTimeMs = 0;
        p.catSince = r === "cat" ? Date.now() : null;
        p.jamCircleCenter = null;
        p.jamAnchorLat = null;
        p.jamAnchorLng = null;
      });
    }
    console.log(`Rôles révélés pour la salle ${room.code}`);
    return { ok: true, room };
  }

  function beginHunt(socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) {
      return { error: "Pas dans une salle." };
    }
    const room = rooms.get(code);
    if (!room || room.hostId !== socketId) {
      return { error: "Seul l'hôte peut démarrer la chasse." };
    }
    if (room.phase !== "role_reveal") {
      return { error: "Révélez d'abord les rôles." };
    }
    const list = [...room.players.values()];
    if (list.length < 2) {
      return { error: "Au moins 2 joueurs sont nécessaires." };
    }
    if ((room.settings.gameMode || "tag_swap") === "infection" && list.length <= 2) {
      return { error: "Le mode chats cumulés nécessite au moins 3 joueurs." };
    }
    if ((room.settings.catAssignmentMode || "random") === "manual") {
      const { catCount } = room.settings;
      let cats = 0;
      for (const p of list) {
        if (p.role === "cat" && !p.spectator) cats++;
      }
      if (cats !== catCount) {
        return {
          error: `En mode manuel, choisissez exactement ${catCount} chat(s). Actuellement : ${cats}.`,
        };
      }
    }
    room.phase = "playing";
    room.huntStartedAt = Date.now();
    
    // Generate Fortnite-like shrink zones
    if (room.settings.shrinkZoneEnabled) {
      const timeLimitMs = Math.max(1, Number(room.settings.timeLimitMinutes) || 30) * 60 * 1000;
      const R0 = Number(room.settings.globalRadiusM) || 500;
      const Rmin = 70;
      const phaseCount = calculateAdaptivePhaseCount(room.settings.timeLimitMinutes || 30, R0);

      // Réserver un pourcentage adaptatif du temps total pour la phase d'attente finale à 70m
      const finalWaitRatio = calculateFinalWaitRatio(room.settings.timeLimitMinutes || 30);
      const shrinkTimeMs = timeLimitMs * (1 - finalWaitRatio); // Le reste pour le rétrécissement
      const finalWaitTimeMs = timeLimitMs * finalWaitRatio; // Pourcentage adaptatif pour l'attente finale
      
      let currentCenter = { ...room.gameCenter };
      const zones = [];
      const phasesList = [];
      
      const phaseWeights = [];
      for (let i = 0; i < phaseCount; i++) {
        const isFirst = i === 0;
        const isLast = i === phaseCount - 1;
        const isSecondLast = i === phaseCount - 2;

        let waitRatio, shrinkRatio;
        if (isLast) {
          waitRatio = 0.5;  // Attendre 50% du temps
          shrinkRatio = 0.5; // Rétrécir pendant 50% du temps
        } else if (isSecondLast) {
          waitRatio = 0.8;
          shrinkRatio = 0.2;
        } else if (isFirst) {
          waitRatio = 0.7;
          shrinkRatio = 0.3;
        } else {
          waitRatio = 0.4;
          shrinkRatio = 0.6;
        }

        let weight;
        if (i === 0) weight = 3; 
        else if (i === 1) weight = 2;
        else if (isLast) weight = 1.5; 
        else if (isSecondLast) weight = 1.5; 
        else weight = 1;

        phaseWeights.push({ weight, waitRatio, shrinkRatio });
      }

      const totalWeight = phaseWeights.reduce((sum, p) => sum + p.weight, 0);

      let timeAccum = 0;
      for (let i = 0; i <= phaseCount; i++) {
        const x = i / phaseCount;
        const r = Rmin + (R0 - Rmin) * (1 - x * x);
        
        if (i === 0) {
          zones.push({ center: currentCenter, radius: r });
        } else {
          const prev = zones[i-1];
          const maxOffset = Math.max(0, prev.radius - r);
          // random offset inside
          const dist = Math.random() * maxOffset * 0.8; 
          const angle = Math.random() * 2 * Math.PI;
          currentCenter = offsetMeters(prev.center.lat, prev.center.lng, angle * (180 / Math.PI), dist);
          zones.push({ center: currentCenter, radius: r });
        }
      }
      
      for (let i = 0; i < phaseCount; i++) {
        const p = phaseWeights[i];
        const durationMs = shrinkTimeMs * (p.weight / totalWeight);

        const startMs = timeAccum;
        timeAccum += durationMs;
        const endMs = timeAccum;

        phasesList.push({
          startTime: startMs,
          endTime: endMs,
          waitRatio: p.waitRatio,
          shrinkRatio: p.shrinkRatio,
          startZone: zones[i],
          endZone: zones[i+1]
        });
      }

      // Ajouter une phase d'attente pure à 70m après la dernière phase
      const finalStartMs = timeAccum;
      const finalEndMs = timeAccum + finalWaitTimeMs;
      phasesList.push({
        startTime: finalStartMs,
        endTime: finalEndMs,
        waitRatio: 1.0,  // Attente pure
        shrinkRatio: 0.0, // Pas de rétrécissement
        startZone: zones[phaseCount], // Zone de 70m
        endZone: zones[phaseCount]    // Même zone (pas de changement)
      });

      room.shrinkPhasesList = phasesList;
    } else {
      room.shrinkPhasesList = null;
    }

    room.traceBySession = {};
    room.jamHistory = [];
    room._lastJamSample = {};
    room.balises = [];
    room.initialPlayerCount = list.filter((p) => !p.spectator).length;
    room.initialRemainingPlayerCount = list.filter((p) => p.role === "player" && !p.spectator).length;
    room.lastBaliseSpawnAt = null;
    assignPlayerColors(room);
    pushTimeline(room, {
      type: "hunt_started",
      message: "La chasse a commencé",
    });
    // Calculate dynamic cat delay based on game duration, circle size, and player count
    const timeLimitMinutes = Math.max(1, Number(room.settings.timeLimitMinutes) || 30);
    const globalRadiusM = Number(room.settings.globalRadiusM) || 500;
    const playerCount = list.filter((p) => !p.spectator).length;
    const dynamicDelayMs = calculateDynamicCatDelay(timeLimitMinutes, globalRadiusM, playerCount);
    // Allow manual override via catDelayMinutes setting if set
    const manualDelayMs = Math.max(0, Number(room.settings.catDelayMinutes) || 0) * 60 * 1000;
    const delayMs = manualDelayMs > 0 ? manualDelayMs : dynamicDelayMs;
    room.catMapUnlockAt = Date.now() + delayMs;
    console.log(`Chasse démarrée (${room.code}) · carte chats vers ${new Date(room.catMapUnlockAt).toLocaleTimeString()} (délai: ${Math.round(delayMs / 1000 / 60)}min)`);
    return { ok: true, room };
  }

  function finishGame(io, room, reason = "natural") {
    if (room.phase !== "playing") return;
    const now = Date.now();
    for (const p of room.players.values()) {
      if (p.role === "cat" && p.catSince) {
        p.catTimeMs = (p.catTimeMs || 0) + (now - p.catSince);
        p.catSince = now;
      }
    }
    room.phase = "finished";
    room.finishedAt = now;
    const messages = {
      admin: "Partie terminée par l'hôte",
      time_limit: "Limite de temps atteinte",
      all_cats: "Tous les joueurs sont devenus chats",
      last_survivor: "Dernier survivant",
      no_prey_left: "Plus aucun joueur en jeu",
    };
    const msg = messages[reason] || "Partie terminée";
    pushTimeline(room, {
      type: "game_over",
      reason,
      message: msg,
    });
    const summary = buildGameSummary(room);
    
    // Save to Supabase
    saveGameSummary({
      code: summary.code,
      huntStartedAt: summary.huntStartedAt,
      endedAt: summary.endedAt,
      durationMs: summary.endedAt && summary.huntStartedAt ? summary.endedAt - summary.huntStartedAt : null,
      gameCenter: summary.gameCenter,
      globalRadiusM: summary.globalRadiusM,
      jamRadiusM: summary.jamRadiusM,
      settingsSnapshot: summary.settingsSnapshot,
      players: summary.players,
      colors: summary.colors,
      partyChat: summary.partyChat,
      shrinkPhasesList: summary.shrinkPhasesList,
      balises: summary.balises,
      analytics: summary.analytics,
    }).catch((err) => {
      console.error('Failed to save game summary to Supabase:', err);
    });

    // Delete room from active_rooms in Supabase since it's finished
    deleteActiveRoom(room.code).catch(e => {
      console.error('Failed to delete active room from Supabase:', e);
    });

    // Schedule room deletion from memory after a short delay (to allow clients to receive game_finished)
    setTimeout(() => {
      rooms.delete(room.code);
      console.log(`Room ${room.code} removed from memory after finishing`);
    }, 5000);

    io.to(room.code).emit("game_finished", summary);
  }

  function checkTimeLimit(io, room) {
    if (room.phase !== "playing") return;
    if (!room.settings.timeLimitEnabled || !room.huntStartedAt) return;
    const mins = Math.max(1, Number(room.settings.timeLimitMinutes) || 30);
    if (Date.now() - room.huntStartedAt >= mins * 60 * 1000) {
      finishGame(io, room, "time_limit");
    }
  }

  function checkEndGame(io, room) {
    if (room.phase !== "playing") return;
    const active = [...room.players.values()].filter((p) => !p.spectator && !p.captured);
    if (active.length > 0 && active.every((p) => p.role === "cat")) {
      finishGame(io, room, "all_cats");
      return;
    }
    const playersLeft = active.filter((p) => p.role === "player");
    if ((room.settings.gameMode || "tag_swap") === "infection" && (room.initialRemainingPlayerCount || 0) > 1 && playersLeft.length === 1) {
      finishGame(io, room, "last_survivor");
    }
  }

  function buildRolesRevealPayload(room) {
    return {
      code: room.code,
      phase: room.phase,
      settings: { ...room.settings },
      gameCenter: room.gameCenter,
      players: [...room.players.values()].map((p) => ({
        sessionId: p.sessionId,
        nickname: p.nickname,
        role: p.role,
        originalRole: p.originalRole,
        hasSeenRole: p.hasSeenRole || false,
        lat: p.lat,
        lng: p.lng,
      })),
      hostSessionId: room.players.get(room.hostId)?.sessionId ?? null,
      partyChat: [...(room.partyChat || [])].slice(-80),
    };
  }

  function setPosition(socketId, lat, lng) {
  const code = socketToRoom.get(socketId);
  if (!code) {
    return null;
  }
  const room = rooms.get(code);
  if (!room) {
    return null;
  }
  if (room.phase === "finished") {
    return null;
  }
  const p = room.players.get(socketId);
  if (!p) {
    return null;
  }
  // If immobilized, ignore movement while lock is active
  if (p.movementLockedUntil != null && Date.now() < p.movementLockedUntil) {
    return { room, player: p };
  }
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return null;
  }
  if (la < -90 || la > 90 || lo < -180 || lo > 180) {
    return null;
  }
  
  // Check out of bounds status changes
  if (room.phase === "playing" && !p.spectator && !p.captured && room.gameCenter) {
    const wasOutOfBounds = p.lat != null && p.lng != null ? !isInsideGameZone(p.lat, p.lng, room) : false;
    let isNowOutOfBounds = !isInsideGameZone(la, lo, room);
    if (p.outOfBoundsOverrideUntil != null && Date.now() < p.outOfBoundsOverrideUntil) {
      isNowOutOfBounds = false;
    }

    if (!wasOutOfBounds && isNowOutOfBounds) {
      p.justWentOutOfBounds = true;
      p.outOfBoundsSince = Date.now(); // Track when player went out of bounds
    }
    if (wasOutOfBounds && !isNowOutOfBounds) {
      p.justReenteredZone = true;
      p.outOfBoundsSince = null; // Reset when player reenters
    }

    // Progressive coin loss when out of bounds
    if (isNowOutOfBounds && p.outOfBoundsSince != null) {
      const timeOutOfBoundsMs = Date.now() - p.outOfBoundsSince;
      const timeOutOfBoundsSec = timeOutOfBoundsMs / 1000;

      // Lose 1 coin every 10 seconds out of bounds (max 1 coin per second to avoid too much loss)
      const coinsToLose = Math.floor(timeOutOfBoundsSec / 10);
      const lastCoinsLost = p.lastCoinsLostAtBounds || 0;

      if (coinsToLose > lastCoinsLost && (p.coins || 0) > 0) {
        const coinsLost = Math.min(coinsToLose - lastCoinsLost, p.coins || 0);
        if (coinsLost > 0) {
          p.coins = Math.max(0, (p.coins || 0) - coinsLost);
          p.lastCoinsLostAtBounds = coinsToLose;
          p.justLostCoins = true; // Flag to trigger client update
          recordCoinTransaction(p, -coinsLost, "out_of_bounds", "Perte hors zone");
          pushTimeline(room, {
            type: "coins_lost_out_of_bounds",
            sessionId: p.sessionId,
            nickname: p.nickname,
            coinsLost: coinsLost,
          });
        }
      }
    }
  }

  p.lat = la;
  p.lng = lo;
  return { room, player: p };
  }

  function buildLobbyPayload(room, io = null) {
    const host = room.players.get(room.hostId);
    const withGps = [...room.players.values()].filter(
      (pl) => pl.lat != null && pl.lng != null
    ).length;
    const n = room.players.size;
    return {
      phase: room.phase,
      code: room.code,
      settings: { ...room.settings },
      players: [...room.players.values()].map((pl) => ({
        sessionId: pl.sessionId,
        nickname: pl.nickname,
        disconnected: io
          ? isDisconnectedGhost(pl, io)
          : Boolean(pl.disconnectedAt),
      })),
      hostSessionId: host?.sessionId ?? null,
      hostHasPosition: host?.lat != null && host?.lng != null,
      canStartGps: withGps >= 1,
      canRevealRoles: n >= 2,
      partyChat: [...(room.partyChat || [])].slice(-80),
    };
  }

  function isCatMapLocked(room, viewer) {
    if (room.phase !== "playing") return false;
    if (viewer.spectator || viewer.role !== "cat") return false;
    const until = room.catMapUnlockAt;
    if (until == null) return false;
    return Date.now() < until;
  }

  function buildRoster(room, io) {
    const now = Date.now();
    return [...room.players.values()].map((p) => {
      const invisible = p.invisUntil != null && now < p.invisUntil;
      return {
        sessionId: p.sessionId,
        nickname: p.nickname,
        role: p.role,
        originalRole: p.originalRole,
        captured: p.captured,
        spectator: p.spectator,
        disconnected: io ? isDisconnectedGhost(p, io) : false,
        invisible,
        // Informations supplémentaires pour l'UI ghost (barre de temps restante)
        invisUntil: invisible ? p.invisUntil : null,
        invisSince: invisible ? p.invisSince : null,
        coins: p.coins || 0,
      };
    });
  }

  function buildPlayingPayloadForSocket(room, viewerSocketId, io) {
    const viewer = room.players.get(viewerSocketId);
    if (!viewer) return null;
    const { globalRadiusM, jamRadiusM } = room.settings;
    const center = room.gameCenter;
    const shrinkMeta = getShrinkState(room);
    const effectiveGlobalRadiusM = shrinkMeta.currentRadius;
    const effectiveGlobalCenter = shrinkMeta.currentCenter || center;
    const catMapLocked = isCatMapLocked(room, viewer);
    const mapUnlockAt = room.catMapUnlockAt;
    const huntStartedAt = room.huntStartedAt;
    const timeLimitMs =
      room.settings.timeLimitEnabled && huntStartedAt
        ? Math.max(1, Number(room.settings.timeLimitMinutes) || 30) * 60 * 1000
        : null;
    const now = Date.now();

    const others = [...room.players.values()].filter(
      (p) => p.socketId !== viewerSocketId
    );

    const payload = {
      phase: room.phase,
      code: room.code,
      settings: {
        globalRadiusM,
        jamRadiusM,
        catDelayMinutes: room.settings.catDelayMinutes,
        shrinkZoneEnabled: room.settings.shrinkZoneEnabled,
        shrinkDurationMinutes: room.settings.shrinkDurationMinutes,
        shrinkMinRadiusM: room.settings.shrinkMinRadiusM,
        shrinkPhases: room.settings.shrinkPhases,
        timeLimitEnabled: room.settings.timeLimitEnabled,
        timeLimitMinutes: room.settings.timeLimitMinutes,
        catAssignmentMode: room.settings.catAssignmentMode || "random",
        gameMode: room.settings.gameMode || "tag_swap",
        hostCatMapPreview: Boolean(room.settings.hostCatMapPreview),
      },
      jamRadiusBaseM: Number(room.jamRadiusBaseM || jamRadiusM || 80),
      jamRadiusScale: Number(room.jamRadiusScale || 1),
      powerCosts: room.powerCosts || null,
      gameCenter: center,
      effectiveGlobalCenter,
      effectiveGlobalRadiusM,
      nextPhaseCenter: shrinkMeta.nextCenter,
      nextPhaseRadiusM: shrinkMeta.nextRadius,
      phaseEndsAt: shrinkMeta.phaseEndsAt,
      shrinkStartsAt: shrinkMeta.shrinkStartsAt || null,
      zonePhaseState: shrinkMeta.phaseState || null,
      currentPhase: shrinkMeta.currentPhase,
      totalPhases: shrinkMeta.totalPhases,
      huntStartedAt,
      timeLimitEndsAt:
        timeLimitMs != null && huntStartedAt
          ? huntStartedAt + timeLimitMs
          : null,
      roster: buildRoster(room, io),
      catMapLocked,
      mapUnlockAt,
      hostSessionId: room.players.get(room.hostId)?.sessionId ?? null,
      me: {
        sessionId: viewer.sessionId,
        nickname: viewer.nickname,
        role: viewer.role,
        originalRole: viewer.originalRole,
        // En mode ghost (invisible), on laisse le joueur voir sa propre position
        lat: viewer.lat,
        lng: viewer.lng,
        captured: viewer.captured,
        spectator: viewer.spectator,
        coins: viewer.coins || 0,
        coinHistory: viewer.coinHistory || [],
        catTimeMs: (viewer.catTimeMs || 0) + (viewer.role === "cat" && viewer.catSince ? Date.now() - viewer.catSince : 0),
        outOfBounds: viewer.lat != null && viewer.lng != null ? !isInsideGameZone(viewer.lat, viewer.lng, room) : false,
        immobilizedUntil: viewer.movementLockedUntil || null,
        invisUntil: viewer.invisUntil || null,
        invisSince: viewer.invisSince || null,
        outOfBoundsOverrideUntil: viewer.outOfBoundsOverrideUntil || null,
        powerCooldowns: viewer.powerCooldowns || {},
        fakePosition: viewer.fakePosition || null,
        noiseEffect: viewer.noiseEffect && (now - viewer.noiseEffect.startedAt) <= viewer.noiseEffect.durationSec * 1000 ? viewer.noiseEffect : null,
      },
      myJamCircle: null,
      allies: [],
      catsExact: [],
      preyForCat: [],
      spectators: [],
      adminPreyPreview: null,
      partyChat: [...(room.partyChat || [])].slice(-80),
      balises: room.balises || [],
      nextBaliseAt: room.lastBaliseSpawnAt ? room.lastBaliseSpawnAt + 2 * 60 * 1000 : null,
      powerLimits: room.powerMaxUses || {},
      powerUses: room.powerUses?.[viewer.sessionId] || {},
    };

    if (catMapLocked) {
      return payload;
    }

    const viewerInvisActive = viewer.invisUntil != null && Date.now() < viewer.invisUntil;
    if (
      viewer.role === "player" &&
      !viewer.spectator &&
      !viewer.captured &&
      !viewerInvisActive &&
      viewer.jamCircleCenter &&
      viewer.lat != null
    ) {
      payload.myJamCircle = {
        center: viewer.jamCircleCenter,
        radiusM: jamRadiusM,
      };
    }

    for (const p of others) {
      // Check if this player has an active fake position
      const hasFakePosition = p.fakePosition && now < p.fakePosition.until;
      const displayLat = hasFakePosition ? p.fakePosition.lat : p.lat;
      const displayLng = hasFakePosition ? p.fakePosition.lng : p.lng;

      if (p.spectator || p.captured) {
        payload.spectators.push({
          sessionId: p.sessionId,
          nickname: p.nickname,
          lat: displayLat,
          lng: displayLng,
        });
        continue;
      }

      if (viewer.spectator || viewer.captured) {
        if (displayLat == null || displayLng == null) continue;
        const invisActive = p.invisUntil != null && now < p.invisUntil;
        // En mode ghost, on ne montre plus la position sur la carte
        if (invisActive) continue;
        payload.allies.push({
          sessionId: p.sessionId,
          nickname: p.nickname,
          role: p.role,
          lat: displayLat,
          lng: displayLng,
          disconnected: isDisconnectedGhost(p, io),
          outOfBounds: !isInsideGameZone(displayLat, displayLng, room),
          invisible: false,
        });
        continue;
      }

      if (viewer.role === "cat") {
        if (p.role === "cat") {
          if (displayLat == null || displayLng == null) continue;
          const invisActive = p.invisUntil != null && now < p.invisUntil;
          if (invisActive) continue;
          payload.catsExact.push({
            sessionId: p.sessionId,
            nickname: p.nickname,
            lat: displayLat,
            lng: displayLng,
            disconnected: isDisconnectedGhost(p, io),
            outOfBounds: !isInsideGameZone(displayLat, displayLng, room),
          });
        } else if (p.role === "player") {
          if (displayLat == null || displayLng == null) continue;
          const disc = isDisconnectedGhost(p, io);
          const invisActive = p.invisUntil != null && now < p.invisUntil;
          if (invisActive) {
            // Invisible prey fully hidden from cats
            continue;
          } else {
            const inside = isInsideGameZone(displayLat, displayLng, room);
            if (!inside) {
              payload.preyForCat.push({
                sessionId: p.sessionId,
                nickname: p.nickname,
                kind: "exact",
                lat: displayLat,
                lng: displayLng,
                disconnected: disc,
                outOfBounds: true,
              });
            } else if (p.jamCircleCenter || hasFakePosition) {
              // Si le joueur a une fausse position, utiliser le centre du cercle de brouillage de la fausse position
              const jamCenter = hasFakePosition ? (p.fakePosition.jamCircleCenter || { lat: p.fakePosition.lat, lng: p.fakePosition.lng }) : p.jamCircleCenter;
              payload.preyForCat.push({
                sessionId: p.sessionId,
                nickname: p.nickname,
                kind: "circle",
                center: jamCenter,
                radiusM: jamRadiusM,
                disconnected: disc,
              });
            }
          }
        }
      } else if (viewer.role === "player") {
        if (p.role === "player") {
          if (displayLat == null || displayLng == null) continue;
          const invisActive = p.invisUntil != null && now < p.invisUntil;
          if (invisActive) continue;
          
          // Si le joueur a une fausse position, envoyer aussi le cercle de brouillage autour de la fausse position
          const allyData = {
            sessionId: p.sessionId,
            nickname: p.nickname,
            lat: displayLat,
            lng: displayLng,
            disconnected: isDisconnectedGhost(p, io),
            invisible: false,
          };
          
          if (hasFakePosition) {
            // Utiliser le centre du cercle de brouillage de la fausse position
            allyData.jamCircleCenter = p.fakePosition.jamCircleCenter || { lat: p.fakePosition.lat, lng: p.fakePosition.lng };
            allyData.jamCircleRadiusM = jamRadiusM;
          } else if (p.jamCircleCenter) {
            allyData.jamCircleCenter = p.jamCircleCenter;
            allyData.jamCircleRadiusM = jamRadiusM;
          }
          
          payload.allies.push(allyData);
        } else if (p.role === "cat") {
          if (displayLat == null || displayLng == null) continue;
          const invisActive = p.invisUntil != null && now < p.invisUntil;
          if (invisActive) {
            // On ne montre pas non plus les chats en ghost
            continue;
          }
          payload.catsExact.push({
            sessionId: p.sessionId,
            nickname: p.nickname,
            lat: displayLat,
            lng: displayLng,
            disconnected: isDisconnectedGhost(p, io),
            outOfBounds: !isInsideGameZone(displayLat, displayLng, room),
            invisible: false,
          });
        }
      }
    }

    if (
      viewerSocketId === room.hostId &&
      room.settings.hostCatMapPreview &&
      !isCatMapLocked(room, viewer)
    ) {
      const prev = [];
      for (const p of room.players.values()) {
        if (p.socketId === viewerSocketId) continue;
        if (p.role !== "player" || p.captured || p.spectator) continue;
        if (p.lat == null || p.lng == null) continue;
        const inside = isInsideGameZone(p.lat, p.lng, room);
        const disc = isDisconnectedGhost(p, io);
        if (!inside) {
          prev.push({
            sessionId: p.sessionId,
            nickname: p.nickname,
            kind: "exact",
            lat: p.lat,
            lng: p.lng,
            disconnected: disc,
            outOfBounds: true,
          });
        } else if (p.jamCircleCenter) {
          prev.push({
            sessionId: p.sessionId,
            nickname: p.nickname,
            kind: "circle",
            center: p.jamCircleCenter,
            radiusM: jamRadiusM,
            disconnected: disc,
          });
        }
      }
      payload.adminPreyPreview = prev;
    }

    return payload;
  }

  function broadcastPlayingState(io, room) {
    if (room.phase !== "playing") return;
    checkTimeLimit(io, room);
    if (room.phase !== "playing") return;
    purgeStaleDisconnects(io, room);
    if (!rooms.get(room.code)) return;
    syncJamCircles(room);
    updateBalises(room, io);

    // Update fake positions with random credible movements
    const now = Date.now();
    for (const player of room.players.values()) {
      if (player.fakePosition && player.fakePosition.until > now) {
        // Update fake position every 2-3 seconds with more realistic movements
        if (!player.fakePosition.lastUpdate || now - player.fakePosition.lastUpdate > 2000 + Math.random() * 1000) {
          // Initialize movement direction if not set
          if (!player.fakePosition.movementDirection) {
            const angle = Math.random() * Math.PI * 2;
            // Speed varies: walk (~5km/h = ~1.4m/s) to run (~15km/h = ~4.2m/s)
            // With 2-3s update: ~3-12m per update
            const speed = 0.00005 + Math.random() * 0.0001; // ~5-12m per update
            player.fakePosition.movementDirection = {
              lat: Math.sin(angle) * speed,
              lng: Math.cos(angle) * speed,
              speed: speed
            };
          }

          // Occasionally change direction slightly for more natural movement
          if (Math.random() < 0.25) {
            const angleChange = (Math.random() - 0.5) * 0.3; // Smaller angle change
            const currentAngle = Math.atan2(
              player.fakePosition.movementDirection.lat,
              player.fakePosition.movementDirection.lng
            );
            const newAngle = currentAngle + angleChange;
            // Vary speed occasionally (walk vs run)
            const speed = player.fakePosition.movementDirection.speed * (0.7 + Math.random() * 0.6);
            player.fakePosition.movementDirection = {
              lat: Math.sin(newAngle) * speed,
              lng: Math.cos(newAngle) * speed,
              speed: speed
            };
          }

          // Apply movement with some randomness
          const randomFactor = 0.7 + Math.random() * 0.3; // 0.7 to 1.0
          const newLat = player.fakePosition.lat + player.fakePosition.movementDirection.lat * randomFactor;
          const newLng = player.fakePosition.lng + player.fakePosition.movementDirection.lng * randomFactor;

          // Ensure the new position is still in the game zone
          if (isInsideGameZone(newLat, newLng, room)) {
            player.fakePosition.lat = newLat;
            player.fakePosition.lng = newLng;
            player.fakePosition.lastUpdate = now;
          } else {
            // Reverse direction if hitting boundary
            player.fakePosition.movementDirection.lat *= -1;
            player.fakePosition.movementDirection.lng *= -1;
          }

          // Update jam circle only if fake position is far from current jam circle center
          // This simulates real behavior: jam circle follows player position
          if (player.fakePosition.jamCircleCenter) {
            const jamRadiusM = room.settings.jamRadiusM || 80;
            // Convert radius to degrees (approximate)
            const radiusInDegrees = jamRadiusM / 111000; // ~1 degree = 111km
            const distanceFromJamCenter = Math.sqrt(
              Math.pow(player.fakePosition.lat - player.fakePosition.jamCircleCenter.lat, 2) +
              Math.pow(player.fakePosition.lng - player.fakePosition.jamCircleCenter.lng, 2)
            );

            // Only update jam circle if fake position is more than 60% of radius away
            if (distanceFromJamCenter > radiusInDegrees * 0.6) {
              // Move jam circle center towards fake position
              const moveFactor = 0.3; // Move 30% towards fake position
              player.fakePosition.jamCircleCenter.lat += (player.fakePosition.lat - player.fakePosition.jamCircleCenter.lat) * moveFactor;
              player.fakePosition.jamCircleCenter.lng += (player.fakePosition.lng - player.fakePosition.jamCircleCenter.lng) * moveFactor;
              player.fakePosition.jamCircleLastUpdate = now;
            }
          }
        }
      } else if (player.fakePosition && player.fakePosition.until <= now) {
        // Remove expired fake position
        player.fakePosition = null;
      }
    }

    for (const socketId of room.players.keys()) {
      const sock = io.sockets.sockets.get(socketId);
      if (!sock) continue;
      const payload = buildPlayingPayloadForSocket(room, socketId, io);
      if (payload) sock.emit("game_state", payload);
    }
    checkEndGame(io, room);
  }

  function tryCapture(io, catSocketId, targetSessionId) {
    const code = socketToRoom.get(catSocketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.phase !== "playing") {
      return { error: "Pas de partie en cours." };
    }
    const cat = room.players.get(catSocketId);
    if (!cat || cat.role !== "cat" || cat.spectator) {
      return { error: "Seul un chat peut capturer." };
    }
    if (isCatMapLocked(room, cat)) {
      return { error: "La carte chat n'est pas encore déverrouillée." };
    }
    if (cat.lat == null || cat.lng == null) {
      return { error: "Position du chat inconnue." };
    }
    
    // Compter le nombre de joueurs actifs (non spectateurs)
    const activePlayerCount = countActivePlayers(room, io);
    
    // Anti-revanche pour 3 joueurs : vérifier si le chat essaie de capturer celui qui vient de le capturer
    if (activePlayerCount === 3) {
      if (!room.revengeCooldowns) room.revengeCooldowns = new Map();
      const cooldownKey = `${cat.sessionId}-${targetSessionId}`;
      const cooldownEnd = room.revengeCooldowns.get(cooldownKey);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        const remainingSeconds = Math.ceil((cooldownEnd - Date.now()) / 1000);
        return { error: `Attendez ${remainingSeconds}s avant de pouvoir capturer à nouveau ce joueur.` };
      }
    }
    
    // Vérifier si le chat est en délai d'attente (pour 2 joueurs)
    if (cat.captureCooldownUntil && Date.now() < cat.captureCooldownUntil) {
      const remainingSeconds = Math.ceil((cat.captureCooldownUntil - Date.now()) / 1000);
      return { error: `Attendez ${remainingSeconds}s avant de pouvoir capturer.` };
    }
    
    let prey = null;
    for (const p of room.players.values()) {
      if (p.sessionId === targetSessionId && p.role === "player" && !p.captured) {
        prey = p;
        break;
      }
    }
    if (!prey) return { error: "Cible invalide ou déjà capturée." };
    if (prey.lat == null || prey.lng == null) {
      return { error: "Position du joueur inconnue." };
    }
    
    // Transfer coins from prey to cat
    const preyCoins = prey.coins || 0;
    prey.coins = 0;
    cat.coins = (cat.coins || 0) + preyCoins;
    if (preyCoins > 0) {
      recordCoinTransaction(prey, -preyCoins, "capture", `Capture par ${cat.nickname}`);
      recordCoinTransaction(cat, preyCoins, "capture", `Capture de ${prey.nickname}`);
    }
    
    const mode = room.settings.gameMode || "tag_swap";
    if (mode === "tag_swap") {
      const now = Date.now();
      if (cat.catSince) {
        cat.catTimeMs = (cat.catTimeMs || 0) + (now - cat.catSince);
      }
      cat.role = "player";
      cat.captured = false;
      cat.spectator = false;
      cat.catSince = null;
      cat.jamCircleCenter = null;
      cat.jamAnchorLat = null;
      cat.jamAnchorLng = null;
      
      prey.role = "cat";
      prey.captured = false;
      prey.spectator = false;
      prey.catSince = now;
      prey.jamCircleCenter = null;
      prey.jamAnchorLat = null;
      prey.jamAnchorLng = null;

      // For 2-player games, force a wait time for the new cat to prevent immediate revenge
      if (activePlayerCount === 2) {
        const timeLimitMinutes = Math.max(1, Number(room.settings.timeLimitMinutes) || 30);
        const remainingTimeMs = room.settings.timeLimitEnabled && room.huntStartedAt
          ? Math.max(0, (room.huntStartedAt + timeLimitMinutes * 60 * 1000) - now)
          : timeLimitMinutes * 60 * 1000;
        const forcedWaitMs = calculateForcedWaitForNewCat(timeLimitMinutes, remainingTimeMs);
        prey.forcedWaitTimeMs = forcedWaitMs;
        prey.captureCooldownUntil = now + forcedWaitMs;
        console.log(`2-player game: New cat ${prey.nickname} will wait ${Math.round(forcedWaitMs / 1000)}s before hunting`);
        io.to(code).emit("capture_cooldown", {
          sessionId: prey.sessionId,
          cooldownSeconds: Math.round(forcedWaitMs / 1000),
          reason: "2_players_wait"
        });
      } else if (activePlayerCount === 3) {
        // Anti-revanche pour 3 joueurs : cooldown entre les mêmes joueurs
        if (!room.revengeCooldowns) room.revengeCooldowns = new Map();
        const cooldownKey = `${prey.sessionId}-${cat.sessionId}`;
        const revengeCooldownDuration = 30 * 1000; // 30 secondes
        room.revengeCooldowns.set(cooldownKey, now + revengeCooldownDuration);
        io.to(code).emit("revenge_cooldown", {
          hunterSessionId: prey.sessionId,
          targetSessionId: cat.sessionId,
          cooldownSeconds: 30
        });
      }
    } else {
      prey.captured = false;
      prey.role = "cat";
      prey.spectator = false;
      prey.catSince = Date.now();
      prey.jamCircleCenter = null;
      prey.jamAnchorLat = null;
      prey.jamAnchorLng = null;
    }
    pushTimeline(room, {
      type: "captured",
      sessionId: prey.sessionId,
      nickname: prey.nickname,
      bySessionId: cat.sessionId,
      byNickname: cat.nickname,
      coinsTransferred: preyCoins,
    });
    broadcastPlayingState(io, room);
    io.to(code).emit("capture_ok", {
      preySessionId: prey.sessionId,
      preyNickname: prey.nickname,
      coinsTransferred: preyCoins,
    });
    return { ok: true };
  }

  function adminKick(io, hostSocketId, targetSessionId) {
    const code = socketToRoom.get(hostSocketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== hostSocketId) {
      return { error: "Réservé à l'hôte." };
    }
    let targetSocket = null;
    for (const p of room.players.values()) {
      if (p.sessionId === targetSessionId) {
        targetSocket = p.socketId;
        break;
      }
    }
    if (targetSocket == null) return { error: "Joueur introuvable." };
    if (targetSocket === hostSocketId) {
      return { error: "Vous ne pouvez pas vous expulser." };
    }
    const sock = io.sockets.sockets.get(targetSocket);
    if (sock) {
      sock.emit("kicked", { reason: "Expulsé par l'hôte." });
      sock.leave(code);
      sock.disconnect(true);
    }
    leaveRoom(targetSocket);
    const r = rooms.get(code);
    if (r) {
      if (r.players.size === 0) {
        nukeRoom(io, r, "empty");
      } else if (r.phase === "lobby") {
        io.to(code).emit("lobby_update", buildLobbyPayload(r, io));
      } else if (r.phase === "role_reveal") {
        io.to(code).emit("roles_reveal", buildRolesRevealPayload(r));
      } else if (r.phase === "playing") {
        broadcastPlayingState(io, r);
      }
    }
    return { ok: true };
  }

  function adminSetRole(io, hostSocketId, targetSessionId, newRole) {
    const code = socketToRoom.get(hostSocketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== hostSocketId) {
      return { error: "Réservé à l'hôte." };
    }
    if (newRole !== "cat" && newRole !== "player") {
      return { error: "Rôle invalide." };
    }
    let target = null;
    for (const p of room.players.values()) {
      if (p.sessionId === targetSessionId) {
        target = p;
        break;
      }
    }
    if (!target) return { error: "Joueur introuvable." };
    const prevRole = target.role;
    const now = Date.now();
    if (prevRole === "cat" && newRole !== "cat" && target.catSince) {
      target.catTimeMs = (target.catTimeMs || 0) + (now - target.catSince);
      target.catSince = null;
    }
    target.role = newRole;
    target.captured = false;
    target.spectator = false;
    if (newRole === "cat" && prevRole !== "cat") {
      target.catSince = now;
    }
    target.jamCircleCenter = null;
    target.jamAnchorLat = null;
    target.jamAnchorLng = null;
    if (room.phase === "playing") {
      pushTimeline(room, {
        type: "role_changed",
        sessionId: target.sessionId,
        nickname: target.nickname,
        from: prevRole,
        to: newRole,
      });
      if (newRole === "cat" && prevRole === "player") {
        pushTimeline(room, {
          type: "became_cat",
          sessionId: target.sessionId,
          nickname: target.nickname,
        });
      }
    }
    if (room.phase === "role_reveal") {
      pushTimeline(room, {
        type: "admin_role_pick",
        sessionId: target.sessionId,
        nickname: target.nickname,
        role: newRole,
      });
      io.to(code).emit("roles_reveal", buildRolesRevealPayload(room));
    } else if (room.phase === "playing") {
      broadcastPlayingState(io, room);
    }
    io.to(code).emit("admin_role_changed", {
      targetSessionId,
      nickname: target.nickname,
      role: newRole,
    });
    return { ok: true };
  }

  function adminEndGame(io, hostSocketId) {
    const code = socketToRoom.get(hostSocketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== hostSocketId) {
      return { error: "Réservé à l'hôte." };
    }
    if (room.phase !== "playing") {
      return { error: "Aucune partie en cours." };
    }
    finishGame(io, room, "admin");
    return { ok: true };
  }

  function recomputeRemainingShrink(room) {
    if (!room.settings.shrinkZoneEnabled || !room.huntStartedAt) return;
    const now = Date.now();
    const elapsed = now - room.huntStartedAt;
    const totalMs = Math.max(1, Number(room.settings.timeLimitMinutes) || 30) * 60 * 1000;
    const remainingMs = totalMs - elapsed;
    if (remainingMs <= 0) return;

    const shrink = getShrinkState(room);
    const R0now = Number(shrink.currentRadius) || Number(room.settings.globalRadiusM) || 500;
    const Rmin = 70;

    // Réserver un pourcentage adaptatif du temps restant pour la phase d'attente finale à 70m
    const remainingMinutes = remainingMs / (60 * 1000);
    const finalWaitRatio = calculateFinalWaitRatio(remainingMinutes);
    const shrinkRemainingMs = remainingMs * (1 - finalWaitRatio); // Le reste pour le rétrécissement
    const finalWaitRemainingMs = remainingMs * finalWaitRatio; // Pourcentage adaptatif pour l'attente finale

    const past = Array.isArray(room.shrinkPhasesList)
      ? room.shrinkPhasesList.filter((ph) => (room.huntStartedAt + ph.endTime) <= now)
      : [];

    const count = calculateAdaptivePhaseCount(remainingMs / (60 * 1000), R0now);

    let currentCenter = shrink.currentCenter || room.gameCenter;
    const zones = [];
    for (let i = 0; i <= count; i++) {
      const x = i / count;
      const r = Rmin + (R0now - Rmin) * (1 - x * x);
      if (i === 0) zones.push({ center: currentCenter, radius: r });
      else {
        const prev = zones[i - 1];
        const maxOffset = Math.max(0, prev.radius - r);
        const dist = Math.random() * maxOffset * 0.8;
        const angle = Math.random() * 2 * Math.PI;
        currentCenter = offsetMeters(prev.center.lat, prev.center.lng, angle * (180 / Math.PI), dist);
        zones.push({ center: currentCenter, radius: r });
      }
    }

    const weights = [];
    for (let i = 0; i < count; i++) {
      const isFirst = i === 0;
      const isLast = i === count - 1;
      const isSecondLast = i === count - 2;
      let waitRatio, shrinkRatio;
      if (isLast) { waitRatio = 0.5; shrinkRatio = 0.5; }
      else if (isSecondLast) { waitRatio = 0.8; shrinkRatio = 0.2; }
      else if (isFirst) { waitRatio = 0.6; shrinkRatio = 0.4; }
      else { waitRatio = 0.4; shrinkRatio = 0.6; }

      let w;
      if (isFirst) w = 2.5; else if (i === 1) w = 1.8; else if (isSecondLast) w = 1.4; else if (isLast) w = 1.6; else w = 1.0;
      weights.push({ waitRatio, shrinkRatio, w });
    }
    const totalW = weights.reduce((s, p) => s + p.w, 0) || 1;

    const phases = [];
    let t = elapsed;
    for (let i = 0; i < count; i++) {
      const p = weights[i];
      const dur = shrinkRemainingMs * (p.w / totalW);
      const startTime = t;
      const endTime = t + dur;
      phases.push({
        startTime,
        endTime,
        waitRatio: p.waitRatio,
        shrinkRatio: p.shrinkRatio,
        startZone: zones[i],
        endZone: zones[i + 1],
      });
      t = endTime;
    }

    // Ajouter une phase d'attente pure à 70m après la dernière phase
    const finalStartMs = t;
    const finalEndMs = t + finalWaitRemainingMs;
    phases.push({
      startTime: finalStartMs,
      endTime: finalEndMs,
      waitRatio: 1.0,  // Attente pure
      shrinkRatio: 0.0, // Pas de rétrécissement
      startZone: zones[count], // Zone de 70m
      endZone: zones[count]    // Même zone (pas de changement)
    });

    room.shrinkPhasesList = past.concat(phases);
  }

  function adminAddTime(io, socketId, minutes) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== socketId) return { error: "Seul l'hôte peut modifier la durée." };
    if (room.phase !== "playing") return { error: "Partie non démarrée." };
    const add = Math.max(1, Math.floor(Number(minutes) || 0));
    room.settings.timeLimitEnabled = true;
    room.settings.timeLimitMinutes = Math.min(180, (Number(room.settings.timeLimitMinutes) || 30) + add);
    recomputeRemainingShrink(room);
    broadcastPlayingState(io, room);
    return { ok: true, room };
  }

  function requestJoinMidgame(socketId, code, nickname, io) {
    leaveRoom(socketId);
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return { error: "Salle introuvable." };
    if (room.phase === "lobby") {
      return { error: "LOBBY", useNormalJoin: true };
    }
    if (room.phase === "finished") {
      return { error: "Partie terminée." };
    }
    for (const p of room.players.values()) {
      if (p.socketId === socketId) {
        return { error: "Vous êtes déjà dans cette salle." };
      }
    }
    if (!room.pendingJoins) room.pendingJoins = [];
    const pending = {
      id: uuidv4(),
      socketId: socketId,
      nickname: String(nickname || "Joueur").slice(0, 24),
      requestedAt: Date.now(),
    };
    room.pendingJoins.push(pending);
    io.to(room.code).emit("join_request_pending", {
      requestId: pending.id,
      nickname: pending.nickname,
      code: room.code,
      hostSessionId: room.players.get(room.hostId)?.sessionId ?? null,
    });
    return { ok: true, requestId: pending.id };
  }

  function respondJoinRequest(io, responderSocketId, requestId, accept) {
    const code = socketToRoom.get(responderSocketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || !room.players.has(responderSocketId)) {
      return { error: "Réservé aux membres de la partie." };
    }
    if (!room.pendingJoins?.length) return { error: "Aucune demande." };
    const idx = room.pendingJoins.findIndex((x) => x.id === requestId);
    if (idx < 0) return { error: "Demande introuvable." };
    const pending = room.pendingJoins[idx];
    room.pendingJoins.splice(idx, 1);
    const reqSock = io.sockets.sockets.get(pending.socketId);
    if (!accept) {
      reqSock?.emit("join_request_denied", {
        code: room.code,
        message: "Votre demande a été refusée.",
      });
      return { ok: true };
    }
    if (!reqSock?.connected) {
      return { error: "Le joueur n'est plus connecté." };
    }
    const sessionId = uuidv4();
    const player = {
      socketId: pending.socketId,
      sessionId,
      nickname: pending.nickname,
      role: "player",
      originalRole: "player",
      lat: null,
      lng: null,
      captured: false,
      spectator: false,
      disconnectedAt: null,
      jamCircleCenter: null,
      jamAnchorLat: null,
      jamAnchorLng: null,
      coins: 0,
      invisUntil: null,
      invisSince: null,
      invisFrozenLat: null,
      invisFrozenLng: null,
      movementLockedUntil: null,
      outOfBoundsOverrideUntil: null,
      powerCooldowns: {},
    };
    room.players.set(pending.socketId, player);
    socketToRoom.set(pending.socketId, room.code);
    reqSock.join(room.code);
    if (!room.playerColors) room.playerColors = {};
    const colorIdx = Object.keys(room.playerColors).length;
    room.playerColors[sessionId] =
      COLOR_PALETTE[colorIdx % COLOR_PALETTE.length];
    if (room.phase === "role_reveal") {
      io.to(code).emit("roles_reveal", buildRolesRevealPayload(room));
    } else if (room.phase === "playing") {
      broadcastPlayingState(io, room);
    }
    reqSock.emit("join_request_accepted", {
      sessionId,
      code: room.code,
      isHost: false,
      phase: room.phase,
      lobby: room.phase === "lobby" ? buildLobbyPayload(room, io) : null,
      rolesReveal:
        room.phase === "role_reveal" ? buildRolesRevealPayload(room) : null,
      gameState:
        room.phase === "playing"
          ? buildPlayingPayloadForSocket(room, pending.socketId, io)
          : null,
    });
    return {
      ok: true,
      sessionId,
      code: room.code,
      joinerSocketId: pending.socketId,
      nickname: pending.nickname,
    };
  }

  function recordPlayerTimelineDisconnect(code, { nickname, sessionId }) {
    const room = rooms.get(code);
    if (!room || room.phase === "finished") return;
    pushTimeline(room, {
      type: "player_disconnected",
      nickname,
      sessionId,
    });
  }

  function recordPlayerTimelineReconnect(code, { nickname, sessionId }) {
    const room = rooms.get(code);
    if (!room || room.phase === "finished") return;
    pushTimeline(room, {
      type: "player_reconnected",
      nickname,
      sessionId,
    });
  }

  function partyChatSend(io, socketId, body) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.phase === "finished") {
      return { error: "Discussion indisponible." };
    }
    const player = room.players.get(socketId);
    if (!player) return { error: "Joueur introuvable." };
    const type = body?.type;
    if (type !== "text" && type !== "image" && type !== "location") {
      return { error: "Type de message inconnu." };
    }
    const id = uuidv4();
    const entry = {
      id,
      t: Date.now(),
      sessionId: player.sessionId,
      nickname: player.nickname,
      type,
    };
    if (type === "text") {
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!text) return { error: "Texte vide." };
      entry.text = text;
    } else if (type === "image") {
      const image = String(body.image || "").trim();
      if (!image.startsWith("data:image/")) {
        return { error: "Image invalide (data URL requis)." };
      }
      if (image.length > 450000) return { error: "Image trop volumineuse." };
      entry.image = image;
      const la = Number(body.lat);
      const lo = Number(body.lng);
      if (Number.isFinite(la) && Number.isFinite(lo)) {
        entry.lat = la;
        entry.lng = lo;
      }
    } else {
      const la = Number(body.lat);
      const lo = Number(body.lng);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        return { error: "Position invalide." };
      }
      entry.lat = la;
      entry.lng = lo;
    }
    if (!room.partyChat) room.partyChat = [];
    room.partyChat.push(entry);
    // Keep only last 50 chat messages to reduce memory
    if (room.partyChat.length > 50) {
      room.partyChat.splice(0, room.partyChat.length - 50);
    }
    // Save to Supabase for long-term persistence
    saveGameMessage(
      room.code,
      entry.sessionId,
      entry.nickname,
      entry.text || entry.image || '', // Use text or image as message content
      entry.type || 'text',
      entry.lat || null,
      entry.lng || null
    ).catch(e => {
      console.error('Failed to save game message to Supabase:', e);
    });
    io.to(room.code).emit("party_chat", entry);
    return { ok: true, entry };
  }

  function usePower(io, socketId, body) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.phase !== "playing") return { error: "Pas de partie en cours." };
    const actor = room.players.get(socketId);
    if (!actor || actor.spectator) return { error: "Action non autorisée." };
    const kind = String(body?.kind || "").toLowerCase();
    const now = Date.now();

    const ensureCoins = (p, cost, powerName = "power") => {
      if ((p.coins || 0) < cost) return false;
      p.coins = (p.coins || 0) - cost;
      recordCoinTransaction(p, -cost, "power", `Pouvoir: ${powerName}`);
      return true;
    };
    const findBySessionId = (sid) => {
      for (const p of room.players.values()) if (p.sessionId === sid) return p;
      return null;
    };
    const onCooldown = (p, key) => Number(p.powerCooldowns?.[key] || 0) > now;
    const setCooldown = (p, key, secs) => {
      if (!p.powerCooldowns) p.powerCooldowns = {};
      const until = now + Math.max(0, Math.floor(secs)) * 1000;
      p.powerCooldowns[key] = until;
      return until;
    };

    const incPowerUse = (p, key) => {
      if (!room.powerUses) room.powerUses = {};
      if (!room.powerUses[p.sessionId]) room.powerUses[p.sessionId] = {};
      const current = Number(room.powerUses[p.sessionId][key] || 0);
      room.powerUses[p.sessionId][key] = current + 1;
      return room.powerUses[p.sessionId][key];
    };
    const getPowerUses = (p, key) => {
      return Number(room.powerUses?.[p.sessionId]?.[key] || 0);
    };

    if (kind === "balise_leurre") {
      // Pouvoir spécial de chat : programmer la prochaine balise comme un leurre
      if (actor.role !== "cat") return { error: "Réservé aux chats." };
      const maxUses = Number(room.powerMaxUses?.balise_leurre || 1);
      const used = getPowerUses(actor, "balise_leurre");
      if (used >= maxUses) return { error: "Pouvoir déjà utilisé." };

      const lat = Number(body?.lat);
      const lng = Number(body?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { error: "Coordonnées invalides." };
      }

      // Vérifier que la position est dans la zone de jeu
      if (!isInsideGameZone(lat, lng, room)) {
        return { error: "Position hors de la zone de jeu." };
      }

      const cost = Number(room.powerCosts?.balise_leurre || 60);
      if (!ensureCoins(actor, cost, "balise_leurre")) return { error: "Pas assez de pièces." };

      room.nextBaliseOverride = {
        lat,
        lng,
        bySessionId: actor.sessionId,
      };

      incPowerUse(actor, "balise_leurre");
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    if (kind === "noise") {
      // Multiple targets, duration presets and volume all influence the cost
      const baseCost = Number(room.powerCosts?.noise || 20);

      let targetIds = [];
      if (Array.isArray(body?.targetSessionIds) && body.targetSessionIds.length > 0) {
        targetIds = body.targetSessionIds.map((id) => String(id));
      } else if (body?.targetSessionId) {
        targetIds = [String(body.targetSessionId)];
      }
      const targets = targetIds
        .map((sid) => findBySessionId(sid))
        .filter((t) => t && t.sessionId !== actor.sessionId);
      if (!targets.length) return { error: "Cible introuvable." };

      let durationSec = Number(body?.durationSec) || 30;
      if (durationSec <= 10) durationSec = 10;
      else if (durationSec >= 60) durationSec = 60;
      else durationSec = 30;

      const volRaw = String(body?.volume || "medium");
      const volume = volRaw === "low" || volRaw === "high" ? volRaw : "medium";

      const durationFactor = durationSec === 10 ? 0.5 : durationSec === 60 ? 1.8 : 1.0;
      const volumeFactor = volume === "low" ? 0.7 : volume === "high" ? 1.4 : 1.0;
      const count = targets.length;
      const rawCost = baseCost * durationFactor * volumeFactor * count;
      const cost = Math.max(1, Math.ceil(rawCost));

      if (onCooldown(actor, "noise")) return { error: "Bruit en recharge." };
      if (!ensureCoins(actor, cost, "noise")) return { error: "Pas assez de pièces." };

      for (const t of targets) {
        const sock = io.sockets.sockets.get(t.socketId);
        sock?.emit("play_noise", { durationSec, volume, by: actor.nickname });
        // Store noise effect on player for persistence across page refreshes
        t.noiseEffect = {
          startedAt: now,
          durationSec,
          volume,
          by: actor.nickname
        };
        // Send game notification only to the impacted player
        sock?.emit("game_notification", {
          kind: "noise",
          durationSec,
          volume,
          by: actor.nickname
        });
        // Save to Supabase for persistence
        saveActivePower(
          room.code,
          t.sessionId,
          t.nickname,
          "noise",
          { durationSec, volume, by: actor.nickname },
          now,
          now + durationSec * 1000
        ).catch(e => console.error('Failed to save noise power to Supabase:', e));
      }

      pushTimeline(room, {
        type: "power_noise",
        bySessionId: actor.sessionId,
        targetSessionIds: targets.map((t) => t.sessionId),
        durationSec,
        volume,
        cost,
      });
      setCooldown(actor, "noise", 60);
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    if (kind === "invisibility") {
      const scope = String(body?.scope || "self"); // self | single | multi | all_role
      const durationSec = Math.max(30, Math.min(900, Number(body?.durationSec) || 300));
      const until = now + durationSec * 1000;
      const durationFactor = Math.pow(durationSec / 300, 1.6); // 5 minutes = coût de base
      let targets = [];
      if (scope === "self") targets = [actor];
      else if (scope === "single") {
        const sid = String(body?.targetSessionId || "");
        const t = findBySessionId(sid);
        if (!t) return { error: "Cible introuvable." };
        targets = [t];
      } else if (scope === "multi") {
        const ids = Array.isArray(body?.targetSessionIds) ? body.targetSessionIds : [];
        targets = ids.map(findBySessionId).filter(Boolean);
      } else if (scope === "all_role") {
        targets = [...room.players.values()].filter((p) => p.role === actor.role && !p.spectator);
      } else return { error: "Portée invalide." };

      let cost = 0;
      if (scope === "self") {
        const base = Number(room.powerCosts?.invisibility_self || 40);
        cost = Math.max(1, Math.round(base * durationFactor));
      } else if (scope === "single" || scope === "multi") {
        const base = Number(room.powerCosts?.invisibility_single || 70);
        const perTarget = Math.max(1, Math.round(base * durationFactor));
        cost = perTarget * Math.max(1, targets.length);
      } else {
        const base = Number(room.powerCosts?.invisibility_all_role || 130);
        cost = Math.max(1, Math.round(base * durationFactor));
      }
      if (onCooldown(actor, "invisibility")) return { error: "Invisibilité en recharge." };
      if (!ensureCoins(actor, cost)) return { error: "Pas assez de pièces." };
      for (const t of targets) {
        t.invisUntil = until;
        t.invisSince = now;
        t.invisFrozenLat = t.lat;
        t.invisFrozenLng = t.lng;
        // Store who used the power on this target
        t.invisUsedBy = actor.sessionId;
        // Save to Supabase for persistence
        saveActivePower(
          room.code,
          t.sessionId,
          t.nickname,
          "invisibility",
          { scope, usedBy: actor.sessionId, usedByNickname: actor.nickname },
          now,
          until
        ).catch(e => console.error('Failed to save invisibility power to Supabase:', e));
      }
      pushTimeline(room, { type: "power_invisibility", bySessionId: actor.sessionId, scope, count: targets.length, durationSec });
      setCooldown(actor, "invisibility", 120);
      
      // Send game notification to the actor (the one who used the power)
      const actorSock = io.sockets.sockets.get(actor.socketId);
      if (actorSock) {
        if (scope === "self") {
          actorSock.emit("game_notification", {
            kind: "invisibility",
            scope: "self",
            durationSec
          });
        } else {
          // For single/multi/all_role, show the names of targets
          const targetNames = targets.map(t => t.nickname).join(", ");
          actorSock.emit("game_notification", {
            kind: "invisibility",
            scope: "other",
            targetNames,
            durationSec
          });
        }
      }
      
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    if (kind === "invisibility_cancel") {
      // Permet à un joueur de quitter le mode ghost plus tôt, sans coût
      if (!actor.invisUntil || now >= actor.invisUntil) {
        return { error: "Pas en mode ghost." };
      }
      actor.invisUntil = null;
      actor.invisSince = null;
      actor.invisFrozenLat = null;
      actor.invisFrozenLng = null;
      // Remove from Supabase
      removeActivePower(room.code, actor.sessionId, "invisibility").catch(e => console.error('Failed to remove invisibility power from Supabase:', e));
      pushTimeline(room, { type: "power_invisibility_end", bySessionId: actor.sessionId });
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    if (kind === "zone_morph") {
      // This power only affects the jam radius (players' blur circles)
      if (!room.jamRadiusBaseM) {
        room.jamRadiusBaseM = Number(room.settings.jamRadiusM) || 80;
      }
      if (typeof room.jamRadiusScale !== "number" || !Number.isFinite(room.jamRadiusScale)) {
        room.jamRadiusScale = 1;
      }

      const baseJam = room.jamRadiusBaseM;
      const minScale = 0.5;
      const maxScale = 1.5;
      const step = 0.5;
      const currentScale = Math.min(maxScale, Math.max(minScale, Number(room.jamRadiusScale || 1)));

      if (actor.role === "player") {
        const baseCost = Number(room.powerCosts?.zone_morph_player || 120);

        // Les joueurs agrandissent le cercle palier par palier : 0.5 -> 1.0 -> 1.5
        if (currentScale >= maxScale - 1e-6) {
          return { error: "Déjà au maximum." };
        }

        if (!ensureCoins(actor, baseCost)) return { error: "Pas assez de pièces." };
        const targetScale = Math.min(maxScale, currentScale + step);

        room.jamRadiusScale = targetScale;
        room.settings.jamRadiusM = Math.round(baseJam * targetScale);

        pushTimeline(room, {
          type: "power_zone_jam_player",
          bySessionId: actor.sessionId,
          scale: targetScale,
          baseJam,
          jamRadiusM: room.settings.jamRadiusM,
          double: false,
        });
        broadcastPlayingState(io, room);
        return { ok: true };
      } else if (actor.role === "cat") {
        const baseCost = Number(room.powerCosts?.zone_morph_cat || 100);

        // Les chats réduisent le cercle palier par palier : 1.5 -> 1.0 -> 0.5
        if (currentScale <= minScale + 1e-6) {
          return { error: "Déjà au minimum." };
        }

        if (!ensureCoins(actor, baseCost)) return { error: "Pas assez de pièces." };
        const targetScale = Math.max(minScale, currentScale - step);

        room.jamRadiusScale = targetScale;
        room.settings.jamRadiusM = Math.round(baseJam * targetScale);

        pushTimeline(room, {
          type: "power_zone_jam_cat",
          bySessionId: actor.sessionId,
          scale: targetScale,
          baseJam,
          jamRadiusM: room.settings.jamRadiusM,
          double: false,
        });
        broadcastPlayingState(io, room);
        return { ok: true };
      }
      return { error: "Rôle invalide." };
    }

    if (kind === "no_boundaries") {
      if (actor.role !== "player") return { error: "Réservé aux joueurs." };
      // Verrouiller ce pouvoir au tout début de la partie
      const minElapsedMs = 5 * 60 * 1000; // 5 minutes
      if (!room.huntStartedAt || Date.now() - room.huntStartedAt < minElapsedMs) {
        return { error: "Disponible plus tard dans la partie." };
      }
      if (onCooldown(actor, "no_boundaries")) return { error: "Recharge en cours." };
      if (!ensureCoins(actor, Number(room.powerCosts?.no_boundaries || 80))) return { error: "Pas assez de pièces." };
      const durationSec = Math.max(60, Math.min(1800, Number(body?.durationSec) || 600));
      actor.outOfBoundsOverrideUntil = now + durationSec * 1000;
      pushTimeline(room, { type: "power_no_boundaries", bySessionId: actor.sessionId, durationSec });
      setCooldown(actor, "no_boundaries", 300);
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    if (kind === "freeze_cats") {
      if (actor.role !== "player") return { error: "Réservé aux joueurs." };
      const scope = String(body?.scope || "single"); // single | multi | all
      const durationSec = Math.max(5, Math.min(120, Number(body?.durationSec) || 20));
      let targets = [];
      if (scope === "single") {
        const sid = String(body?.targetSessionId || "");
        const t = findBySessionId(sid);
        if (!t) return { error: "Cible introuvable." };
        targets = [t];
      } else if (scope === "multi") {
        const ids = Array.isArray(body?.targetSessionIds) ? body.targetSessionIds : [];
        targets = ids.map(findBySessionId).filter(Boolean);
      } else if (scope === "all") {
        targets = [...room.players.values()].filter((p) => p.sessionId !== actor.sessionId && !p.spectator);
      } else return { error: "Portée invalide." };
      const cost = scope === "single"
        ? Number(room.powerCosts?.freeze_cats_single || 45)
        : scope === "multi"
          ? Number(room.powerCosts?.freeze_cats_multi || 80)
          : Number(room.powerCosts?.freeze_cats_all || 140);
      if (onCooldown(actor, "freeze_cats")) return { error: "Recharge en cours." };
      if (!ensureCoins(actor, cost)) return { error: "Pas assez de pièces." };
      const until = now + durationSec * 1000;
      for (const t of targets) {
        t.movementLockedUntil = Math.max(Number(t.movementLockedUntil || 0), until);
        const sock = io.sockets.sockets.get(t.socketId);
        sock?.emit("immobilized", { until, by: actor.nickname, durationSec });
        // Save to Supabase for persistence
        saveActivePower(
          room.code,
          t.sessionId,
          t.nickname,
          "freeze",
          { by: actor.nickname, durationSec },
          now,
          until
        ).catch(e => console.error('Failed to save freeze power to Supabase:', e));
      }
      pushTimeline(room, { type: "power_freeze_cats", bySessionId: actor.sessionId, scope, count: targets.length, durationSec });
      setCooldown(actor, "freeze_cats", 90);
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    if (kind === "fake_position") {
      // Pouvoir de leurre de position : affiche une fausse position aux autres joueurs
      if (actor.role !== "player") return { error: "Réservé aux joueurs." };
      if (onCooldown(actor, "fake_position")) return { error: "Leurre en recharge." };

      const durationSec = Math.max(30, Math.min(300, Number(body?.durationSec) || 60));
      const cost = Number(room.powerCosts?.fake_position || 60);

      if (!ensureCoins(actor, cost, "fake_position")) return { error: "Pas assez de pièces." };

      // La fausse position commence à la position réelle du joueur
      // Elle bougera ensuite de manière aléatoire mais crédible
      const fakeLat = actor.lat;
      const fakeLng = actor.lng;

      actor.fakePosition = {
        lat: fakeLat,
        lng: fakeLng,
        realLat: actor.lat,
        realLng: actor.lng,
        until: now + durationSec * 1000,
        bySessionId: actor.sessionId,
        lastUpdate: now,
        // Le cercle de brouillage de la fausse position commence à la vraie position
        jamCircleCenter: { lat: actor.lat, lng: actor.lng },
        jamCircleLastUpdate: now,
      };
      // Save to Supabase for persistence
      saveActivePower(
        room.code,
        actor.sessionId,
        actor.nickname,
        "fake_position",
        { durationSec },
        now,
        now + durationSec * 1000
      ).catch(e => console.error('Failed to save fake_position power to Supabase:', e));

      pushTimeline(room, { type: "power_fake_position", bySessionId: actor.sessionId, durationSec });
      setCooldown(actor, "fake_position", 180);
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    if (kind === "fake_position_cancel") {
      // Annuler le leurre de position et revenir à la vraie position
      if (!actor.fakePosition || now >= actor.fakePosition.until) {
        return { error: "Pas de leurre actif." };
      }
      
      actor.fakePosition = null;
      // Remove from Supabase
      removeActivePower(room.code, actor.sessionId, "fake_position").catch(e => console.error('Failed to remove fake_position power from Supabase:', e));
      pushTimeline(room, { type: "power_fake_position_end", bySessionId: actor.sessionId });
      broadcastPlayingState(io, room);
      return { ok: true };
    }

    return { error: "Pouvoir inconnu." };
  }

  function adminSetPowerCosts(io, socketId, partialCosts) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== socketId) return { error: "Hôte requis." };
    const pc = room.powerCosts || {};
    const valid = [
      "noise",
      "invisibility_self",
      "invisibility_single",
      "invisibility_all_role",
      "zone_morph_player",
      "zone_morph_cat",
      "no_boundaries",
      "freeze_cats_single",
      "freeze_cats_multi",
      "freeze_cats_all",
      "fake_position",
    ];
    for (const k of valid) {
      if (partialCosts && partialCosts[k] != null) {
        const v = Number(partialCosts[k]);
        if (Number.isFinite(v) && v >= 0 && v <= 100000) pc[k] = Math.floor(v);
      }
    }
    room.powerCosts = pc;
    broadcastPlayingState(io, room);
    return { ok: true };
  }

  function adminAdjustCoins(io, socketId, targetSessionId, delta) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== socketId) return { error: "Hôte requis." };
    let target = null;
    for (const p of room.players.values()) if (p.sessionId === targetSessionId) { target = p; break; }
    if (!target) return { error: "Cible introuvable." };
    const d = Math.floor(Number(delta || 0));
    if (!Number.isFinite(d)) return { error: "Delta invalide." };
    target.coins = Math.max(0, (target.coins || 0) + d);
    recordCoinTransaction(target, d, "admin", `Ajustement admin: ${d > 0 ? '+' : ''}${d}`);
    pushTimeline(room, { type: "admin_adjust_coins", bySessionId: room.players.get(room.hostId)?.sessionId, targetSessionId, delta: d });
    broadcastPlayingState(io, room);
    return { ok: true, coins: target.coins };
  }

  function leaveRoomVoluntarily(io, socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room) {
      socketToRoom.delete(socketId);
      return { error: "Salle introuvable." };
    }
    const player = room.players.get(socketId);
    if (!player) return { error: "Joueur introuvable." };

    const sock = io.sockets.sockets.get(socketId);
    if (sock) {
      sock.leave(code);
    }
    socketToRoom.delete(socketId);

    // If still in lobby, role_reveal, or configuration phases, remove player entirely
    if (room.phase === "lobby" || room.phase === "role_reveal") {
      // If host leaves during lobby or role_reveal, nuke the entire room to prevent game from starting
      if (room.hostId === socketId) {
        nukeRoom(io, room, "host_left");
        return { ok: true };
      }
      room.players.delete(socketId);
      // If host left (shouldn't reach here due to above check), assign new host
      if (room.hostId === socketId && room.players.size > 0) {
        room.hostId = room.players.keys().next().value;
      }
    } else {
      // If game started, just mark as disconnected but DO NOT remove from players map
      // This allows them to rejoin later with their role
      player.disconnectedAt = Date.now();
    }

    io.to(code).emit("player_left", {
      nickname: player.nickname,
      sessionId: player.sessionId,
    });

    const r = rooms.get(code);
    if (!r || r.players.size === 0) {
      if (r) nukeRoom(io, r, "empty");
      return { ok: true };
    }

    if (r.phase === "lobby") {
      io.to(code).emit("lobby_update", buildLobbyPayload(r, io));
    } else if (r.phase === "role_reveal") {
      io.to(code).emit("roles_reveal", buildRolesRevealPayload(r));
    } else if (r.phase === "playing") {
      broadcastPlayingState(io, r);
    }

    return { ok: true };
  }

  return {
    rooms,
    socketToRoom,
    getRoomByCode,
    leaveRoom,
    leaveRoomVoluntarily,
    createRoom,
    joinRoom,
    updateSettings,
    startRoles,
    beginHunt,
    setPosition,
    buildLobbyPayload,
    buildRolesRevealPayload,
    broadcastPlayingState,
    tryCapture,
    buildPlayingPayloadForSocket,
    adminKick,
    adminSetRole,
    adminEndGame,
    adminAddTime,
    appendLocationSample,
    requestJoinMidgame,
    respondJoinRequest,
    clearRoomAbandonTimer,
    scheduleNukeIfAllAway,
    purgeStaleDisconnects,
    recordPlayerTimelineDisconnect,
    recordPlayerTimelineReconnect,
    partyChatSend,
    updateBalises,
    usePower,
    adminSetPowerCosts,
    adminAdjustCoins,
  };
}
