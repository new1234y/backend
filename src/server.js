import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { createRoomsStore } from "./rooms.js";
import { corsOriginOption } from "./corsConfig.js";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const corsOrigin = corsOriginOption(CLIENT_ORIGIN);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.SUPABASE_URL_PUBLIC || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.API ||
  "";
const supabase = SUPABASE_URL && SUPABASE_KEY ? createSupabaseClient(SUPABASE_URL, SUPABASE_KEY) : null;

const app = express();
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const RECAP_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const recapStore = new Map();
const MAX_RECAPS = 400;

function randomRecapId(len = 8) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += RECAP_CHARS[Math.floor(Math.random() * RECAP_CHARS.length)];
  }
  return s;
}

app.post("/api/recap", async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid_body" });
    }
    let id = randomRecapId(8);
    if (supabase) {
      const { error } = await supabase.from("game_recaps").insert({ id, summary: body });
      if (!error) {
        return res.json({ id });
      }
      console.error("supabase_insert_error", error?.message || error);
    }
    while (recapStore.has(id)) id = randomRecapId(8);
    recapStore.set(id, { at: Date.now(), summary: body });
    while (recapStore.size > MAX_RECAPS) {
      const oldest = [...recapStore.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      recapStore.delete(oldest[0]);
    }
    return res.json({ id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
});

app.get("/api/recap/:id", async (req, res) => {
  const id = String(req.params.id || "").toUpperCase();
  if (supabase) {
    const { data, error } = await supabase
      .from("game_recaps")
      .select("summary")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      console.error("supabase_select_error", error?.message || error);
    } else if (data && data.summary) {
      return res.json(data.summary);
    }
  }
  const row = recapStore.get(id);
  if (!row?.summary) return res.status(404).json({ error: "not_found" });
  return res.json(row.summary);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ["GET", "POST"] },
  pingInterval: 35000,
  pingTimeout: 90000,
});

const store = createRoomsStore({
  onSessionInvalidated: (sessionId) => {
    sessionRegistry.delete(sessionId);
  },
  onRoomNuked: () => {},
});

// Update balises every second
setInterval(() => {
  for (const [code, room] of store.rooms || []) {
    if (room.phase === "playing") {
      store.broadcastPlayingState(io, room);
    }
  }
}, 1000);

// Map sessionId -> { socketId, roomCode, nickname, ... } pour la reconnexion
const sessionRegistry = new Map();

