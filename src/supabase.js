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
