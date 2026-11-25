// Synthetic match-v5 payloads shaped like the real API, small enough to reason about.
export const ME = 'puuid-me';

const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const CHAMPS = ['Garen', 'LeeSin', 'Ahri', 'Jinx', 'Thresh', 'Darius', 'Viego', 'Zed', 'Caitlyn', 'Lulu'];

export function makeMatch({ id = 'NA1_1', win = true, start = Date.UTC(2026, 10, 20, 18), duration = 1800,
  kills = 5, deaths = 3, assists = 7, cs = 200, remake = false, queueId = 420, champion = 'Ahri' } = {}) {
  const participants = CHAMPS.map((name, i) => {
    const teamId = i < 5 ? 100 : 200;
    const mine = i === 2;
    return {
      puuid: mine ? ME : `puuid-${i + 1}`,
      participantId: i + 1,
      teamId,
      championName: mine ? champion : name,
      riotIdGameName: mine ? 'Tester' : `P${i + 1}`,
      riotIdTagline: 'NA1',
      teamPosition: POSITIONS[i % 5],
      individualPosition: POSITIONS[i % 5],
      win: teamId === 100 ? win : !win,
      kills: mine ? kills : 2, deaths: mine ? deaths : 4, assists: mine ? assists : 3,
      totalMinionsKilled: mine ? cs : 150, neutralMinionsKilled: 0,
      goldEarned: mine ? 12000 : 9000,
      totalDamageDealtToChampions: mine ? 30000 : 10000,
      totalDamageTaken: 15000,
      visionScore: mine ? 30 : 20, wardsPlaced: 10, wardsKilled: 2, visionWardsBoughtInGame: mine ? 2 : 1,
      champLevel: 16, totalTimeSpentDead: mine ? 90 : 120, timeCCingOthers: 10,
      item0: 3089, item1: 0, item2: 0, item3: 0, item4: 0, item5: 0, item6: 3340,
      gameEndedInEarlySurrender: remake, gameEndedInSurrender: false,
      challenges: { soloKills: 1, laneMinionsFirst10Minutes: 75 },
      summoner1Id: 4, summoner2Id: 14,
      perks: { styles: [
        { description: 'primaryStyle', style: 8100, selections: [{ perk: 8112 }, { perk: 8143 }] },
        { description: 'subStyle', style: 8200, selections: [{ perk: 8226 }] },
      ] },
    };
  });
  return {
    metadata: { matchId: id },
    info: {
      gameCreation: start, gameEndTimestamp: start + duration * 1000, gameDuration: duration,
      queueId, gameMode: 'CLASSIC', gameVersion: '16.23.1.1', participants,
      teams: [100, 200].map((teamId) => ({
        teamId, win: teamId === 100 ? win : !win,
        objectives: { tower: { kills: 5, first: teamId === 100 }, dragon: { kills: 2 }, baron: { kills: 0 }, champion: { first: true } },
      })),
    },
  };
}