io.on("connection", (socket) => {
  // Heartbeat: envoie ping toutes les 30s, le client doit repondre pong
  const heartbeatInterval = setInterval(() => {
    socket.emit("server_ping", { t: Date.now() });
  }, 30000);

  socket.on("client_pong", () => {
    // Le client est vivant
  });



  // Reconnexion avec sessionId existant
  socket.on("reconnect_session", ({ sessionId, roomCode }, cb) => {
    try {
      const savedSession = sessionRegistry.get(sessionId);
      if (!savedSession) {
        cb?.({ ok: false, error: "Session expirée ou inexistante." });
        return;
      }

      const room = store.getRoomByCode(roomCode);
      if (!room) {
        sessionRegistry.delete(sessionId);
        cb?.({ ok: false, error: "La salle n'existe plus." });
        return;
      }

      // Trouver l'ancien joueur par sessionId et mettre a jour son socketId
      let foundPlayer = null;
      for (const p of room.players.values()) {
        if (p.sessionId === sessionId) {
          foundPlayer = p;
          break;
        }
      }

      if (!foundPlayer) {
        sessionRegistry.delete(sessionId);
        cb?.({ ok: false, error: "Joueur non trouvé dans la salle." });
        return;
      }

      // Nettoyer l'ancien socket s'il existe encore
      const oldSocketId = foundPlayer.socketId;
      if (oldSocketId && oldSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) {
          oldSocket.leave(room.code);
        }
        room.players.delete(oldSocketId);
        store.socketToRoom.delete(oldSocketId);
      }

      // Mettre a jour avec le nouveau socket
      foundPlayer.socketId = socket.id;
      foundPlayer.disconnectedAt = null;
      room.players.set(socket.id, foundPlayer);
      store.socketToRoom.set(socket.id, room.code);
      socket.join(room.code);
      store.clearRoomAbandonTimer(room.code);

      // Mettre a jour le registre de session
      sessionRegistry.set(sessionId, {
        socketId: socket.id,
        roomCode: room.code,
        nickname: foundPlayer.nickname,
      });

      const isHost = room.hostId === oldSocketId;
      if (isHost) {
        room.hostId = socket.id;
      }

      // Envoyer l'etat actuel selon la phase
      let payload;
      if (room.phase === "lobby") {
        payload = store.buildLobbyPayload(room, io);
        io.to(room.code).emit("lobby_update", payload);
      } else if (room.phase === "role_reveal") {
        payload = store.buildRolesRevealPayload(room);
        io.to(room.code).emit("roles_reveal", payload);
      } else if (room.phase === "playing") {
        store.broadcastPlayingState(io, room);
        payload = store.buildPlayingPayloadForSocket(room, socket.id, io);
      }

      socket.to(room.code).emit("player_reconnected", {
        nickname: foundPlayer.nickname,
        sessionId: foundPlayer.sessionId,
      });
      store.recordPlayerTimelineReconnect(room.code, {
        nickname: foundPlayer.nickname,
        sessionId: foundPlayer.sessionId,
      });

      cb?.({
        ok: true,
        code: room.code,
        sessionId: foundPlayer.sessionId,
        isHost: room.hostId === socket.id,
        phase: room.phase,
        lobby: room.phase === "lobby" ? payload : null,
        rolesReveal: room.phase === "role_reveal" ? payload : null,
        gameState: room.phase === "playing" ? payload : null,
      });
    } catch (e) {
      console.error("Erreur reconnect_session:", e);
      cb?.({ ok: false, error: "Erreur serveur." });
    }
  });

  socket.on("create_room", ({ nickname }, cb) => {
    try {
      const { room, player } = store.createRoom(socket.id, nickname);
      socket.join(room.code);
      
      // Enregistrer la session pour la reconnexion
      sessionRegistry.set(player.sessionId, {
        socketId: socket.id,
        roomCode: room.code,
        nickname: player.nickname,
      });

      const payload = store.buildLobbyPayload(room, io);
      io.to(room.code).emit("lobby_update", payload);
      cb?.({
        ok: true,
        code: room.code,
        sessionId: player.sessionId,
        isHost: true,
        lobby: payload,
      });
    } catch (e) {
      console.error(e);
      cb?.({ ok: false, error: "Erreur serveur." });
    }
  });

  socket.on("join_room", ({ code, nickname, sessionId: existingSessionId }, cb) => {
    const result = store.joinRoom(socket.id, code, nickname, existingSessionId);
    if (result.error) {
      cb?.({
        ok: false,
        error: result.error,
        joinRequestPossible: Boolean(result.joinRequestPossible),
        roomCode: result.roomCode,
      });
      return;
    }
    const { room, player, isRejoin } = result;
    socket.join(room.code);

    // Enregistrer la session pour la reconnexion
    sessionRegistry.set(player.sessionId, {
      socketId: socket.id,
      roomCode: room.code,
      nickname: player.nickname,
    });

    const isHost = room.hostId === socket.id;

    // Si c'est un rejoin (manuel via la modale), on envoie l'état complet selon la phase
    if (isRejoin) {
      let payload;
      if (room.phase === "lobby") {
        payload = store.buildLobbyPayload(room, io);
        io.to(room.code).emit("lobby_update", payload);
      } else if (room.phase === "role_reveal") {
        payload = store.buildRolesRevealPayload(room);
        io.to(room.code).emit("roles_reveal", payload);
      } else if (room.phase === "playing") {
        store.broadcastPlayingState(io, room);
        payload = store.buildPlayingPayloadForSocket(room, socket.id, io);
      }

      socket.to(room.code).emit("player_reconnected", {
        nickname: player.nickname,
        sessionId: player.sessionId,
      });

      cb?.({
        ok: true,
        code: room.code,
        sessionId: player.sessionId,
        isHost,
        phase: room.phase,
        lobby: room.phase === "lobby" ? payload : null,
        rolesReveal: room.phase === "role_reveal" ? payload : null,
        gameState: room.phase === "playing" ? payload : null,
      });
      return;
    }

    // Join classique (lobby)
    const payload = store.buildLobbyPayload(room, io);
    io.to(room.code).emit("lobby_update", payload);
    cb?.({
      ok: true,
      code: room.code,
      sessionId: player.sessionId,
      isHost: room.hostId === socket.id,
      lobby: payload,
    });
  });

  socket.on("update_settings", (partial, cb) => {
    const out = store.updateSettings(socket.id, partial);
    if (out.error) {
      cb?.({ ok: false, error: out.error });
      return;
    }
    const payload = store.buildLobbyPayload(out.room, io);
    io.to(out.room.code).emit("lobby_update", payload);
    cb?.({ ok: true, lobby: payload });
  });

  /** Étape 1 : tirage + écran révélation */
  socket.on("start_roles", (_data, cb) => {
    const out = store.startRoles(socket.id);
    if (out.error) {
      cb?.({ ok: false, error: out.error });
      return;
    }
    const { room } = out;
    io.to(room.code).emit("roles_reveal", store.buildRolesRevealPayload(room));
    cb?.({ ok: true });
  });

  /** Étape 2 : la chasse commence (délai carte pour les chats) */
  socket.on("begin_hunt", (_data, cb) => {
    const out = store.beginHunt(socket.id);
    if (out.error) {
      cb?.({ ok: false, error: out.error });
      return;
    }
    const { room } = out;
    store.broadcastPlayingState(io, room);
    cb?.({ ok: true });
  });

  /** Player marks that they have seen their role */
  socket.on("player_saw_role", (_data, cb) => {
    const code = store.socketToRoom.get(socket.id);
    if (!code) {
      cb?.({ ok: false, error: "Not in a room" });
      return;
    }
    const room = store.getRoomByCode(code);
    if (!room || room.phase !== "role_reveal") {
      cb?.({ ok: false, error: "Invalid phase" });
      return;
    }
    const player = room.players.get(socket.id);
    if (!player) {
      cb?.({ ok: false, error: "Player not found" });
      return;
    }
    player.hasSeenRole = true;
    io.to(room.code).emit("roles_reveal", store.buildRolesRevealPayload(room));
    cb?.({ ok: true });
  });

  socket.on("refresh_state", () => {
    const code = store.socketToRoom.get(socket.id);
    if (!code) return;
    const room = store.getRoomByCode(code);
    if (room?.phase === "playing") {
      store.broadcastPlayingState(io, room);
    } else if (room?.phase === "lobby") {
      io.to(room.code).emit("lobby_update", store.buildLobbyPayload(room, io));
    }
  });

  socket.on("admin_kick", ({ targetSessionId }, cb) => {
    const r = store.adminKick(io, socket.id, targetSessionId);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("admin_set_role", ({ targetSessionId, role }, cb) => {
    const r = store.adminSetRole(io, socket.id, targetSessionId, role);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("admin_end_game", (_data, cb) => {
    const r = store.adminEndGame(io, socket.id);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("admin_add_time", ({ minutes }, cb) => {
    const r = store.adminAddTime(io, socket.id, minutes);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("request_join_midgame", ({ code, nickname }, cb) => {
    const r = store.requestJoinMidgame(socket.id, code, nickname, io);
    if (r.error) {
      cb?.({ ok: false, error: r.error, useNormalJoin: Boolean(r.useNormalJoin) });
      return;
    }
    cb?.({ ok: true, requestId: r.requestId });
  });

  socket.on("respond_join_request", ({ requestId, accept }, cb) => {
    const r = store.respondJoinRequest(io, socket.id, requestId, Boolean(accept));
    if (r.error) {
      cb?.({ ok: false, error: r.error });
      return;
    }
    if (r.sessionId && r.joinerSocketId && accept) {
      sessionRegistry.set(r.sessionId, {
        socketId: r.joinerSocketId,
        roomCode: r.code,
        nickname: r.nickname || "Joueur",
      });
    }
    cb?.({ ok: true });
  });

  socket.on("position", ({ lat, lng }) => {
    console.log('[Server] Position received from socket:', socket.id, { lat, lng });
    const ctx = store.setPosition(socket.id, lat, lng);
    if (!ctx) {
      console.log('[Server] setPosition returned null');
      return;
    }
    const { room, player } = ctx;
    console.log('[Server] Position set for player:', player.sessionId, 'phase:', room.phase);
    if (room.phase === "lobby") {
      io.to(room.code).emit("lobby_update", store.buildLobbyPayload(room, io));
      return;
    }
    if (room.phase === "role_reveal") {
      console.log('[Server] Broadcasting roles_reveal with updated positions');
      io.to(room.code).emit("roles_reveal", store.buildRolesRevealPayload(room));
      return;
    }
    if (room.phase === "playing") {
      if (player.justWentOutOfBounds) {
        player.justWentOutOfBounds = false;
        io.to(room.code).emit("player_out_of_bounds", {
          sessionId: player.sessionId,
          nickname: player.nickname
        });
      }
      if (player.justReenteredZone) {
        player.justReenteredZone = false;
        io.to(room.code).emit("player_reentered_zone", {
          sessionId: player.sessionId,
          nickname: player.nickname
        });
      }
      if (player.justLostCoins) {
        player.justLostCoins = false;
        const timeline = room.timeline || [];
        const lastTimelineEntry = timeline[timeline.length - 1];
        if (lastTimelineEntry && lastTimelineEntry.type === "coins_lost_out_of_bounds" && lastTimelineEntry.sessionId === player.sessionId) {
          io.to(room.code).emit("coins_lost", {
            sessionId: player.sessionId,
            nickname: player.nickname,
            coinsLost: lastTimelineEntry.coinsLost
          });
        }
      }
      store.appendLocationSample(room, player);
      store.broadcastPlayingState(io, room);
    }
  });

  socket.on("party_chat_send", (body, cb) => {
    const r = store.partyChatSend(io, socket.id, body);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("use_power", (body, cb) => {
    const r = store.usePower(io, socket.id, body);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("admin_set_power_costs", (partialCosts, cb) => {
    const r = store.adminSetPowerCosts(io, socket.id, partialCosts || {});
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("admin_adjust_coins", ({ targetSessionId, delta }, cb) => {
    const r = store.adminAdjustCoins(io, socket.id, targetSessionId, delta);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true, coins: r.coins });
  });

  socket.on("capture_scan", ({ targetSessionId }, cb) => {
    const r = store.tryCapture(io, socket.id, targetSessionId);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("leave_room", (_data, cb) => {
    // Find sessionId before leaving
    const code = store.socketToRoom.get(socket.id);
    const room = code ? store.getRoomByCode(code) : null;
    const player = room ? room.players.get(socket.id) : null;
    if (player?.sessionId) {
      sessionRegistry.delete(player.sessionId);
    }

    const r = store.leaveRoomVoluntarily(io, socket.id);
    if (r.error) cb?.({ ok: false, error: r.error });
    else cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    clearInterval(heartbeatInterval);

    const code = store.socketToRoom.get(socket.id);
    if (!code) return;

    const room = store.getRoomByCode(code);
    if (!room) {
      store.socketToRoom.delete(socket.id);
      return;
    }

    const player = room.players.get(socket.id);
    if (player) {
      player.disconnectedAt = Date.now();
      io.to(code).emit("player_disconnected", {
        nickname: player.nickname,
        sessionId: player.sessionId,
      });
      store.recordPlayerTimelineDisconnect(code, {
        nickname: player.nickname,
        sessionId: player.sessionId,
      });
      store.purgeStaleDisconnects(io, room);
      const r = store.getRoomByCode(code);
      if (!r) return;
      if (r.phase === "lobby") {
        io.to(code).emit("lobby_update", store.buildLobbyPayload(r, io));
      } else if (r.phase === "role_reveal") {
        io.to(code).emit("roles_reveal", store.buildRolesRevealPayload(r));
      } else if (r.phase === "playing") {
        store.broadcastPlayingState(io, r);
      }
      store.scheduleNukeIfAllAway(io, r);
      return;
    }

    store.socketToRoom.delete(socket.id);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Serveur chase-gps sur http://${HOST}:${PORT}`);
});
