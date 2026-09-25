const RECAP_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_RECAPS = 400;

function randomRecapId(length = 8) {
  let id = "";
  for (let index = 0; index < length; index += 1) {
    id += RECAP_CHARS[Math.floor(Math.random() * RECAP_CHARS.length)];
  }
  return id;
}

function rememberRecap(recapStore, id, summary) {
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

  return recapStore;
}
