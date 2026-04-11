import { v4 as uuidv4 } from "uuid";
import {
  haversineMeters,
  randomOffsetPoint,
  isInsideRadius,
  isInsideAnyPolygon,
} from "./geo.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CAPTURE_DISTANCE_M = 15;

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

function applyCityDifficultyPreset(s, level) {
  const P = {
    easy: {
      jamRadiusM: 100,
      catDelayMinutes: 6,
      shrinkZoneEnabled: false,
      shrinkDurationMinutes: 18,
      shrinkMinRadiusM: 110,
      shrinkPhases: 4,
      timeLimitEnabled: false,
    },
    medium: {
      jamRadiusM: 75,
      catDelayMinutes: 4,
      shrinkZoneEnabled: false,
      shrinkDurationMinutes: 15,
      shrinkMinRadiusM: 95,
      shrinkPhases: 5,
      timeLimitEnabled: true,
      timeLimitMinutes: 35,
    },
    hard: {
      jamRadiusM: 48,
      catDelayMinutes: 1,
      shrinkZoneEnabled: false,
      shrinkDurationMinutes: 10,
      shrinkMinRadiusM: 55,
      shrinkPhases: 8,
      timeLimitEnabled: true,
      timeLimitMinutes: 22,
    },
  };
  Object.assign(s, P[level] || P.medium);
}

const defaultSettings = () => ({
  globalRadiusM: 500,
  jamRadiusM: 80,
  catCount: 1,
  catDelayMinutes: 5,
  /** Zone globale qui rétrécit avec le temps */
  shrinkZoneEnabled: false,
  shrinkDurationMinutes: 15,
  shrinkMinRadiusM: 100,
  /** Nombre de paliers de rayon (diamètres discrets) */
  shrinkPhases: 5,
  /** circle | city — en mode city, cityPolygons définit le contour (union) */
  zoneMode: "circle",
  /** Tableau d'anneaux [[lat,lng], ...] — union */
  cityPolygons: [],
  /** easy | medium | hard — appliqué en mode ville */
  cityDifficulty: "medium",
  /** Fin forcée après X minutes (désactivable) */
  timeLimitEnabled: false,
  timeLimitMinutes: 30,
});

/** Paliers de rayon + métadonnées pour l’UI (phase suivante, fin de palier). */
function getShrinkState(room) {
  const R0 = Number(room.settings.globalRadiusM) || 500;
  if (
    room.settings.zoneMode === "city" ||
    !room.settings.shrinkZoneEnabled ||
    !room.huntStartedAt
  ) {
    return {
      currentRadius: R0,
      nextRadius: null,
      phaseEndsAt: null,
      currentPhase: 1,
      totalPhases: 1,
    };
  }
  const durMin = Math.max(1, Number(room.settings.shrinkDurationMinutes) || 15);
  const Rmin = Math.min(
    R0,
    Math.max(20, Number(room.settings.shrinkMinRadiusM) || 80)
  );
  const phases = Math.max(
    2,
    Math.min(20, Math.floor(Number(room.settings.shrinkPhases)) || 5)
  );
  const durMs = durMin * 60 * 1000;
  const radii = [];
  for (let i = 0; i < phases; i++) {
    radii.push(R0 + (Rmin - R0) * (i / Math.max(1, phases - 1)));
  }
  const elapsed = Date.now() - room.huntStartedAt;
  const segMs = durMs / phases;
  const idx = Math.min(phases - 1, Math.floor(elapsed / segMs));
  const currentRadius = radii[idx];
  const nextRadius = idx < phases - 1 ? radii[idx + 1] : null;
  const phaseEndsAt = room.huntStartedAt + (idx + 1) * segMs;
  return {
    currentRadius,
    nextRadius,
    phaseEndsAt,
    currentPhase: idx + 1,
    totalPhases: phases,
  };
}

function getEffectiveGlobalRadius(room) {
  return getShrinkState(room).currentRadius;
}

function isInsideGameZone(lat, lng, room) {
  const gc = room.gameCenter;
  const r = getEffectiveGlobalRadius(room);
  const mode = room.settings.zoneMode === "city" ? "city" : "circle";
  if (mode !== "city" || !room.settings.cityPolygons?.length) {
    return isInsideRadius(lat, lng, gc, r);
  }
  return isInsideAnyPolygon(lat, lng, room.settings.cityPolygons);
}

function countActivePrey(room) {
  let n = 0;
  for (const p of room.players.values()) {
    if (p.role === "player" && !p.captured && !p.spectator) n++;
  }
  return n;
}

