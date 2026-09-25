import { isInsideRadius, haversineMeters, randomOffsetPoint } from "./geo.js";

export function effectiveGlobalRadiusAtTimestamp(room, absT) {
  const settings = room.settings || {};
  const radius = Number(settings.globalRadiusM) || 500;
  if (!settings.shrinkZoneEnabled || !room.huntStartedAt || !room.shrinkPhasesList) return radius;
  const elapsed = absT - room.huntStartedAt;
  const phases = room.shrinkPhasesList;
  if (elapsed <= 0) return radius;
  let phase = phases[phases.length - 1];
  for (const candidate of phases) {
    if (elapsed < candidate.endTime) {
      phase = candidate;
      break;
    }
  }
  const duration = phase.endTime - phase.startTime;
  const shrinkStart = phase.startTime + duration * phase.waitRatio;
  if (elapsed < shrinkStart) return phase.startZone.radius;
  if (elapsed < phase.endTime) {
    const progress = (elapsed - shrinkStart) / (duration * phase.shrinkRatio);
    return phase.startZone.radius + (phase.endZone.radius - phase.startZone.radius) * progress;
  }
  return phase.endZone.radius;
}

export function isInsideGameZoneAt(room, lat, lng, shrinkState) {
  return isInsideRadius(lat, lng, shrinkState.currentCenter, shrinkState.currentRadius);
}

export function updateJamCircle(prey, jamRadiusM) {
  if (prey.lat == null || prey.lng == null) return { regenerated: false };
  if (!prey.jamCircleCenter) {
    prey.jamCircleCenter = randomOffsetPoint(prey.lat, prey.lng, jamRadiusM);
    prey.jamAnchorLat = prey.lat;
    prey.jamAnchorLng = prey.lng;
    return { regenerated: true };
  }
  if (haversineMeters(prey.lat, prey.lng, prey.jamCircleCenter.lat, prey.jamCircleCenter.lng) > jamRadiusM) {
    prey.jamCircleCenter = randomOffsetPoint(prey.lat, prey.lng, jamRadiusM);
    prey.jamAnchorLat = prey.lat;
    prey.jamAnchorLng = prey.lng;
    return { regenerated: true };
  }
  return { regenerated: false };
}
