// MCP tool definitions and handlers.
import { loadConfig, normalizePlatform } from './config.mjs';
import {
  aggregateHabits, analyzeTimeline, gameRecord, matchDetail, queueId, queueName, summarizeMatch,
} from './analysis.mjs';

const PLAYER_PROPS = {
  riot_id: {
    type: 'string',
    description: 'Riot ID as "GameName#TAG". Omit to use the configured default player.',
  },
  platform: {
    type: 'string',
    description: 'Server the account plays on: na1, euw1, eun1, kr, br1, la1, la2, oc1, jp1, tr1, ru, me1, sg2, tw2, vn2 (aliases like na, euw, kr work). Omit to use the configured default.',
  },
};
const QUEUE_PROP = {
  type: 'string',
  description: 'Queue filter: all (default), ranked_solo, ranked_flex, normal_draft, quickplay, swiftplay, aram, clash, or a numeric queue id.',
};

// Run tasks with limited concurrency, stopping early once the deadline passes.
async function pooled(items, limit, deadline, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && Date.now() < deadline) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// Fetch a match and swap the API's internal champion names ("MonkeyKing") for display names ("Wukong").
async function getMatch(client, id, region) {
  const [match, staticData] = await Promise.all([client.match(id, region), client.staticData()]);
  const names = staticData.championNames || {};
  for (const p of match.info.participants) p.championName = names[p.championName] || p.championName;
  return match;
}

const player = (client, args) =>
  client.resolvePlayer(args.riot_id, args.platform ? normalizePlatform(args.platform) : undefined);

const clampInt = (v, def, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def));

