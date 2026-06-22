-- Table pour persister les rooms actives (permet de restaurer après crash)
CREATE TABLE IF NOT EXISTS active_rooms (
  code TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Désactiver RLS pour permettre l'accès depuis le backend
ALTER TABLE active_rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to active_rooms" ON active_rooms FOR ALL USING (true) WITH CHECK (true);

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_active_rooms_updated_at ON active_rooms(updated_at);

-- Table pour l'historique des messages de chat
CREATE TABLE IF NOT EXISTS game_messages (
  id BIGSERIAL PRIMARY KEY,
  room_code TEXT NOT NULL,
  session_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Désactiver RLS pour permettre l'accès depuis le backend
ALTER TABLE game_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to game_messages" ON game_messages FOR ALL USING (true) WITH CHECK (true);

-- Indexes pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_game_messages_room_code ON game_messages(room_code);
CREATE INDEX IF NOT EXISTS idx_game_messages_timestamp ON game_messages(timestamp);

-- Table pour l'historique des événements (timeline)
CREATE TABLE IF NOT EXISTS game_timeline (
  id BIGSERIAL PRIMARY KEY,
  room_code TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Désactiver RLS pour permettre l'accès depuis le backend
ALTER TABLE game_timeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to game_timeline" ON game_timeline FOR ALL USING (true) WITH CHECK (true);

-- Indexes pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_game_timeline_room_code ON game_timeline(room_code);
CREATE INDEX IF NOT EXISTS idx_game_timeline_timestamp ON game_timeline(timestamp);

-- Table pour les sessions (permet la reconnexion après crash)
CREATE TABLE IF NOT EXISTS game_sessions (
  session_id TEXT PRIMARY KEY,
  socket_id TEXT,
  room_code TEXT,
  nickname TEXT,
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Désactiver RLS pour permettre l'accès depuis le backend
ALTER TABLE game_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to game_sessions" ON game_sessions FOR ALL USING (true) WITH CHECK (true);

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_game_sessions_room_code ON game_sessions(room_code);
CREATE INDEX IF NOT EXISTS idx_game_sessions_last_seen ON game_sessions(last_seen);

-- Nettoyer les sessions anciennes (plus de 24h)
-- Cette fonction peut être appelée périodiquement
CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS void AS $$
BEGIN
  DELETE FROM game_sessions
  WHERE last_seen < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Nettoyer les messages anciens (plus de 7 jours)
-- Cette fonction peut être appelée périodiquement
CREATE OR REPLACE FUNCTION cleanup_old_messages()
RETURNS void AS $$
BEGIN
  DELETE FROM game_messages
  WHERE timestamp < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- Nettoyer les timeline anciennes (plus de 7 jours)
-- Cette fonction peut être appelée périodiquement
CREATE OR REPLACE FUNCTION cleanup_old_timeline()
RETURNS void AS $$
BEGIN
  DELETE FROM game_timeline
  WHERE timestamp < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- Table pour l'historique des parties terminées
CREATE TABLE IF NOT EXISTS game_history (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  hunt_started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_ms BIGINT,
  game_center JSONB,
  global_radius_m DOUBLE PRECISION,
  jam_radius_m DOUBLE PRECISION,
  settings_snapshot JSONB,
  players JSONB,
  colors JSONB,
  party_chat JSONB,
  shrink_phases_list JSONB,
  balises JSONB,
  analytics JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Désactiver RLS pour permettre l'accès depuis le backend
ALTER TABLE game_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to game_history" ON game_history FOR ALL USING (true) WITH CHECK (true);

-- Indexes pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_game_history_code ON game_history(code);
CREATE INDEX IF NOT EXISTS idx_game_history_created_at ON game_history(created_at);

-- Table pour les récaps de parties (utilisée par l'endpoint /api/recap)
CREATE TABLE IF NOT EXISTS game_recaps (
  id TEXT PRIMARY KEY,
  summary JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Désactiver RLS pour permettre l'accès depuis le backend
ALTER TABLE game_recaps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to game_recaps" ON game_recaps FOR ALL USING (true) WITH CHECK (true);

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_game_recaps_created_at ON game_recaps(created_at);
