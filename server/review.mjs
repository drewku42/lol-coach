// Data for the visual game review: per-minute series, map positions and key moments.
import {
  analyzeTimeline, clock, findPlayer, frameStats, laneOpponent, matchDetail, participantId, round,
} from './analysis.mjs';

const teamOf = (pid) => (pid <= 5 ? 100 : 200);

/** Per-minute numbers for the player, their lane opponent and both teams. */
export function minuteSeries(match, timeline, puuid) {
  const p = findPlayer(match, puuid);
  const id = participantId(timeline, puuid);
  const opp = laneOpponent(match, p);
  const oppId = opp ? participantId(timeline, opp.puuid) : null;
  return timeline.info.frames.map((frame, minute) => {
    const me = frameStats(frame, id);
    const them = oppId ? frameStats(frame, oppId) : null;
    let teamGoldDiff = 0;
    for (const [pid, f] of Object.entries(frame.participantFrames)) {
      teamGoldDiff += (teamOf(Number(pid)) === teamOf(id) ? 1 : -1) * f.totalGold;
    }
    const pos = frame.participantFrames[String(id)]?.position;
    return {
      minute,
      gold: me.gold, cs: me.cs, level: me.level,
      goldDiff: them ? me.gold - them.gold : null,
      csDiff: them ? me.cs - them.cs : null,
      xpDiff: them ? me.xp - them.xp : null,
      teamGoldDiff,
      x: pos?.x, y: pos?.y,
    };
  });
}

// ["void grub", "void grub", "dragon"] -> "2 void grubs and dragon"
function countNames(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${c} ${n}s` : n)).join(' and ');
}

/** The handful of moments worth opening the replay for, in time order. */
export function keyMoments(tl, series, { limit = 6 } = {}) {
  const moments = [];
  const add = (m) => moments.push(m);

  // 1. Deaths that cost something: a repeat death to the same champion, or an enemy
  //    objective within 75 seconds. One moment per death, combining both when they apply.
  tl.deaths.forEach((d, i) => {
    const prev = tl.deaths[i - 1];
    const repeat = prev && prev.killedBy === d.killedBy && d.minute - prev.minute <= 3 ? prev : null;
    const lost = tl.objectives.filter((o) => o.team === 'enemy' && o.minute >= d.minute && o.minute - d.minute <= 1.25);
    if (!repeat && !lost.length) return;
    const lostText = countNames(lost.map((o) => o.objective));
    const who = `${d.killedBy}${d.assistedBy.length ? ` with ${d.assistedBy.join(', ')}` : ''}`;
    add({
      minute: d.minute, time: d.time, type: repeat ? 'repeat-death' : 'death-then-objective',
      title: repeat
        ? `Second death to ${d.killedBy} in ${clock((d.minute - repeat.minute) * 60000)}${lost.length ? `, then the enemy took ${lostText}` : ''}`
        : `Death, then the enemy took ${lostText}`,
      detail: `Killed by ${who} in ${d.zone}.` +
        (repeat ? ` You had also died to ${d.killedBy} at ${repeat.time}; the second fight was taken from behind.` : '') +
        (lost.length ? ` ${lost[0].objective} fell at ${lost[0].time}.` : ''),
      score: (repeat ? 5 : 0) + (lost.length ? 3 + lost.length : 0),
    });
  });

  // 3. Shutdown gold handed over.
  for (const d of tl.deaths) {
    if (d.shutdownGoldGiven >= 300) {
      add({
        minute: d.minute, time: d.time, type: 'shutdown',
        title: `Gave a ${d.shutdownGoldGiven} gold shutdown to ${d.killedBy}`,
        detail: `In ${d.zone}. Dying with a bounty hands the lead back.`,
        score: 2 + d.shutdownGoldGiven / 300,
      });
    }
  }

  // 4. Largest two-minute swings in team gold.
  const swings = [];
  for (let m = 2; m < series.length; m++) {
    swings.push({ from: m - 2, to: m, delta: series[m].teamGoldDiff - series[m - 2].teamGoldDiff });
  }
  swings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const used = [];
  for (const s of swings) {
    if (Math.abs(s.delta) < 1500 || used.length >= 3) break;
    if (used.some((u) => Math.abs(u.to - s.to) < 3)) continue;
    used.push(s);
    const inWindow = (e) => e.minute >= s.from && e.minute <= s.to;
    const deaths = tl.deaths.filter(inWindow).length;
    const takedowns = tl.killsAndAssists.filter(inWindow).length;
    const objs = tl.objectives.filter(inWindow);
    const parts = [];
    if (takedowns) parts.push(`you had ${takedowns} takedown${takedowns > 1 ? 's' : ''}`);
    if (deaths) parts.push(`you died ${deaths === 1 ? 'once' : `${deaths} times`}`);
    for (const team of ['ally', 'enemy']) {
      const names = objs.filter((o) => o.team === team).map((o) => o.objective);
      if (names.length) parts.push(`${team === 'ally' ? 'your team' : 'the enemy'} took ${countNames(names)}`);
    }
    add({
      minute: s.to, time: `${s.from}:00-${s.to}:00`, type: s.delta > 0 ? 'swing-for' : 'swing-against',
      title: `Team gold swung ${s.delta > 0 ? '+' : ''}${Math.round(s.delta)} in two minutes`,
      detail: parts.length ? `In that window: ${parts.join('; ')}.` : 'No direct involvement from you in that window.',
      score: Math.abs(s.delta) / 800,
    });
  }

  // 5. A strong play of the player's own: multiple takedowns within 30 seconds.
  const ka = tl.killsAndAssists;
  for (let i = 0; i < ka.length; i++) {
    const burst = ka.filter((k) => k.minute >= ka[i].minute && k.minute - ka[i].minute <= 0.5);
    const kills = burst.filter((k) => k.type !== 'assist').length;
    if (kills >= 2) {
      add({
        minute: ka[i].minute, time: ka[i].time, type: 'good-play',
        title: `${kills} kills in ${ka[i].zone}`,
        detail: `Killed ${burst.filter((k) => k.type !== 'assist').map((k) => k.victim).join(' and ')}.`,
        score: 1.5 + kills,
      });
      i += burst.length - 1;
    }
  }

  return moments
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.minute - b.minute)
    .map(({ score, ...m }) => ({ ...m, minute: round(m.minute, 2) }));
}

export function reviewData(match, timeline, puuid, staticData) {
  const detail = matchDetail(match, puuid, staticData);
  const tl = analyzeTimeline(match, timeline, puuid, staticData);
  const series = minuteSeries(match, timeline, puuid);
  return {
    detail,
    timeline: tl,
    series,
    keyMoments: keyMoments(tl, series),
    mapSize: 14800,
    ddragonVersion: staticData?.version || null,
  };
}
