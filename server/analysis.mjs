// Pure analysis over Riot match-v5 payloads. No I/O here, so it is easy to test.

export const QUEUES = {
  ranked_solo: 420, ranked_flex: 440, normal_draft: 400, quickplay: 490,
  swiftplay: 480, aram: 450, clash: 700,
};
const QUEUE_NAMES = Object.fromEntries(Object.entries(QUEUES).map(([k, v]) => [v, k]));

export function queueId(input) {
  if (input === undefined || input === null || input === '' || input === 'all') return undefined;
  if (typeof input === 'number' || /^\d+$/.test(String(input))) return Number(input);
  const id = QUEUES[String(input).toLowerCase()];
  if (!id) throw new Error(`Unknown queue "${input}". Use one of: all, ${Object.keys(QUEUES).join(', ')}, or a numeric queue id.`);
  return id;
}

export const queueName = (id) => QUEUE_NAMES[id] || `queue_${id}`;

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const avg = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pct = (num, den) => (den ? round((100 * num) / den, 0) : null);
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const ROLE = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' };
const roleOf = (p) => ROLE[p.teamPosition] || ROLE[p.individualPosition] || null;

export function findPlayer(match, puuid) {
  const p = match.info.participants.find((x) => x.puuid === puuid);
  if (!p) throw new Error(`Player is not a participant in match ${match.metadata.matchId}.`);
  return p;
}

export function laneOpponent(match, player) {
  if (!player.teamPosition) return null;
  return match.info.participants.find(
    (x) => x.teamId !== player.teamId && x.teamPosition === player.teamPosition
  ) || null;
}

export const isRemake = (match, player) =>
  Boolean(player.gameEndedInEarlySurrender) || match.info.gameDuration < 300;

