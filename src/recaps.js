const RECAP_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_RECAPS = 400;

function randomRecapId(length = 8) {
  let id = "";
  for (let index = 0; index < length; index += 1) {
    id += RECAP_CHARS[Math.floor(Math.random() * RECAP_CHARS.length)];
  }
  return id;
}

export function rememberRecap(recapStore, id, summary) {
  recapStore.set(id, { at: Date.now(), summary });
  while (recapStore.size > MAX_RECAPS) {
    const oldest = [...recapStore.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    recapStore.delete(oldest[0]);
  }
}

/**
 * Registers the recap endpoints and returns the in-memory store for observability.
 * Supabase remains the first read/write path, with the existing bounded fallback.
 */
export function registerRecapRoutes(app, { supabase }) {
  const recapStore = new Map();

  app.post("/api/recap", async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "invalid_body" });
      }

      let id = randomRecapId();
      if (supabase) {
        const { error } = await supabase.from("game_recaps").insert({ id, summary: body });
        if (!error) return res.json({ id });
        console.error("supabase_insert_error", error?.message || error);
      }

      while (recapStore.has(id)) id = randomRecapId();
      rememberRecap(recapStore, id, body);
      return res.json({ id });
    } catch (error) {
      console.error(error);
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

  app.get("/api/game/:code/summary", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const row = recapStore.get(code);
    if (row?.summary) return res.json(row.summary);

    if (supabase) {
      const { data: recap, error: recapError } = await supabase
        .from("game_recaps")
        .select("summary")
        .eq("id", code)
        .maybeSingle();
      if (recapError) {
        console.error("supabase_complete_summary_select_error", recapError?.message || recapError);
      } else if (recap?.summary) {
        return res.json(recap.summary);
      }

      const { data, error } = await supabase
        .from("game_history")
        .select("*")
        .eq("code", code)
        .maybeSingle();
      if (error) {
        console.error("supabase_game_summary_select_error", error?.message || error);
      } else if (data) {
        return res.json({
          code: data.code,
          huntStartedAt: data.hunt_started_at,
          endedAt: data.ended_at,
          gameCenter: data.game_center,
          globalRadiusM: data.global_radius_m,
          jamRadiusM: data.jam_radius_m,
          settingsSnapshot: data.settings_snapshot,
          timeline: [],
          paths: {},
          jamHistory: [],
          players: data.players || [],
          colors: data.colors || {},
          partyChat: data.party_chat || [],
          shrinkPhasesList: data.shrink_phases_list,
          balises: data.balises || [],
          analytics: data.analytics || null,
        });
      }
    }

    return res.status(404).json({ error: "not_found" });
  });

  return recapStore;
}