export function makeTimeline(match, { goldLeadPerMin = 50 } = {}) {
  const frames = [];
  for (let m = 0; m <= 20; m++) {
    const participantFrames = {};
    for (let pid = 1; pid <= 10; pid++) {
      const me = pid === 3;
      participantFrames[pid] = {
        totalGold: 500 + m * 400 + (me ? m * goldLeadPerMin : 0),
        xp: m * 450 + (me ? m * 20 : 0),
        level: 1 + Math.floor(m / 2),
        minionsKilled: m * (me ? 8 : 7),
        jungleMinionsKilled: 0,
      };
    }
    frames.push({ timestamp: m * 60000, participantFrames, events: [] });
  }
  const at = (min, sec, e) => frames[min].events.push({ timestamp: (min * 60 + sec) * 1000, ...e });
  // Ganked in the enemy half of mid lane at 6:30 (blue side player, position past the middle).
  at(6, 30, { type: 'CHAMPION_KILL', killerId: 8, victimId: 3, assistingParticipantIds: [7], position: { x: 8600, y: 8500 } });
  // Solo killed at 9:10.
  at(9, 10, { type: 'CHAMPION_KILL', killerId: 8, victimId: 3, assistingParticipantIds: [], position: { x: 7000, y: 7100 } });
  // A solo kill of our own.
  at(12, 0, { type: 'CHAMPION_KILL', killerId: 3, victimId: 8, assistingParticipantIds: [], position: { x: 7400, y: 7400 } });
  // Late pick in enemy jungle.
  at(19, 5, { type: 'CHAMPION_KILL', killerId: 6, victimId: 3, assistingParticipantIds: [7, 9], shutdownBounty: 300, position: { x: 10500, y: 7000 } });
  at(1, 0, { type: 'ITEM_PURCHASED', participantId: 3, itemId: 1056 });
  at(1, 5, { type: 'ITEM_PURCHASED', participantId: 3, itemId: 2003 });
  at(8, 0, { type: 'ITEM_PURCHASED', participantId: 3, itemId: 3089 });
  at(2, 0, { type: 'SKILL_LEVEL_UP', participantId: 3, skillSlot: 1 });
  at(3, 0, { type: 'SKILL_LEVEL_UP', participantId: 3, skillSlot: 3 });
  at(4, 0, { type: 'WARD_PLACED', creatorId: 3, wardType: 'YELLOW_TRINKET' });
  at(15, 0, { type: 'WARD_PLACED', creatorId: 3, wardType: 'CONTROL_WARD' });
  at(16, 0, { type: 'ELITE_MONSTER_KILL', killerId: 2, killerTeamId: 100, monsterType: 'DRAGON', monsterSubType: 'FIRE_DRAGON', assistingParticipantIds: [3] });
  at(17, 0, { type: 'BUILDING_KILL', teamId: 100, killerId: 8, buildingType: 'TOWER_BUILDING', laneType: 'MID_LANE', towerType: 'OUTER_TURRET' });
  return {
    metadata: { matchId: match.metadata.matchId },
    info: {
      frameInterval: 60000, frames,
      participants: match.info.participants.map((p) => ({ participantId: p.participantId, puuid: p.puuid })),
    },
  };
}

/** A fake fetch that serves the Riot endpoints from in-memory matches. */
export function fakeFetch(matches, { timelineOpts, log = [] } = {}) {
  const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), json: async () => body });
  return async (url, opts) => {
    const u = new URL(url);
    log.push({ host: u.host, path: u.pathname, key: opts?.headers?.['X-Riot-Token'] });
    const p = u.pathname;
    if (u.host.startsWith('ddragon')) {
      if (p.endsWith('runesReforged.json')) return json([
        { id: 8100, name: 'Domination', slots: [{ runes: [{ id: 8112, name: 'Electrocute' }] }, { runes: [{ id: 8143, name: 'Sudden Impact' }] }] },
        { id: 8200, name: 'Sorcery', slots: [{ runes: [{ id: 8226, name: 'Manaflow Band' }] }] },
      ]);
      if (p.endsWith('summoner.json')) return json({ data: { SummonerFlash: { key: '4', name: 'Flash' }, SummonerDot: { key: '14', name: 'Ignite' } } });
      if (p.endsWith('versions.json')) return json(['16.23.1']);
      if (p.endsWith('item.json')) return json({ data: { 3089: { name: "Rabadon's Deathcap" }, 1056: { name: "Doran's Ring" } } });
      if (p.endsWith('champion.json')) return json({ data: { Ahri: { id: 'Ahri', key: '103', name: 'Ahri' }, LeeSin: { id: 'LeeSin', key: '64', name: 'Lee Sin' } } });
    }
    if (p.includes('/accounts/by-riot-id/')) return json({ puuid: ME, gameName: 'Tester', tagLine: 'NA1' });
    if (p.includes('/summoners/by-puuid/')) return json({ summonerLevel: 120, profileIconId: 1 });
    if (p.includes('/league/v4/entries/')) return json([{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 30, losses: 20, hotStreak: false }]);
    if (p.includes('/champion-masteries/')) return json([{ championId: 103, championLevel: 12, championPoints: 150000, lastPlayTime: Date.UTC(2026, 10, 20) }]);
    if (p.endsWith('/ids')) return json(matches.map((m) => m.metadata.matchId));
    if (p.includes('/spectator/')) return json({}, 404);
    if (p.includes('/status/v4/')) return json({ id: 'NA1' });
    const m = p.match(/\/matches\/([^/]+)(\/timeline)?$/);
    if (m) {
      const match = matches.find((x) => x.metadata.matchId === m[1]);
      if (!match) return json({}, 404);
      return json(m[2] ? makeTimeline(match, timelineOpts) : match);
    }
    return json({}, 404);
  };
}
