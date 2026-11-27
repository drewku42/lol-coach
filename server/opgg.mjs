// Minimal client for OP.GG's public MCP server (streamable HTTP), used by the web app
// to show the standard build and matchup numbers next to what the player did.
const ENDPOINT = process.env.LOL_COACH_OPGG_URL || 'https://mcp-api.op.gg/mcp';
const CLIENT = 'lol-coach/0.3';

/** Display name to OP.GG's UPPER_SNAKE_CASE: "Miss Fortune" -> MISS_FORTUNE, "Kha'Zix" -> KHAZIX, "Nunu & Willump" -> NUNU_WILLUMP. */
export function opggChampion(name) {
  return String(name).replace(/['.]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
}

export class OpggClient {
  constructor({ fetchImpl = globalThis.fetch, endpoint = ENDPOINT } = {}) {
    this.fetch = fetchImpl;
    this.endpoint = endpoint;
    this.session = null;
    this.cache = new Map();
    this.nextId = 1;
  }

  async rpc(method, params, { notify = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const body = { jsonrpc: '2.0', method, params };
    if (!notify) body.id = this.nextId++;
    const res = await this.fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`OP.GG returned HTTP ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return null;
    const text = await res.text();
    // Either plain JSON or a server-sent event stream whose last data line is the reply.
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    const msg = JSON.parse(data.length ? data[data.length - 1] : text);
    if (msg.error) throw new Error(`OP.GG error: ${msg.error.message}`);
    return msg.result;
  }

  async callTool(name, args) {
    if (!this.session) {
      await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lol-coach', version: '0.3' } });
      await this.rpc('notifications/initialized', undefined, { notify: true }).catch(() => {});
    }
    let result;
    try {
      result = await this.rpc('tools/call', { name, arguments: { ...args, client_app: CLIENT } });
    } catch (err) {
      this.session = null; // a stale session is the usual cause; the next call starts fresh
      throw err;
    }
    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) throw new Error(`OP.GG: ${text.slice(0, 200)}`);
    return text;
  }

  /** Matchup numbers and the standard build for `champion` into `opponent` in a lane. */
  async matchup(champion, opponent, position) {
    const key = `${champion}|${opponent}|${position}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.value;
    const raw = JSON.parse(await this.callTool('lol_get_lane_matchup_guide', {
      position, my_champion: opggChampion(champion), opponent_champion: opggChampion(opponent),
    }));
    const value = summarizeMatchup(raw, opponent);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

const rate = (x) => (x && x.play ? Math.round((1000 * x.win) / x.play) / 10 : null);
const top = (list, n = 3) => (Array.isArray(list) ? list : list ? [list] : []).slice(0, n);

/** Reduce OP.GG's large matchup payload to what the review page shows. */
export function summarizeMatchup(raw, opponentName) {
  const d = raw.data || {};
  const versus = (d.counters || []).find((c) => c.champion_name === opponentName);
  const build = (x) => ({ items: x.ids_names, games: x.play, winRate: rate(x), pickRate: Math.round((x.pick_rate || 0) * 100) });
  const page = top(d.rune_pages, 1)[0]?.builds?.[0] || top(d.runes, 1)[0];
  return {
    champion: raw.my_champion,
    opponent: raw.opponent_champion,
    position: raw.position,
    headToHead: versus ? { games: versus.play, winRate: rate(versus) } : null,
    laneAdvantage: d.lane_advantage_champion || null,
    soloKillAdvantage: d.lane_solo_kill_advantage_champion || null,
    playStyle: d.recommended_play_style || null,
    tip: d.opponent_champion_tip || null,
    coreBuilds: top(d.core_items).map(build),
    boots: top(d.boots, 1).map(build)[0] || null,
    starter: top(d.starter_items, 1).map(build)[0] || null,
    runes: page ? {
      keystone: page.primary_rune_names?.[0],
      primaryTree: page.primary_page_name,
      primary: page.primary_rune_names?.slice(1),
      secondaryTree: page.secondary_page_name,
      secondary: page.secondary_rune_names,
      games: page.play, winRate: rate(page),
    } : null,
    summonerSpells: top(d.summoner_spells, 1)[0]?.ids_names || null,
    skillOrder: (top(d.skills, 1)[0]?.order || []).join(''),
    winRateByGameLength: (d.game_lengths || []).map((g) => ({ fromMinute: g.game_length, winRate: Math.round(g.rate * 1000) / 10 })),
    source: 'OP.GG',
  };
}
