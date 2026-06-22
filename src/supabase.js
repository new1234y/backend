import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function saveGameSummary(gameSummary) {
  try {
    const { data, error } = await supabase
      .from('game_history')
      .insert({
        code: gameSummary.code,
        hunt_started_at: gameSummary.huntStartedAt ? new Date(gameSummary.huntStartedAt).toISOString() : null,
        ended_at: gameSummary.endedAt ? new Date(gameSummary.endedAt).toISOString() : null,
        duration_ms: gameSummary.durationMs || null,
        game_center: gameSummary.gameCenter || null,
        global_radius_m: gameSummary.globalRadiusM || null,
        jam_radius_m: gameSummary.jamRadiusM || null,
        settings_snapshot: gameSummary.settingsSnapshot || null,
        players: gameSummary.players || null,
        colors: gameSummary.colors || null,
        party_chat: gameSummary.partyChat || null,
        shrink_phases_list: gameSummary.shrinkPhasesList || null,
        balises: gameSummary.balises || null,
        analytics: gameSummary.analytics || null,
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving game summary to Supabase:', error);
      throw error;
    }

    console.log('Game summary saved to Supabase:', data.id);
    return data;
  } catch (error) {
    console.error('Failed to save game summary to Supabase:', error);
    throw error;
  }
}

export async function getGameHistory(limit = 10) {
  try {
    const { data, error } = await supabase
      .from('game_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching game history from Supabase:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Failed to fetch game history from Supabase:', error);
    throw error;
  }
}

export async function getGameByCode(code) {
  try {
    const { data, error } = await supabase
      .from('game_history')
      .select('*')
      .eq('code', code)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // No rows returned
      }
      console.error('Error fetching game by code from Supabase:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Failed to fetch game by code from Supabase:', error);
    throw error;
  }
}

// Active rooms persistence
export async function saveActiveRoom(roomData) {
  try {
    const { error } = await supabase
      .from('active_rooms')
      .upsert({
        code: roomData.code,
        data: roomData,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'code'
      });

    if (error) {
      console.error('Error saving active room to Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to save active room to Supabase:', error);
    return false;
  }
}

export async function getActiveRooms() {
  try {
    const { data, error } = await supabase
      .from('active_rooms')
      .select('code, data');

    if (error) {
      console.error('Error fetching active rooms from Supabase:', error);
      throw error;
    }

    return data || [];
  } catch (error) {
    console.error('Failed to fetch active rooms from Supabase:', error);
    return [];
  }
}

export async function deleteActiveRoom(code) {
  try {
    const { error } = await supabase
      .from('active_rooms')
      .delete()
      .eq('code', code);

    if (error) {
      console.error('Error deleting active room from Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to delete active room from Supabase:', error);
    return false;
  }
}

// Game messages persistence
export async function saveGameMessage(roomCode, sessionId, nickname, message, type = 'text', lat = null, lng = null) {
  try {
    const { error } = await supabase
      .from('game_messages')
      .insert({
        room_code: roomCode,
        session_id: sessionId,
        nickname,
        message,
        type,
        lat,
        lng,
        timestamp: new Date().toISOString()
      });

    if (error) {
      console.error('Error saving game message to Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to save game message to Supabase:', error);
    return false;
  }
}

export async function getGameMessages(roomCode, limit = 100) {
  try {
    const { data, error } = await supabase
      .from('game_messages')
      .select('*')
      .eq('room_code', roomCode)
      .order('timestamp', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('Error fetching game messages from Supabase:', error);
      throw error;
    }

    return data || [];
  } catch (error) {
    console.error('Failed to fetch game messages from Supabase:', error);
    return [];
  }
}

// Game timeline persistence
export async function saveTimelineEvent(roomCode, eventType, eventData) {
  try {
    const { error } = await supabase
      .from('game_timeline')
      .insert({
        room_code: roomCode,
        event_type: eventType,
        event_data: eventData,
        timestamp: new Date().toISOString()
      });

    if (error) {
      console.error('Error saving timeline event to Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to save timeline event to Supabase:', error);
    return false;
  }
}

// Active powers persistence
export async function saveActivePower(roomCode, sessionId, nickname, powerType, powerData, startedAt, endsAt) {
  try {
    const { error } = await supabase
      .from('active_powers')
      .insert({
        room_code: roomCode,
        session_id: sessionId,
        nickname,
        power_type: powerType,
        power_data: powerData,
        started_at: new Date(startedAt).toISOString(),
        ends_at: new Date(endsAt).toISOString(),
      });

    if (error) {
      console.error('Error saving active power to Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to save active power to Supabase:', error);
    return false;
  }
}

export async function removeActivePower(roomCode, sessionId, powerType) {
  try {
    const { error } = await supabase
      .from('active_powers')
      .delete()
      .eq('room_code', roomCode)
      .eq('session_id', sessionId)
      .eq('power_type', powerType);

    if (error) {
      console.error('Error removing active power from Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to remove active power from Supabase:', error);
    return false;
  }
}

export async function getActivePowers(roomCode, sessionId) {
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('active_powers')
      .select('*')
      .eq('room_code', roomCode)
      .eq('session_id', sessionId)
      .gt('ends_at', now);

    if (error) {
      console.error('Error fetching active powers from Supabase:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Failed to fetch active powers from Supabase:', error);
    return [];
  }
}

export async function cleanupExpiredPowers() {
  try {
    const { error } = await supabase.rpc('cleanup_expired_powers');
    if (error) {
      console.error('Error cleaning up expired powers:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to cleanup expired powers:', error);
    return false;
  }
}

export async function getGameTimeline(roomCode, limit = 200) {
  try {
    const { data, error } = await supabase
      .from('game_timeline')
      .select('*')
      .eq('room_code', roomCode)
      .order('timestamp', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('Error fetching game timeline from Supabase:', error);
      throw error;
    }

    return data || [];
  } catch (error) {
    console.error('Failed to fetch game timeline from Supabase:', error);
    return [];
  }
}

// Game sessions persistence
export async function saveSession(sessionId, socketId, roomCode, nickname) {
  try {
    const { error } = await supabase
      .from('game_sessions')
      .upsert({
        session_id: sessionId,
        socket_id: socketId,
        room_code: roomCode,
        nickname,
        last_seen: new Date().toISOString()
      }, {
        onConflict: 'session_id'
      });

    if (error) {
      console.error('Error saving session to Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to save session to Supabase:', error);
    return false;
  }
}

export async function getSession(sessionId) {
  try {
    const { data, error } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      console.error('Error fetching session from Supabase:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Failed to fetch session from Supabase:', error);
    return null;
  }
}

export async function deleteSession(sessionId) {
  try {
    const { error } = await supabase
      .from('game_sessions')
      .delete()
      .eq('session_id', sessionId);

    if (error) {
      console.error('Error deleting session from Supabase:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to delete session from Supabase:', error);
    return false;
  }
}

export async function getRoomSessions(roomCode) {
  try {
    const { data, error } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('room_code', roomCode);

    if (error) {
      console.error('Error fetching room sessions from Supabase:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Failed to fetch room sessions from Supabase:', error);
    return [];
  }
}
