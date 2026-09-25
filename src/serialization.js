const BALISE_PROFILE = {
  normal: { captureMs: 20 * 1000, coins: 120, rarity: "commune", progressColor: "#22c55e" },
  circular: { captureMs: 30 * 1000, coins: 180, rarity: "peu commune", progressColor: "#a855f7" },
  distant: { captureMs: 40 * 1000, coins: 260, rarity: "rare", progressColor: "#3b82f6" },
  gold: { captureMs: 60 * 1000, coins: 600, rarity: "légendaire", progressColor: "#f59e0b" },
};
const BALISE_TYPES = new Set(["normal", "distant", "circular", "gold"]);

export function serializeBalises(room) {
  let goldSeen = false;
  return (room.balises || []).map((balise) => {
    let type = BALISE_TYPES.has(balise.type) ? balise.type : "normal";
    if (type === "gold" && goldSeen) type = "normal";
    if (type === "gold") goldSeen = true;
    const awardedCoins = Number.isFinite(Number(balise.awardedCoins))
      ? Number(balise.awardedCoins)
      : Number(balise.rewardCoins) || BALISE_PROFILE[type].coins;
    return {
      ...balise,
      type,
      rarity: balise.rarity || BALISE_PROFILE[type].rarity,
      captureDurationMs: Number(balise.captureDurationMs) || BALISE_PROFILE[type].captureMs,
      awardedCoins,
      progressColor: balise.progressColor || BALISE_PROFILE[type].progressColor,
      isDecoy: Boolean(balise.isDecoy),
      lat: Number(balise.lat),
      lng: Number(balise.lng),
      expiresAt: Number(balise.expiresAt) || null,
    };
  });
}
