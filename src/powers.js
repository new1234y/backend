export function clampNum(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function gameMinutesForPowers(room) {
  const settings = room?.settings || {};
  if (!settings.timeLimitEnabled) return 30;
  const minutes = Number(settings.timeLimitMinutes);
  return Number.isFinite(minutes) && minutes >= 1 ? minutes : 30;
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
  const radius = globalRadiusM || 500;
  const timeBasedCount = Math.min(Math.max(3, Math.floor(timeLimitMinutes / 5)), 8);
  const radiusBasedCount = Math.floor((radius - 70) / 15);
  return Math.min(timeBasedCount, radiusBasedCount);
}

export function calculateFinalWaitRatio(timeLimitMinutes) {
  const minWaitMinutes = 1;
  if (timeLimitMinutes <= 10) return Math.max(minWaitMinutes / timeLimitMinutes, 0.05);
  if (timeLimitMinutes <= 15) return Math.max(minWaitMinutes / timeLimitMinutes, 0.08);
  return 0.05;
}

export function calculateDynamicCatDelay(timeLimitMinutes, globalRadiusM, playerCount) {
  const delayMs = timeLimitMinutes * 0.025 * 60 * 1000;
  const radiusFactor = Math.max(1, (globalRadiusM || 500) / 500);
  const playerFactor = Math.max(1, playerCount / 4);
  const adjustedDelayMs = delayMs * radiusFactor * playerFactor;
  const minDelayMs = 2 * 60 * 1000;
  if (timeLimitMinutes <= 10) {
    return Math.max(minDelayMs, Math.min(adjustedDelayMs, timeLimitMinutes * 0.05 * 60 * 1000));
  }
  if (timeLimitMinutes >= 120) return Math.max(minDelayMs, Math.min(adjustedDelayMs, 8 * 60 * 1000));
  return Math.max(minDelayMs, Math.min(adjustedDelayMs, timeLimitMinutes * 0.08 * 60 * 1000));
}

export function calculateForcedWaitForNewCat(timeLimitMinutes, remainingTimeMs) {
  const dynamicWaitMs = remainingTimeMs * 0.015;
  return Math.max(60 * 1000, Math.min(dynamicWaitMs, 3 * 60 * 1000));
}
