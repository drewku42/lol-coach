import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateHabits, analyzeTimeline, gameRecord, matchDetail, queueId, summarizeMatch, zoneOf } from '../server/analysis.mjs';
import { normalizePlatform, parseRiotId } from '../server/config.mjs';
import { RiotClient, regionOfMatch } from '../server/riot.mjs';
import { createServer } from '../server/index.mjs';
import { ME, fakeFetch, makeMatch, makeTimeline } from './fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lol-coach-'));
const cfg = (over = {}) => () => ({ apiKey: 'RGAPI-test', riotId: 'Tester#NA1', platform: 'na1', ...over });

test('config helpers', () => {
  assert.deepEqual(parseRiotId('Hide on bush#KR1'), { gameName: 'Hide on bush', tagLine: 'KR1' });
  assert.throws(() => parseRiotId('NoTag'));
  assert.equal(normalizePlatform('EUW'), 'euw1');
  assert.throws(() => normalizePlatform('mars'));
  assert.equal(regionOfMatch('KR_123'), 'asia');
  assert.equal(regionOfMatch('OC1_123'), 'sea');
  assert.equal(queueId('ranked_solo'), 420);
  assert.equal(queueId('all'), undefined);
  assert.throws(() => queueId('bogus'));
});

test('summarizeMatch and matchDetail', () => {
  const match = makeMatch();
  const s = summarizeMatch(match, ME, { items: { 3089: "Rabadon's Deathcap" } });
  assert.equal(s.champion, 'Ahri');
  assert.equal(s.role, 'mid');
  assert.equal(s.vs, 'Zed');
  assert.equal(s.kda, '5/3/7');
  assert.equal(s.csPerMin, 6.7);
  assert.equal(s.killParticipation, 92); // (5+7) / (5 + 4*2)
  assert.ok(s.items.includes("Rabadon's Deathcap"));
  const d = matchDetail(match, ME, {});
  assert.equal(d.laneOpponent.champion, 'Zed');
  assert.equal(d.teams.length, 2);
  assert.equal(d.teams.find((t) => t.isPlayersTeam).side, 'blue');
  assert.equal(d.patch, '16.23');
});

test('zoneOf is relative to the player\'s team', () => {
  assert.equal(zoneOf({ x: 8600, y: 8500 }, 100), 'enemy mid lane');
  assert.equal(zoneOf({ x: 8600, y: 8500 }, 200), 'own mid lane');
  assert.equal(zoneOf({ x: 1000, y: 1000 }, 100), 'own base');
  assert.equal(zoneOf({ x: 10500, y: 7000 }, 100), 'enemy bot jungle');
});

test('analyzeTimeline', () => {
  const match = makeMatch();
  const t = analyzeTimeline(match, makeTimeline(match), ME, { items: { 1056: "Doran's Ring" } });
  assert.equal(t.deaths.length, 3);
  assert.deepEqual(t.deathsByPhase, { early: 2, mid: 1, late: 0 });
  assert.equal(t.deaths[0].time, '6:30');
  assert.equal(t.deaths[0].kind, 'ganked or 2v1');
  assert.equal(t.deaths[0].killedBy, 'Zed');
  assert.deepEqual(t.deaths[0].assistedBy, ['Viego']);
  assert.equal(t.deaths[0].zone, 'enemy mid lane');
  assert.equal(t.deaths[1].kind, 'solo-killed');
  assert.equal(t.deaths[2].shutdownGoldGiven, 300);
  const at10 = t.checkpoints.find((c) => c.minute === 10);
  assert.equal(at10.csDiff, 10);
  assert.equal(at10.goldDiff, 500);
  assert.equal(at10.teamGoldDiff, 500);
  assert.equal(t.killsAndAssists[0].type, 'solo kill');
  assert.equal(t.shopVisits[0].items.length, 2); // grouped into one visit
  assert.equal(t.shopVisits[0].items[0], "Doran's Ring");
  assert.equal(t.skillOrder, 'QE');
  assert.equal(t.wards.placed, 2);
  assert.equal(t.wards.controlPlaced, 1);
  const dragon = t.objectives.find((o) => o.objective === 'fire dragon');
  assert.equal(dragon.team, 'ally');
  assert.equal(dragon.playerInvolved, true);
  const tower = t.objectives.find((o) => o.objective.includes('turret'));
  assert.equal(tower.team, 'enemy'); // we lost it
});

