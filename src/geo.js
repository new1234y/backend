const EARTH_R = 6371000;

/** Déplace (lat,lng) d'une distance fixe (m) selon un relèvement en degrés (0 = nord). */
export function offsetMeters(lat, lng, bearingDeg, distM) {
  const br = (bearingDeg * Math.PI) / 180;
  const dR = distM / EARTH_R;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lng * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dR) +
      Math.cos(lat1) * Math.sin(dR) * Math.cos(br)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dR) * Math.cos(lat1),
      Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: (lat2 * 180) / Math.PI, lng: (lon2 * 180) / Math.PI };
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_R * c;
}

/**
 * Point aléatoire à une distance aléatoire dans [minFrac*R, maxFrac*R] mètres
 * depuis (lat, lon), angle uniforme.
 */
export function randomOffsetPoint(lat, lon, radiusMeters, minFrac = 0.3, maxFrac = 0.7) {
  const dist =
    radiusMeters * (minFrac + Math.random() * (maxFrac - minFrac));
  const bearing = Math.random() * 2 * Math.PI;
  const dR = dist / EARTH_R;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dR) +
      Math.cos(lat1) * Math.sin(dR) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(dR) * Math.cos(lat1),
      Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: (lat2 * 180) / Math.PI, lng: (lon2 * 180) / Math.PI };
}

export function isInsideRadius(lat, lon, center, radiusM) {
  if (!center || radiusM == null) return true;
  return haversineMeters(lat, lon, center.lat, center.lng) <= radiusM;
}

/**
 * Anneau fermé [[lat,lng], ...] — point dans polygone (rayon horizontal vers l'est).
 */
export function pointInRing(lat, lon, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const latI = ring[i][0];
    const lngI = ring[i][1];
    const latJ = ring[j][0];
    const lngJ = ring[j][1];
    if ((latI > lat) !== (latJ > lat)) {
      const xInt =
        ((lngJ - lngI) * (lat - latI)) / (latJ - latI + 1e-18) + lngI;
      if (lon < xInt) inside = !inside;
    }
  }
  return inside;
}

/** Plusieurs anneaux (union) : vrai si dans au moins un. */
export function isInsideAnyPolygon(lat, lon, rings) {
  if (!rings?.length) return true;
  for (const ring of rings) {
    if (pointInRing(lat, lon, ring)) return true;
  }
  return false;
}
