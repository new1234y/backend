const COLOR_PALETTE = [
  "#3b82f6", "#f97316", "#22c55e", "#a855f7", "#ec4899", "#14b8a6",
  "#eab308", "#ef4444", "#6366f1", "#84cc16", "#f43f5e", "#06b6d4",
];

export function gpsPlayers(room) {
  return [...(room.players?.values?.() || [])].filter(
    (p) => p && !p.spectator && Number.isFinite(p.lat) && Number.isFinite(p.lng),
  );
}

export function assignPlayerColors(room) {
  room.playerColors = {};
  let i = 0;
  for (const player of room.players.values()) {
    room.playerColors[player.sessionId] = COLOR_PALETTE[i % COLOR_PALETTE.length];
    i += 1;
  }
}

export function recordCoinTransaction(player, amount, source, reason) {
  if (!player.coinHistory) player.coinHistory = [];
  player.coinHistory.push({ timestamp: Date.now(), amount, source, reason });
  if (player.coinHistory.length > 100) player.coinHistory = player.coinHistory.slice(-100);
}

export function randomCode(codeChars, len = 5) {
  let value = "";
  for (let i = 0; i < len; i += 1) {
    value += codeChars[Math.floor(Math.random() * codeChars.length)];
  }
  return value;
}

export function isValidCoordinates(lat, lng) {
  if (lat == null || lng == null) return false;
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return lat.toString().length <= 15 && lng.toString().length <= 15;
}