export const TOOLS = [
  {
    name: 'get_player_profile',
    description:
      'Profile for a League of Legends player: summoner level, ranked tiers/LP/win rates for solo and flex, and top champion masteries. Start here to learn who you are coaching.',
    inputSchema: { type: 'object', properties: { ...PLAYER_PROPS } },
    async handler(client, args) {
      const p = await player(client, args);
      const [summoner, leagues, masteries, staticData] = await Promise.all([
        client.summoner(p), client.leagueEntries(p), client.topMasteries(p, 10), client.staticData(),
      ]);
      return {
        riotId: p.riotId,
        platform: p.platform,
        summonerLevel: summoner.summonerLevel,
        ranked: leagues.map((l) => ({
          queue: l.queueType === 'RANKED_SOLO_5x5' ? 'ranked_solo' : l.queueType === 'RANKED_FLEX_SR' ? 'ranked_flex' : l.queueType,
          rank: `${l.tier} ${l.rank}`,
          lp: l.leaguePoints,
          wins: l.wins,
          losses: l.losses,
          winRate: Math.round((100 * l.wins) / Math.max(1, l.wins + l.losses)),
          hotStreak: l.hotStreak,
        })),
        topMasteries: masteries.map((m) => ({
          champion: staticData.champions[m.championId] || `champion ${m.championId}`,
          level: m.championLevel,
          points: m.championPoints,
          lastPlayed: new Date(m.lastPlayTime).toISOString().slice(0, 10),
        })),
      };
    },
  },
  {
    name: 'get_match_history',
    description:
      'Recent matches for a player, newest first, each summarized from their point of view (champion, role, result, KDA, CS/min, damage share, vision, items). Use the returned matchId with get_match_detail or get_match_timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLAYER_PROPS,
        count: { type: 'integer', description: 'How many matches (1-30, default 10).' },
        start: { type: 'integer', description: 'Offset into history for paging (default 0 = most recent).' },
        queue: QUEUE_PROP,
      },
    },
    async handler(client, args) {
      const p = await player(client, args);
      const count = clampInt(args.count, 10, 1, 30);
      const ids = await client.matchIds(p, { start: clampInt(args.start, 0, 0, 100000), count, queue: queueId(args.queue) });
      const staticData = await client.staticData();
      const deadline = Date.now() + 80000;
      const matches = await pooled(ids, 4, deadline, (id) => getMatch(client, id, p.region));
      const done = matches.filter(Boolean);
      const out = { riotId: p.riotId, matches: done.map((m) => summarizeMatch(m, p.puuid, staticData)) };
      if (done.length < ids.length) {
        out.note = `Rate limits allowed only ${done.length} of ${ids.length} matches this call. Call again; fetched matches are cached.`;
      }
      return out;
    },
  },
  {
    name: 'get_match_detail',
    description:
      'Full post-game breakdown of one match: the player\'s detailed stats, runes and summoner spells, a side-by-side with their lane opponent, both teams\' scoreboards, and objective counts.',
    inputSchema: {
      type: 'object',
      properties: { match_id: { type: 'string', description: 'Match id such as "NA1_5012345678".' }, ...PLAYER_PROPS },
      required: ['match_id'],
    },
    async handler(client, args) {
      const p = await player(client, args);
      const [match, staticData] = await Promise.all([getMatch(client, args.match_id), client.staticData()]);
      return matchDetail(match, p.puuid, staticData);
    },
  },
  {
    name: 'get_match_timeline',
    description:
      'Minute-by-minute story of one match for the player: CS/gold/XP diffs vs lane opponent at 5/10/15/20 minutes, every death (time, who, how many, where, gold state), kills and assists, objectives taken by each team, shop visits, skill order and warding. This is the key tool for reviewing decision making.',
    inputSchema: {
      type: 'object',
      properties: { match_id: { type: 'string', description: 'Match id such as "NA1_5012345678".' }, ...PLAYER_PROPS },
      required: ['match_id'],
    },
    async handler(client, args) {
      const p = await player(client, args);
      const [match, timeline, staticData] = await Promise.all([
        getMatch(client, args.match_id), client.timeline(args.match_id), client.staticData(),
      ]);
      return analyzeTimeline(match, timeline, p.puuid, staticData);
    },
  },
  {
    name: 'analyze_habits',
    description:
      'Aggregate patterns across many recent games: overall and per-champion/per-role stats, how wins differ from losses, laning (CS and gold diffs at 10/15, win rate when ahead vs behind), death patterns (when, where, how), win rate by game length, session and tilt effects (performance after losses), and recent form. This is the main tool for finding habits to fix.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLAYER_PROPS,
        count: { type: 'integer', description: 'How many recent games to analyze (5-40, default 20).' },
        queue: QUEUE_PROP,
        champion: { type: 'string', description: 'Only include games on this champion (e.g. "Ahri").' },
        role: { type: 'string', description: 'Only include games in this role: top, jungle, mid, adc, support.' },
        include_timelines: {
          type: 'boolean',
          description: 'Fetch timelines for laning and death analysis (default true). Doubles the API calls on the first run; results are cached.',
        },
      },
    },
    async handler(client, args) {
      const p = await player(client, args);
      const count = clampInt(args.count, 20, 5, 40);
      const withTimelines = args.include_timelines !== false;
      const ids = await client.matchIds(p, { count, queue: queueId(args.queue) });
      const deadline = Date.now() + 85000;
      const records = (await pooled(ids, 4, deadline, async (id) => {
        const match = await getMatch(client, id, p.region);
        const timeline = withTimelines && match.info.gameMode === 'CLASSIC'
          ? await client.timeline(id, p.region).catch(() => null)
          : null;
        return gameRecord(match, p.puuid, timeline);
      })).filter(Boolean);

      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
      let filtered = records;
      if (args.champion) filtered = filtered.filter((g) => norm(g.champion) === norm(args.champion));
      if (args.role) filtered = filtered.filter((g) => g.role === norm(args.role));

      const out = { riotId: p.riotId, ...aggregateHabits(filtered) };
      if (records.length < ids.length) {
        out.partial = `Rate limits allowed only ${records.length} of ${ids.length} games this call. Call again with the same arguments to include the rest; fetched games are cached.`;
      }
      return out;
    },
  },
  {
    name: 'get_live_game',
    description:
      'If the player is in a game right now, returns the queue, game length so far, and both teams\' champions and players. Returns inGame:false otherwise.',
    inputSchema: { type: 'object', properties: { ...PLAYER_PROPS } },
    async handler(client, args) {
      const p = await player(client, args);
      const [game, staticData] = await Promise.all([client.liveGame(p), client.staticData()]);
      if (!game) return { riotId: p.riotId, inGame: false };
      const side = (teamId) => game.participants.filter((x) => x.teamId === teamId).map((x) => ({
        champion: staticData.champions[x.championId] || `champion ${x.championId}`,
        riotId: x.riotId,
        isPlayer: x.puuid === p.puuid,
      }));
      return {
        riotId: p.riotId,
        inGame: true,
        queue: queueName(game.gameQueueConfigId),
        gameMode: game.gameMode,
        minutesElapsed: Math.max(0, Math.round(game.gameLength / 60)),
        blueTeam: side(100),
        redTeam: side(200),
      };
    },
  },
  {
    name: 'get_setup_status',
    description:
      'Check whether the plugin is configured: is a Riot API key present and accepted, and what the default player and platform are. Never returns the key itself.',
    inputSchema: { type: 'object', properties: {} },
    async handler(client) {
      const cfg = loadConfig();
      const status = { apiKeyConfigured: Boolean(cfg.apiKey), defaultRiotId: cfg.riotId || null, defaultPlatform: cfg.platform };
      if (!cfg.apiKey) {
        status.nextStep = 'Get a key at https://developer.riotgames.com and run `node <plugin dir>/server/setup.mjs` in a terminal (or `/plugin configure`). Do not paste the key into chat.';
        return status;
      }
      try {
        // Cheapest authenticated call: platform status.
        await client.request(cfg.platform, '/lol/status/v4/platform-data');
        status.apiKeyValid = true;
      } catch (err) {
        status.apiKeyValid = false;
        status.error = err.message;
      }
      return status;
    },
  },
];