const cs = (p) => (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
const kdaRatio = (p) => round((p.kills + p.assists) / Math.max(1, p.deaths), 2);

function itemNames(p, staticData) {
  const names = [];
  for (let i = 0; i <= 6; i++) {
    const id = p[`item${i}`];
    if (id) names.push(staticData?.items?.[id] || `item ${id}`);
  }
  return names;
}

function runesOf(p, staticData) {
  const name = (id) => staticData?.runes?.[id] || `rune ${id}`;
  const styles = p.perks?.styles || [];
  const primary = styles.find((x) => x.description === 'primaryStyle') || styles[0];
  const secondary = styles.find((x) => x.description === 'subStyle') || styles[1];
  if (!primary) return undefined;
  const picks = (style) => (style?.selections || []).map((sel) => name(sel.perk));
  return {
    keystone: picks(primary)[0],
    primaryTree: name(primary.style),
    primary: picks(primary).slice(1),
    secondaryTree: secondary ? name(secondary.style) : undefined,
    secondary: picks(secondary),
  };
}

const spellsOf = (p, staticData) =>
  [p.summoner1Id, p.summoner2Id].filter(Boolean).map((id) => staticData?.spells?.[id] || `spell ${id}`);

function teamTotals(match, teamId) {
  const team = match.info.participants.filter((x) => x.teamId === teamId);
  return {
    kills: team.reduce((a, x) => a + x.kills, 0),
    damage: team.reduce((a, x) => a + x.totalDamageDealtToChampions, 0),
    gold: team.reduce((a, x) => a + x.goldEarned, 0),
  };
}

/** One-line-ish summary of a match from the player's point of view. */
export function summarizeMatch(match, puuid, staticData) {
  const p = findPlayer(match, puuid);
  const info = match.info;
  const minutes = info.gameDuration / 60;
  const totals = teamTotals(match, p.teamId);
  const opp = laneOpponent(match, p);
  return {
    matchId: match.metadata.matchId,
    playedAt: new Date(info.gameCreation).toISOString(),
    queue: queueName(info.queueId),
    durationMin: round(minutes),
    remake: isRemake(match, p),
    win: p.win,
    champion: p.championName,
    role: roleOf(p),
    vs: opp ? opp.championName : null,
    kda: `${p.kills}/${p.deaths}/${p.assists}`,
    kdaRatio: kdaRatio(p),
    killParticipation: pct(p.kills + p.assists, totals.kills),
    cs: cs(p),
    csPerMin: round(cs(p) / minutes),
    goldPerMin: round(p.goldEarned / minutes, 0),
    damageToChamps: p.totalDamageDealtToChampions,
    damageShare: pct(p.totalDamageDealtToChampions, totals.damage),
    visionScore: p.visionScore,
    visionPerMin: round(p.visionScore / minutes, 2),
    controlWardsBought: p.visionWardsBoughtInGame,
    items: itemNames(p, staticData),
  };
}

function scoreboardRow(p, minutes, staticData) {
  return {
    champion: p.championName,
    role: roleOf(p),
    riotId: p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline}` : undefined,
    kda: `${p.kills}/${p.deaths}/${p.assists}`,
    level: p.champLevel,
    cs: cs(p),
    csPerMin: round(cs(p) / minutes),
    gold: p.goldEarned,
    damageToChamps: p.totalDamageDealtToChampions,
    damageTaken: p.totalDamageTaken,
    visionScore: p.visionScore,
    items: itemNames(p, staticData),
  };
}

/** Full post-game breakdown: player, lane opponent, both teams, objectives. */
export function matchDetail(match, puuid, staticData) {
  const p = findPlayer(match, puuid);
  const info = match.info;
  const minutes = info.gameDuration / 60;
  const opp = laneOpponent(match, p);
  const ch = p.challenges || {};

  const detail = (x) => ({
    ...scoreboardRow(x, minutes, staticData),
    runes: runesOf(x, staticData),
    summonerSpells: spellsOf(x, staticData),
    goldPerMin: round(x.goldEarned / minutes, 0),
    damagePerMin: round(x.totalDamageDealtToChampions / minutes, 0),
    damageToObjectives: x.damageDealtToObjectives,
    damageToTurrets: x.damageDealtToTurrets,
    turretTakedowns: x.turretTakedowns,
    wardsPlaced: x.wardsPlaced,
    wardsKilled: x.wardsKilled,
    controlWardsBought: x.visionWardsBoughtInGame,
    timeSpentDeadSec: x.totalTimeSpentDead,
    timeDeadPct: pct(x.totalTimeSpentDead, info.gameDuration),
    ccScore: x.timeCCingOthers,
    largestMultiKill: x.largestMultiKill,
    firstBlood: Boolean(x.firstBloodKill || x.firstBloodAssist),
    soloKills: x.challenges?.soloKills,
    turretPlates: x.challenges?.turretPlatesTaken,
    csAt10: x.challenges?.laneMinionsFirst10Minutes,
    skillshotsHit: x.challenges?.skillshotsHit,
    skillshotsDodged: x.challenges?.skillshotsDodged,
  });

  const teams = info.teams.map((t) => {
    const o = t.objectives || {};
    const totals = teamTotals(match, t.teamId);
    return {
      side: t.teamId === 100 ? 'blue' : 'red',
      isPlayersTeam: t.teamId === p.teamId,
      win: t.win,
      kills: totals.kills,
      gold: totals.gold,
      objectives: {
        towers: o.tower?.kills, dragons: o.dragon?.kills, barons: o.baron?.kills,
        heralds: o.riftHerald?.kills, voidGrubs: o.horde?.kills, atakhan: o.atakhan?.kills,
        inhibitors: o.inhibitor?.kills,
        firstBlood: o.champion?.first, firstTower: o.tower?.first, firstDragon: o.dragon?.first,
      },
      players: info.participants
        .filter((x) => x.teamId === t.teamId)
        .map((x) => scoreboardRow(x, minutes, staticData)),
    };
  });

  const team = teamTotals(match, p.teamId);
  return {
    ...summarizeMatch(match, puuid, staticData),
    patch: String(info.gameVersion || '').split('.').slice(0, 2).join('.'),
    side: p.teamId === 100 ? 'blue' : 'red',
    endedInSurrender: Boolean(p.gameEndedInSurrender),
    player: {
      ...detail(p),
      killParticipation: pct(p.kills + p.assists, team.kills),
      damageShare: pct(p.totalDamageDealtToChampions, team.damage),
      goldShare: pct(p.goldEarned, team.gold),
      maxCsLeadOverLaneOpponent: round(ch.maxCsAdvantageOnLaneOpponent, 0),
      maxLevelLeadOverLaneOpponent: ch.maxLevelLeadLaneOpponent,
    },
    laneOpponent: opp ? detail(opp) : null,
    teams,
  };
}

// ---- timeline ----------------------------------------------------------------

const MAP = 14800; // Summoner's Rift is roughly 0..14800 on both axes; blue base is bottom-left.

/** Rough map zone for a position. Approximate by design: good enough to spot patterns. */
export function zoneOf(pos, teamId) {
  if (!pos) return null;
  const { x, y } = pos;
  const blueHalf = x + y < MAP;
  const side = blueHalf === (teamId === 100) ? 'own' : 'enemy';
  if (x < 3500 && y < 3500) return teamId === 100 ? 'own base' : 'enemy base';
  if (x > MAP - 3500 && y > MAP - 3500) return teamId === 200 ? 'own base' : 'enemy base';
  let area;
  if (x < 2400 || y > MAP - 2400) area = 'top lane';
  else if (y < 2400 || x > MAP - 2400) area = 'bot lane';
  else if (Math.abs(x - y) < 1300) area = 'mid lane';
  else if (Math.abs(x + y - MAP) < 1400) return y > x ? 'top river' : 'bot river';
  else area = y > x ? 'top jungle' : 'bot jungle';
  return `${side} ${area}`;
}

const phaseOf = (ms) => (ms < 14 * 60000 ? 'early' : ms < 25 * 60000 ? 'mid' : 'late');

function participantId(timeline, puuid) {
  const entry = timeline.info.participants.find((x) => x.puuid === puuid);
  if (!entry) throw new Error('Player not found in timeline.');
  return entry.participantId;
}

function frameStats(frame, id) {
  const f = frame?.participantFrames?.[String(id)];
  if (!f) return null;
  return {
    gold: f.totalGold,
    xp: f.xp,
    level: f.level,
    cs: (f.minionsKilled || 0) + (f.jungleMinionsKilled || 0),
  };
}

/** Player-vs-lane-opponent numbers at fixed minutes, e.g. [10, 15]. */
export function checkpoints(timeline, id, oppId, minutes = [5, 10, 15, 20]) {
  const frames = timeline.info.frames;
  const out = [];
  for (const m of minutes) {
    const me = frameStats(frames[m], id);
    if (!me) break;
    const row = { minute: m, cs: me.cs, gold: me.gold, level: me.level };
    const opp = oppId ? frameStats(frames[m], oppId) : null;
    if (opp) {
      row.csDiff = me.cs - opp.cs;
      row.goldDiff = me.gold - opp.gold;
      row.xpDiff = me.xp - opp.xp;
    }
    const teamOf = (pid) => (pid <= 5 ? 100 : 200);
    let teamGold = 0;
    for (const [pid, f] of Object.entries(frames[m].participantFrames)) {
      teamGold += (teamOf(Number(pid)) === teamOf(id) ? 1 : -1) * f.totalGold;
    }
    row.teamGoldDiff = teamGold;
    out.push(row);
  }
  return out;
}

function deathKind(event, phase) {
  const attackers = 1 + (event.assistingParticipantIds?.length || 0);
  if (!event.killerId) return 'executed';
  if (attackers === 1) return 'solo-killed';
  if (phase === 'early') return attackers === 2 ? 'ganked or 2v1' : 'dove or collapsed on';
  return attackers >= 4 ? 'teamfight' : 'skirmish or pick';
}

/** Everything that happened to/around the player, in time order. */
export function analyzeTimeline(match, timeline, puuid, staticData) {
  const p = findPlayer(match, puuid);
  const id = participantId(timeline, puuid);
  const opp = laneOpponent(match, p);
  const oppId = opp ? participantId(timeline, opp.puuid) : null;
  const champ = {};
  for (const tp of timeline.info.participants) {
    const mp = match.info.participants.find((x) => x.puuid === tp.puuid);
    champ[tp.participantId] = mp?.championName || `player ${tp.participantId}`;
  }
  const frames = timeline.info.frames;

  const deaths = [], kills = [], objectives = [], purchases = [], skillOrder = [];
  const wards = { placed: 0, killed: 0, controlPlaced: 0, placedByPhase: { early: 0, mid: 0, late: 0 } };
  let lastBuy = null;

  frames.forEach((frame, frameIdx) => {
    for (const e of frame.events || []) {
      const phase = phaseOf(e.timestamp);
      switch (e.type) {
        case 'CHAMPION_KILL': {
          const assists = e.assistingParticipantIds || [];
          if (e.victimId === id) {
            const me = frameStats(frames[frameIdx], id);
            const them = oppId ? frameStats(frames[frameIdx], oppId) : null;
            deaths.push({
              time: clock(e.timestamp),
              phase,
              kind: deathKind(e, phase),
              killedBy: e.killerId ? champ[e.killerId] : 'tower/minions/monster',
              assistedBy: assists.map((a) => champ[a]),
              zone: zoneOf(e.position, p.teamId),
              shutdownGoldGiven: e.shutdownBounty || 0,
              goldDiffVsLaner: me && them ? me.gold - them.gold : undefined,
              levelDiffVsLaner: me && them ? me.level - them.level : undefined,
            });
          } else if (e.killerId === id || assists.includes(id)) {
            kills.push({
              time: clock(e.timestamp),
              phase,
              type: e.killerId === id ? (assists.length ? 'kill' : 'solo kill') : 'assist',
              victim: champ[e.victimId],
              zone: zoneOf(e.position, p.teamId),
            });
          }
          break;
        }
        case 'ELITE_MONSTER_KILL': {
          const mine = e.killerTeamId === p.teamId;
          objectives.push({
            time: clock(e.timestamp),
            team: mine ? 'ally' : 'enemy',
            objective: (e.monsterSubType || e.monsterType || '').toLowerCase().replace(/_/g, ' ').replace('horde', 'void grub'),
            playerInvolved: e.killerId === id || (e.assistingParticipantIds || []).includes(id),
          });
          break;
        }
        case 'BUILDING_KILL': {
          // teamId is the team that LOST the building.
          objectives.push({
            time: clock(e.timestamp),
            team: e.teamId === p.teamId ? 'enemy' : 'ally',
            objective: `${(e.laneType || '').replace('_LANE', '').toLowerCase()} ${(e.towerType || e.buildingType || '')
              .replace('_BUILDING', '').replace('_TURRET', ' turret').toLowerCase()}`.trim(),
            playerInvolved: e.killerId === id || (e.assistingParticipantIds || []).includes(id),
          });
          break;
        }
        case 'ITEM_PURCHASED':
          if (e.participantId === id) {
            const name = staticData?.items?.[e.itemId] || `item ${e.itemId}`;
            // Group buys from the same shop visit (within 20s) into one entry.
            if (lastBuy && e.timestamp - lastBuy.ts < 20000) lastBuy.entry.items.push(name);
            else {
              const entry = { time: clock(e.timestamp), items: [name] };
              purchases.push(entry);
              lastBuy = { entry };
            }
            lastBuy.ts = e.timestamp;
          }
          break;
        case 'ITEM_UNDO':
          if (e.participantId === id && lastBuy) lastBuy.entry.items.pop();
          break;
        case 'SKILL_LEVEL_UP':
          if (e.participantId === id) skillOrder.push('QWER'[e.skillSlot - 1] || '?');
          break;
        case 'WARD_PLACED':
          if (e.creatorId === id && e.wardType !== 'UNDEFINED') {
            wards.placed++;
            wards.placedByPhase[phase]++;
            if (e.wardType === 'CONTROL_WARD') wards.controlPlaced++;
          }
          break;
        case 'WARD_KILL':
          if (e.killerId === id) wards.killed++;
          break;
      }
    }
  });

  const deathsByPhase = { early: 0, mid: 0, late: 0 };
  for (const d of deaths) deathsByPhase[d.phase]++;

  return {
    matchId: match.metadata.matchId,
    champion: p.championName,
    role: roleOf(p),
    laneOpponent: opp?.championName || null,
    win: p.win,
    durationMin: round(match.info.gameDuration / 60),
    checkpoints: checkpoints(timeline, id, oppId),
    deaths,
    deathsByPhase,
    killsAndAssists: kills,
    objectives,
    shopVisits: purchases.filter((x) => x.items.length),
    skillOrder: skillOrder.join(''),
    wards,
    notes: 'Zones are approximate. Phases: early <14:00, mid 14:00-25:00, late >25:00. Diffs are player minus lane opponent.',
  };
}

// ---- habits across many games --------------------------------------------------

/** Compact per-game record used for aggregation. `timeline` is optional. */
export function gameRecord(match, puuid, timeline) {
  const p = findPlayer(match, puuid);
  const info = match.info;
  const minutes = info.gameDuration / 60;
  const totals = teamTotals(match, p.teamId);
  const rec = {
    matchId: match.metadata.matchId,
    start: info.gameCreation,
    end: info.gameEndTimestamp || info.gameCreation + info.gameDuration * 1000,
    queue: queueName(info.queueId),
    remake: isRemake(match, p),
    win: p.win,
    champion: p.championName,
    role: roleOf(p),
    minutes,
    kills: p.kills, deaths: p.deaths, assists: p.assists,
    csPerMin: cs(p) / minutes,
    goldPerMin: p.goldEarned / minutes,
    damagePerMin: p.totalDamageDealtToChampions / minutes,
    damageShare: totals.damage ? (100 * p.totalDamageDealtToChampions) / totals.damage : null,
    killParticipation: totals.kills ? (100 * (p.kills + p.assists)) / totals.kills : null,
    visionPerMin: p.visionScore / minutes,
    controlWards: p.visionWardsBoughtInGame || 0,
    timeDeadPct: (100 * (p.totalTimeSpentDead || 0)) / info.gameDuration,
    soloKills: p.challenges?.soloKills,
    surrendered: Boolean(p.gameEndedInSurrender),
  };

  if (timeline) {
    try {
      const id = participantId(timeline, puuid);
      const opp = laneOpponent(match, p);
      const oppId = opp ? participantId(timeline, opp.puuid) : null;
      const cp = Object.fromEntries(checkpoints(timeline, id, oppId, [10, 15]).map((c) => [c.minute, c]));
      rec.csAt10 = cp[10]?.cs;
      rec.csDiffAt10 = cp[10]?.csDiff;
      rec.goldDiffAt10 = cp[10]?.goldDiff;
      rec.goldDiffAt15 = cp[15]?.goldDiff;
      rec.xpDiffAt15 = cp[15]?.xpDiff;
      rec.teamGoldDiffAt15 = cp[15]?.teamGoldDiff;
      rec.deathEvents = [];
      for (const frame of timeline.info.frames) {
        for (const e of frame.events || []) {
          if (e.type === 'CHAMPION_KILL' && e.victimId === id) {
            const phase = phaseOf(e.timestamp);
            rec.deathEvents.push({
              minute: e.timestamp / 60000,
              phase,
              kind: deathKind(e, phase),
              zone: zoneOf(e.position, p.teamId),
            });
          }
        }
      }
    } catch {
      // A malformed timeline should not sink the whole aggregate.
    }
  }
  return rec;
}

function statBlock(games) {
  const wins = games.filter((g) => g.win).length;
  const k = games.reduce((a, g) => a + g.kills, 0);
  const d = games.reduce((a, g) => a + g.deaths, 0);
  const as = games.reduce((a, g) => a + g.assists, 0);
  return {
    games: games.length,
    wins,
    winRate: pct(wins, games.length),
    kda: `${round(k / games.length)}/${round(d / games.length)}/${round(as / games.length)}`,
    kdaRatio: round((k + as) / Math.max(1, d), 2),
    csPerMin: round(avg(games.map((g) => g.csPerMin))),
    goldPerMin: round(avg(games.map((g) => g.goldPerMin)), 0),
    damagePerMin: round(avg(games.map((g) => g.damagePerMin)), 0),
    damageShare: round(avg(games.map((g) => g.damageShare)), 0),
    killParticipation: round(avg(games.map((g) => g.killParticipation)), 0),
    visionPerMin: round(avg(games.map((g) => g.visionPerMin)), 2),
    controlWardsPerGame: round(avg(games.map((g) => g.controlWards))),
    timeDeadPct: round(avg(games.map((g) => g.timeDeadPct))),
    avgGameMin: round(avg(games.map((g) => g.minutes))),
  };
}

function groupBy(games, key) {
  const groups = new Map();
  for (const g of games) {
    const k = typeof key === 'function' ? key(g) : g[key];
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  }
  return groups;
}

const record = (games) => {
  const wins = games.filter((g) => g.win).length;
  return { games: games.length, wins, winRate: pct(wins, games.length) };
};

function topCounts(values, limit = 6) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([name, count]) => ({ name, count, pct: pct(count, values.length) }));
}

/** Aggregate per-game records into the patterns a coach looks for. */
export function aggregateHabits(records) {
  const remakes = records.filter((g) => g.remake).length;
  const games = records.filter((g) => !g.remake).sort((a, b) => a.start - b.start);
  if (!games.length) return { games: 0, remakesExcluded: remakes, note: 'No completed games in this sample.' };

  const out = {
    sample: {
      games: games.length,
      remakesExcluded: remakes,
      from: new Date(games[0].start).toISOString().slice(0, 10),
      to: new Date(games[games.length - 1].start).toISOString().slice(0, 10),
      queues: Object.fromEntries([...groupBy(games, 'queue')].map(([q, gs]) => [q, gs.length])),
    },
    overall: statBlock(games),
    inWins: statBlock(games.filter((g) => g.win)),
    inLosses: statBlock(games.filter((g) => !g.win)),
  };
  if (!out.inWins.games) delete out.inWins;
  if (!out.inLosses.games) delete out.inLosses;

  out.byChampion = [...groupBy(games, 'champion')]
    .map(([champion, gs]) => ({ champion, ...statBlock(gs) }))
    .sort((a, b) => b.games - a.games)
    .slice(0, 10);
  out.byRole = [...groupBy(games, 'role')]
    .map(([role, gs]) => ({ role, ...statBlock(gs) }))
    .sort((a, b) => b.games - a.games);
  out.championPool = {
    uniqueChampions: groupBy(games, 'champion').size,
    top3ShareOfGames: pct(out.byChampion.slice(0, 3).reduce((a, c) => a + c.games, 0), games.length),
  };

  const bucket = (g) => (g.minutes < 25 ? 'under 25 min' : g.minutes < 35 ? '25-35 min' : 'over 35 min');
  out.byGameLength = Object.fromEntries([...groupBy(games, bucket)].map(([b, gs]) => [b, record(gs)]));

  // Sessions and tilt: a "session" is a run of games with under 45 minutes between them.
  const sessions = [];
  for (const g of games) {
    const last = sessions[sessions.length - 1];
    if (last && g.start - last[last.length - 1].end < 45 * 60000) last.push(g);
    else sessions.push([g]);
  }
  const afterWin = [], afterLoss = [], afterTwoLosses = [], byPosition = new Map();
  for (const s of sessions) {
    s.forEach((g, i) => {
      const slot = i >= 3 ? '4th+ game' : ['1st game', '2nd game', '3rd game'][i];
      if (!byPosition.has(slot)) byPosition.set(slot, []);
      byPosition.get(slot).push(g);
      if (i === 0) return;
      (s[i - 1].win ? afterWin : afterLoss).push(g);
      if (i >= 2 && !s[i - 1].win && !s[i - 2].win) afterTwoLosses.push(g);
    });
  }
  out.sessions = {
    count: sessions.length,
    avgGamesPerSession: round(games.length / sessions.length),
    longestSession: Math.max(...sessions.map((s) => s.length)),
    winRateBySessionGame: Object.fromEntries([...byPosition].map(([k, gs]) => [k, record(gs)])),
    nextGameAfterWin: record(afterWin),
    nextGameAfterLoss: record(afterLoss),
    nextGameAfterTwoLosses: record(afterTwoLosses),
  };

  let streak = 0;
  for (let i = games.length - 1; i >= 0 && games[i].win === games[games.length - 1].win; i--) streak++;
  out.recentForm = {
    last10: games.slice(-10).map((g) => (g.win ? 'W' : 'L')).join(''),
    currentStreak: `${streak}${games[games.length - 1].win ? 'W' : 'L'}`,
  };

  const timed = games.filter((g) => g.deathEvents);
  if (timed.length) {
    const laned = timed.filter((g) => Number.isFinite(g.goldDiffAt15));
    const ahead = laned.filter((g) => g.goldDiffAt15 >= 500);
    const behind = laned.filter((g) => g.goldDiffAt15 <= -500);
    const even = laned.filter((g) => Math.abs(g.goldDiffAt15) < 500);
    out.laning = {
      gamesWithLaneOpponent: laned.length,
      avgCsAt10: round(avg(timed.map((g) => g.csAt10))),
      avgCsDiffAt10: round(avg(laned.map((g) => g.csDiffAt10))),
      avgGoldDiffAt10: round(avg(laned.map((g) => g.goldDiffAt10)), 0),
      avgGoldDiffAt15: round(avg(laned.map((g) => g.goldDiffAt15)), 0),
      avgXpDiffAt15: round(avg(laned.map((g) => g.xpDiffAt15)), 0),
      aheadAt15: { ...record(ahead), meaning: 'gold lead of 500+ over lane opponent at 15:00' },
      evenAt15: record(even),
      behindAt15: { ...record(behind), meaning: 'gold deficit of 500+ at 15:00' },
    };

    const allDeaths = timed.flatMap((g) => g.deathEvents);
    const firstDeaths = timed.map((g) => g.deathEvents[0]?.minute).filter(Number.isFinite);
    const earlyDeaths = (g) => g.deathEvents.filter((d) => d.phase === 'early').length;
    const cleanEarly = timed.filter((g) => earlyDeaths(g) <= 1);
    const roughEarly = timed.filter((g) => earlyDeaths(g) >= 3);
    out.deaths = {
      gamesAnalyzed: timed.length,
      perGame: round(allDeaths.length / timed.length),
      perGameByPhase: {
        early: round(allDeaths.filter((d) => d.phase === 'early').length / timed.length),
        mid: round(allDeaths.filter((d) => d.phase === 'mid').length / timed.length),
        late: round(allDeaths.filter((d) => d.phase === 'late').length / timed.length),
      },
      avgFirstDeathMinute: round(avg(firstDeaths)),
      diedBefore5MinPct: pct(firstDeaths.filter((m) => m < 5).length, timed.length),
      byKind: topCounts(allDeaths.map((d) => d.kind)),
      byZone: topCounts(allDeaths.map((d) => d.zone)),
      earlyDeathsByKind: topCounts(allDeaths.filter((d) => d.phase === 'early').map((d) => d.kind)),
      winRateWith0or1EarlyDeaths: record(cleanEarly),
      winRateWith3PlusEarlyDeaths: record(roughEarly),
    };
  }

  out.caveats = [
    `Sample is ${games.length} games; treat splits with fewer than ~8 games as hints, not conclusions.`,
    'Zones and death kinds are heuristics from event positions and assist counts.',
  ];
  return out;
}
