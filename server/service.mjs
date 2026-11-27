// Shared data services used by both the MCP tools and the web app.
import { gameRecord, queueId } from './analysis.mjs';
import { planStatus } from './plan.mjs';
import { reviewData } from './review.mjs';

// Run tasks with limited concurrency, stopping early once the deadline passes.
export async function pooled(items, limit, deadline, fn) {
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
export async function getMatch(client, id, region) {
  const [match, staticData] = await Promise.all([client.match(id, region), client.staticData()]);
  const names = staticData.championNames || {};
  for (const p of match.info.participants) p.championName = names[p.championName] || p.championName;
  return match;
}

/** Per-game records (with timelines where the mode has lanes) for the player's recent games. */
export async function loadRecords(client, p, { count = 30, queue, timelines = true, budgetMs = 85000 } = {}) {
  const ids = await client.matchIds(p, { count, queue: queueId(queue) });
  const deadline = Date.now() + budgetMs;
  const records = (await pooled(ids, 4, deadline, async (id) => {
    const match = await getMatch(client, id, p.region);
    const timeline = timelines && match.info.gameMode === 'CLASSIC'
      ? await client.timeline(id, p.region).catch(() => null)
      : null;
    return gameRecord(match, p.puuid, timeline);
  })).filter(Boolean);
  return { records, requested: ids.length, partial: records.length < ids.length };
}

/** Current rank per ranked queue as {tier, division, lp, wins, losses}. */
export async function loadRanks(client, p) {
  const names = { RANKED_SOLO_5x5: 'ranked_solo', RANKED_FLEX_SR: 'ranked_flex' };
  const ranks = {};
  for (const l of await client.leagueEntries(p)) {
    if (!names[l.queueType]) continue;
    ranks[names[l.queueType]] = { tier: l.tier, division: l.rank, lp: l.leaguePoints, wins: l.wins, losses: l.losses };
  }
  return ranks;
}

/** Goal progress and focus scorecards with live numbers. */
export async function getPlan(client, p, { count = 30 } = {}) {
  const [ranks, loaded] = await Promise.all([loadRanks(client, p), loadRecords(client, p, { count })]);
  const status = planStatus(p.riotId, { ranks, records: loaded.records });
  if (loaded.partial) status.partial = `Only ${loaded.records.length} of ${loaded.requested} recent games were loaded this time; call again for the rest.`;
  return { status, ranks, records: loaded.records };
}

export async function getReview(client, p, matchId) {
  const [match, timeline, staticData] = await Promise.all([
    getMatch(client, matchId), client.timeline(matchId), client.staticData(),
  ]);
  return reviewData(match, timeline, p.puuid, staticData);
}