function pushTimeline(room, evt) {
  if (!room.timelineEvents) room.timelineEvents = [];
  room.timelineEvents.push({ t: Date.now(), ...evt });
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

function buildGameSummary(room) {
  const paths = {};
  for (const [sid, pts] of Object.entries(room.traceBySession || {})) {
    paths[sid] = pts.map((x) => ({ ...x }));
  }
  return {
    code: room.code,
    huntStartedAt: room.huntStartedAt,
    endedAt: room.finishedAt,
    gameCenter: room.gameCenter,
    globalRadiusM: room.settings.globalRadiusM,
    jamRadiusM: room.settings.jamRadiusM,
    settingsSnapshot: { ...room.settings },
    timeline: [...(room.timelineEvents || [])].sort((a, b) => a.t - b.t),
    paths,
    jamHistory: [...(room.jamHistory || [])],
    players: [...room.players.values()].map((p) => ({
      sessionId: p.sessionId,
      nickname: p.nickname,
      role: p.role,
      originalRole: p.originalRole,
    })),
    colors: { ...(room.playerColors || {}) },
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
    return rooms.get(code?.toUpperCase());
  }

  function leaveRoom(socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) return;
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
  }

  function isSocketConnected(io, socketId) {
    const s = io.sockets.sockets.get(socketId);
    return Boolean(s?.connected);
  }

  function isDisconnectedGhost(p, io) {
    if (p.disconnectedAt == null) return false;
    return !isSocketConnected(io, p.socketId);
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
    }, 45_000);
    emptyRoomTimers.set(code, id);
  }

  function purgeStaleDisconnects(io, room) {
    const ttlMs = 3 * 60 * 1000;
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
      jamCircleCenter: null,
      jamAnchorLat: null,
      jamAnchorLng: null,
    };
    const room = {
      code,
      hostId: socketId,
      phase: "lobby",
      settings: defaultSettings(),
      gameCenter: null,
      catMapUnlockAt: null,
      players: new Map([[socketId, player]]),
      pendingJoins: [],
    };
    rooms.set(code, room);
    socketToRoom.set(socketId, code);
    return { room, player };
  }

  function joinRoom(socketId, code, nickname) {
    leaveRoom(socketId);
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) {
      return { error: "Salle introuvable." };
    }
    if (room.phase !== "lobby") {
      if (room.phase === "finished") {
        return { error: "Cette partie est terminée." };
      }
      return {
        error: "La partie a déjà commencé. Demandez à l’hôte de vous accepter.",
        joinRequestPossible: true,
        roomCode: room.code,
      };
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
      jamCircleCenter: null,
      jamAnchorLat: null,
      jamAnchorLng: null,
    };
    room.players.set(socketId, player);
    socketToRoom.set(socketId, room.code);
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
    if (partial.zoneMode === "circle" || partial.zoneMode === "city") {
      s.zoneMode = partial.zoneMode;
      if (partial.zoneMode === "city") {
        applyCityDifficultyPreset(s, s.cityDifficulty || "medium");
      }
    }
    if (
      partial.cityDifficulty === "easy" ||
      partial.cityDifficulty === "medium" ||
      partial.cityDifficulty === "hard"
    ) {
      s.cityDifficulty = partial.cityDifficulty;
      if (s.zoneMode === "city") {
        applyCityDifficultyPreset(s, partial.cityDifficulty);
      }
    }
    if (partial.cityPolygons != null && Array.isArray(partial.cityPolygons)) {
      s.cityPolygons = partial.cityPolygons
        .filter((ring) => Array.isArray(ring) && ring.length >= 3)
        .map((ring) =>
          ring
            .filter(
              (pt) =>
                Array.isArray(pt) &&
                pt.length >= 2 &&
                Number.isFinite(pt[0]) &&
                Number.isFinite(pt[1])
            )
            .map((pt) => [Number(pt[0]), Number(pt[1])])
        )
        .filter((ring) => ring.length >= 3);
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
    if (!code) return { error: "Pas dans une salle." };
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
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    shuffled.forEach((p, i) => {
      const r = i < catCount ? "cat" : "player";
      p.role = r;
      p.originalRole = r;
      p.captured = false;
      p.spectator = false;
      p.jamCircleCenter = null;
      p.jamAnchorLat = null;
      p.jamAnchorLng = null;
    });
    return { ok: true, room };
  }

  function beginHunt(socketId) {
    const code = socketToRoom.get(socketId);
    if (!code) return { error: "Pas dans une salle." };
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
    room.phase = "playing";
    room.huntStartedAt = Date.now();
    room.traceBySession = {};
    room.jamHistory = [];
    room.timelineEvents = [];
    room._lastJamSample = {};
    assignPlayerColors(room);
    pushTimeline(room, {
      type: "hunt_started",
      message: "La chasse a commencé",
    });
    const delayMs = Math.max(0, Number(room.settings.catDelayMinutes) || 0) * 60 * 1000;
    room.catMapUnlockAt = Date.now() + delayMs;
    return { ok: true, room };
  }

  function finishGame(io, room, reason = "natural") {
    if (room.phase !== "playing") return;
    room.phase = "finished";
    room.finishedAt = Date.now();
    const msg =
      reason === "admin"
        ? "Partie terminée par l'hôte"
        : reason === "time_limit"
          ? "Limite de temps atteinte"
          : reason === "no_prey_left"
            ? "Plus aucune proie en jeu"
            : "Partie terminée";
    pushTimeline(room, {
      type: "game_over",
      reason,
      message: msg,
    });
    const summary = buildGameSummary(room);
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
    if (countActivePrey(room) === 0) {
      finishGame(io, room, "no_prey_left");
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
      })),
      hostSessionId: room.players.get(room.hostId)?.sessionId ?? null,
    };
  }

  function setPosition(socketId, lat, lng) {
    const code = socketToRoom.get(socketId);
    if (!code) return null;
    const room = rooms.get(code);
    if (!room) return null;
    if (room.phase === "finished") return null;
    const p = room.players.get(socketId);
    if (!p) return null;
    const la = Number(lat);
    const lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
    p.lat = la;
    p.lng = lo;
    return { room, player: p };
  }

  function buildLobbyPayload(room) {
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
      })),
      hostSessionId: host?.sessionId ?? null,
      hostHasPosition: host?.lat != null && host?.lng != null,
      canStartGps: withGps >= 1,
      canRevealRoles: n >= 2,
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
    return [...room.players.values()].map((p) => ({
      sessionId: p.sessionId,
      nickname: p.nickname,
      role: p.role,
      originalRole: p.originalRole,
      captured: p.captured,
      spectator: p.spectator,
      disconnected: io ? isDisconnectedGhost(p, io) : false,
    }));
  }

  function buildPlayingPayloadForSocket(room, viewerSocketId, io) {
    const viewer = room.players.get(viewerSocketId);
    if (!viewer) return null;
    const { globalRadiusM, jamRadiusM } = room.settings;
    const center = room.gameCenter;
    const shrinkMeta = getShrinkState(room);
    const effectiveGlobalRadiusM = shrinkMeta.currentRadius;
    const catMapLocked = isCatMapLocked(room, viewer);
    const mapUnlockAt = room.catMapUnlockAt;
    const huntStartedAt = room.huntStartedAt;
    const timeLimitMs =
      room.settings.timeLimitEnabled && huntStartedAt
        ? Math.max(1, Number(room.settings.timeLimitMinutes) || 30) * 60 * 1000
        : null;

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
        zoneMode: room.settings.zoneMode,
        cityPolygons: room.settings.cityPolygons,
        timeLimitEnabled: room.settings.timeLimitEnabled,
        timeLimitMinutes: room.settings.timeLimitMinutes,
      },
      gameCenter: center,
      effectiveGlobalRadiusM,
      nextPhaseRadiusM: shrinkMeta.nextRadius,
      phaseEndsAt: shrinkMeta.phaseEndsAt,
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
      me: {
        sessionId: viewer.sessionId,
        nickname: viewer.nickname,
        role: viewer.role,
        originalRole: viewer.originalRole,
        lat: viewer.lat,
        lng: viewer.lng,
        captured: viewer.captured,
        spectator: viewer.spectator,
      },
      myJamCircle: null,
      allies: [],
      catsExact: [],
      preyForCat: [],
      spectators: [],
    };

    if (catMapLocked) {
      return payload;
    }

    if (
      viewer.role === "player" &&
      !viewer.spectator &&
      !viewer.captured &&
      viewer.jamCircleCenter &&
      viewer.lat != null
    ) {
      payload.myJamCircle = {
        center: viewer.jamCircleCenter,
        radiusM: jamRadiusM,
      };
    }

    for (const p of others) {
      if (p.spectator || p.captured) {
        payload.spectators.push({
          sessionId: p.sessionId,
          nickname: p.nickname,
          lat: p.lat,
          lng: p.lng,
        });
        continue;
      }

      if (viewer.spectator || viewer.captured) {
        if (p.lat == null || p.lng == null) continue;
        payload.allies.push({
          sessionId: p.sessionId,
          nickname: p.nickname,
          role: p.role,
          lat: p.lat,
          lng: p.lng,
          disconnected: isDisconnectedGhost(p, io),
        });
        continue;
      }

      if (viewer.role === "cat") {
        if (p.role === "cat") {
          if (p.lat == null || p.lng == null) continue;
          payload.catsExact.push({
            sessionId: p.sessionId,
            nickname: p.nickname,
            lat: p.lat,
            lng: p.lng,
            disconnected: isDisconnectedGhost(p, io),
          });
        } else if (p.role === "player") {
          if (p.lat == null || p.lng == null) continue;
          const inside = isInsideGameZone(p.lat, p.lng, room);
          const disc = isDisconnectedGhost(p, io);
          if (!inside) {
            payload.preyForCat.push({
              sessionId: p.sessionId,
              nickname: p.nickname,
              kind: "exact",
              lat: p.lat,
              lng: p.lng,
              disconnected: disc,
            });
          } else if (p.jamCircleCenter) {
            payload.preyForCat.push({
              sessionId: p.sessionId,
              nickname: p.nickname,
              kind: "circle",
              center: p.jamCircleCenter,
              radiusM: jamRadiusM,
              disconnected: disc,
            });
          }
        }
      } else if (viewer.role === "player") {
        if (p.role === "player") {
          if (p.lat == null || p.lng == null) continue;
          payload.allies.push({
            sessionId: p.sessionId,
            nickname: p.nickname,
            lat: p.lat,
            lng: p.lng,
            disconnected: isDisconnectedGhost(p, io),
          });
        } else if (p.role === "cat") {
          if (p.lat == null || p.lng == null) continue;
          payload.catsExact.push({
            sessionId: p.sessionId,
            nickname: p.nickname,
            lat: p.lat,
            lng: p.lng,
            disconnected: isDisconnectedGhost(p, io),
          });
        }
      }
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
    let prey = null;
    for (const p of room.players.values()) {
      if (p.sessionId === targetSessionId && p.role === "player" && !p.captured) {
        prey = p;
        break;
      }
    }
    if (!prey) return { error: "Cible invalide ou déjà capturée." };
    if (prey.lat == null || prey.lng == null) {
      return { error: "Position de la proie inconnue." };
    }
    const d = haversineMeters(cat.lat, cat.lng, prey.lat, prey.lng);
    if (d > CAPTURE_DISTANCE_M) {
      return { error: `Trop loin (${Math.round(d)} m, max ${CAPTURE_DISTANCE_M} m).` };
    }
    prey.captured = true;
    prey.spectator = true;
    pushTimeline(room, {
      type: "captured",
      sessionId: prey.sessionId,
      nickname: prey.nickname,
      bySessionId: cat.sessionId,
      byNickname: cat.nickname,
    });
    broadcastPlayingState(io, room);
    io.to(code).emit("capture_ok", {
      preySessionId: prey.sessionId,
      preyNickname: prey.nickname,
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
        io.to(code).emit("lobby_update", buildLobbyPayload(r));
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
    if (target.socketId === hostSocketId) {
      return { error: "Impossible de changer votre propre rôle." };
    }
    const prevRole = target.role;
    target.role = newRole;
    target.captured = false;
    target.spectator = false;
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
    const hostSock = io.sockets.sockets.get(room.hostId);
    hostSock?.emit("join_request_pending", {
      requestId: pending.id,
      nickname: pending.nickname,
      code: room.code,
    });
    return { ok: true, requestId: pending.id };
  }

  function respondJoinRequest(io, hostSocketId, requestId, accept) {
    const code = socketToRoom.get(hostSocketId);
    if (!code) return { error: "Pas dans une salle." };
    const room = rooms.get(code);
    if (!room || room.hostId !== hostSocketId) {
      return { error: "Réservé à l'hôte." };
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
        message: "L'hôte a refusé votre demande.",
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
      jamCircleCenter: null,
      jamAnchorLat: null,
      jamAnchorLng: null,
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
      lobby: room.phase === "lobby" ? buildLobbyPayload(room) : null,
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

  return {
    socketToRoom,
    getRoomByCode,
    leaveRoom,
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
    appendLocationSample,
    requestJoinMidgame,
    respondJoinRequest,
    clearRoomAbandonTimer,
    scheduleNukeIfAllAway,
    purgeStaleDisconnects,
  };
}