test('aggregateHabits: splits, sessions and tilt', () => {
  const hour = 3600000;
  const base = Date.UTC(2026, 10, 20, 18);
  // One session of four games: W L L L, then a separate game next day (W), plus a remake.
  const specs = [
    { id: 'NA1_1', win: true, start: base },
    { id: 'NA1_2', win: false, start: base + 0.6 * hour, deaths: 8 },
    { id: 'NA1_3', win: false, start: base + 1.2 * hour, deaths: 9, champion: 'Syndra' },
    { id: 'NA1_4', win: false, start: base + 1.8 * hour, deaths: 7 },
    { id: 'NA1_5', win: true, start: base + 24 * hour },
    { id: 'NA1_6', win: false, start: base + 30 * hour, remake: true, duration: 200 },
  ];
  const records = specs.map((s) => {
    const m = makeMatch(s);
    return gameRecord(m, ME, makeTimeline(m, { goldLeadPerMin: s.win ? 50 : -50 }));
  });
  const h = aggregateHabits(records);
  assert.equal(h.sample.games, 5);
  assert.equal(h.sample.remakesExcluded, 1);
  assert.equal(h.overall.winRate, 40);
  assert.equal(h.sessions.count, 2);
  assert.equal(h.sessions.longestSession, 4);
  assert.deepEqual(h.sessions.nextGameAfterLoss, { games: 2, wins: 0, winRate: 0 });
  assert.equal(h.sessions.nextGameAfterTwoLosses.games, 1);
  assert.equal(h.recentForm.last10, 'WLLLW');
  assert.equal(h.recentForm.currentStreak, '1W');
  assert.equal(h.byChampion[0].champion, 'Ahri');
  assert.equal(h.byChampion[0].games, 4);
  assert.equal(h.championPool.uniqueChampions, 2);
  assert.equal(h.laning.aheadAt15.winRate, 100);
  assert.equal(h.laning.behindAt15.winRate, 0);
  assert.equal(h.laning.avgCsAt10, 80);
  assert.equal(h.deaths.perGame, 3);
  assert.equal(h.deaths.perGameByPhase.early, 2);
  assert.equal(h.deaths.byZone[0].name, 'enemy mid lane');
  assert.ok(h.inLosses.kdaRatio < h.inWins.kdaRatio);
  assert.equal(aggregateHabits([]).games, 0);
});

test('RiotClient: routing, auth header, caching, missing key', async () => {
  const log = [];
  const matches = [makeMatch({ id: 'NA1_1' })];
  const dir = tmp();
  const client = new RiotClient({ fetchImpl: fakeFetch(matches, { log }), cache: dir, getConfig: cfg() });
  const p = await client.resolvePlayer();
  assert.equal(p.riotId, 'Tester#NA1');
  assert.equal(p.region, 'americas');
  assert.equal(log[0].host, 'americas.api.riotgames.com');
  assert.equal(log[0].key, 'RGAPI-test');
  await client.summoner(p);
  assert.equal(log.at(-1).host, 'na1.api.riotgames.com');

  await client.match('NA1_1');
  const calls = log.length;
  await client.match('NA1_1');
  assert.equal(log.length, calls, 'second read comes from disk cache');
  assert.ok(fs.existsSync(path.join(dir, 'matches', 'NA1_1.json.gz')));
  assert.deepEqual([...client.limiters.keys()].sort(), ['americas', 'na1'], 'one rate budget per routing value');
  assert.equal(client.limiterFor('na1').stamps.length, 1);

  const noKey = new RiotClient({ fetchImpl: fakeFetch(matches), cache: tmp(), getConfig: cfg({ apiKey: '' }) });
  await assert.rejects(() => noKey.resolvePlayer(), /No Riot API key/);
});

test('RiotClient: expired key and 429 retry', async () => {
  const res = (status, body = {}, headers = {}) => ({ ok: status < 400, status, headers: new Map(Object.entries(headers)), json: async () => body });
  const expired = new RiotClient({ fetchImpl: async () => res(403), cache: tmp(), getConfig: cfg() });
  await assert.rejects(() => expired.resolvePlayer(), /expire every 24 hours/);

  let n = 0;
  const flaky = new RiotClient({
    fetchImpl: async () => (n++ === 0 ? res(429, {}, { 'retry-after': '0.01' }) : res(200, { id: 'NA1' })),
    cache: tmp(), getConfig: cfg(),
  });
  assert.deepEqual(await flaky.request('na1', '/lol/status/v4/platform-data'), { id: 'NA1' });
  assert.equal(n, 2);
});

test('MCP server end to end', async () => {
  const base = Date.UTC(2026, 10, 20, 18);
  const matches = Array.from({ length: 6 }, (_, i) =>
    makeMatch({ id: `NA1_${i + 1}`, win: i % 2 === 0, start: base - i * 86400000 }));
  const client = new RiotClient({ fetchImpl: fakeFetch(matches), cache: tmp(), getConfig: cfg() });
  const handle = createServer(client);
  const call = async (name, args = {}) => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.ok(!res.result.isError, res.result.content[0].text);
    return JSON.parse(res.result.content[0].text);
  };

  const init = await handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 7);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

  const profile = await call('get_player_profile');
  assert.equal(profile.ranked[0].rank, 'GOLD II');
  assert.equal(profile.topMasteries[0].champion, 'Ahri');

  const history = await call('get_match_history', { count: 3, queue: 'ranked_solo' });
  assert.equal(history.matches.length, 6); // fake returns all ids
  assert.equal(history.matches[0].items[0], "Rabadon's Deathcap");

  assert.equal((await call('get_match_detail', { match_id: 'NA1_1' })).laneOpponent.champion, 'Zed');
  assert.equal((await call('get_match_timeline', { match_id: 'NA1_1' })).deaths.length, 3);

  const habits = await call('analyze_habits', { count: 10 });
  assert.equal(habits.sample.games, 6);
  assert.equal(habits.overall.winRate, 50);
  assert.ok(habits.deaths && habits.laning);
  assert.equal((await call('analyze_habits', { champion: 'ahri', role: 'mid' })).sample.games, 6);
  assert.equal((await call('analyze_habits', { champion: 'Garen' })).games, 0);

  assert.equal((await call('get_live_game')).inGame, false);
  const status = await call('get_setup_status');
  assert.equal(typeof status.apiKeyConfigured, 'boolean');
  assert.ok(!JSON.stringify(status).includes('RGAPI'));

  const bad = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_match_detail', arguments: { match_id: 'NA1_999' } } });
  assert.equal(bad.result.isError, true);
});
