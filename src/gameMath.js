export function clampNum(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function gameMinutesForPowers(room) {
  const s = room?.settings || {};
  if (!s.timeLimitEnabled) return 30;
  const mins = Number(s.timeLimitMinutes);
  return Number.isFinite(mins) && mins >= 1 ? mins : 30;
}

export function maxPowerSecForRoom(room) {
  return clampNum(Math.round(gameMinutesForPowers(room) * 4), 45, 120);
}

export function clampPowerDuration(sec, room, min = 5, fallback = 60) {
  const max = maxPowerSecForRoom(room);
  const raw = Number(sec);
  const chosen = Number.isFinite(raw) && raw > 0 ? raw : Math.min(fallback, max);
  return Math.max(min, Math.min(max, Math.round(chosen)));
}

export function durationFactor60(durationSec) {
  return Math.pow(Math.max(1, Number(durationSec) || 60) / 60, 1.6);
}

export function calculateAdaptivePhaseCount(timeLimitMinutes, globalRadiusM) {
  const R0 = globalRadiusM || 500;
  const Rmin = 70;
  const gapMinimum = 15;

  const timeBasedCount = Math.min(Math.max(3, Math.floor(timeLimitMinutes / 5)), 8);
  const radiusBasedCount = Math.floor((R0 - Rmin) / gapMinimum);

  return Math.min(timeBasedCount, radiusBasedCount);
}

export function calculateFinalWaitRatio(timeLimitMinutes) {
  const minWaitMinutes = 1;
  const maxRatio = 0.05;

  if (timeLimitMinutes <= 10) {
    return Math.max(minWaitMinutes / timeLimitMinutes, maxRatio);
  } else if (timeLimitMinutes <= 15) {
    return Math.max(minWaitMinutes / timeLimitMinutes, 0.08);
  } else {
    return maxRatio;
  }
}

export function calculateDynamicCatDelay(timeLimitMinutes, globalRadiusM, playerCount) {
  const baseRatio = 0.025;
  const delayMs = timeLimitMinutes * baseRatio * 60 * 1000;
  const R0 = globalRadiusM || 500;
  const radiusFactor = Math.max(1, R0 / 500);
  const playerFactor = Math.max(1, playerCount / 4);
  const adjustedDelayMs = delayMs * radiusFactor * playerFactor;
  const minDelayMs = 2 * 60 * 1000;
  const maxRatio = 0.08;
  const maxDelayMs = timeLimitMinutes * maxRatio * 60 * 1000;

  if (timeLimitMinutes <= 10) {
    const shortGameMaxMs = timeLimitMinutes * 0.05 * 60 * 1000;
    return Math.max(minDelayMs, Math.min(adjustedDelayMs, shortGameMaxMs));
  }

  if (timeLimitMinutes >= 120) {
    const longGameMaxMs = 8 * 60 * 1000;
    return Math.max(minDelayMs, Math.min(adjustedDelayMs, longGameMaxMs));
  }

  return Math.max(minDelayMs, Math.min(adjustedDelayMs, maxDelayMs));
}

export function calculateForcedWaitForNewCat(timeLimitMinutes, remainingTimeMs) {
  const minWaitMs = 1 * 60 * 1000;
  const dynamicRatio = 0.015;
  const dynamicWaitMs = remainingTimeMs * dynamicRatio;
  const maxWaitMs = 3 * 60 * 1000;

  return Math.max(minWaitMs, Math.min(dynamicWaitMs, maxWaitMs));
}

export const defaultSettings = (beaconSpacingM, beaconSpawnDistanceM) => ({
  globalRadiusM: 500,
  jamRadiusM: 80,
  catCount: 1,
  catDelayMinutes: 0,
  shrinkZoneEnabled: false,
  timeLimitEnabled: false,
  timeLimitMinutes: 30,
  catAssignmentMode: "random",
  gameMode: "tag_swap",
  minBeaconSpacingM: beaconSpacingM,
  minBeaconSpawnDistanceM: beaconSpawnDistanceM,
  hostCatMapPreview: false,
});
