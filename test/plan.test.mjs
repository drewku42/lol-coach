import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gameRecord } from '../server/analysis.mjs';
import { opggChampion, summarizeMatchup } from '../server/opgg.mjs';
import {
  addFocus, goalProgress, loadPlan, planStatus, rankValue, scorecard, setFocusStatus, setGoal, suggestFocuses,
} from '../server/plan.mjs';
import { reviewData } from '../server/review.mjs';
import { RiotClient } from '../server/riot.mjs';
import { createApp } from '../app/server.mjs';
import { ME, fakeFetch, makeMatch, makeTimeline } from './fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lol-coach-plan-'));
const usePlanFile = () => { process.env.LOL_COACH_PLAN = path.join(tmp(), 'plan.json'); };
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 1);

// Timeline fixture has 2 early deaths and 1 mid death per game.
const records = (n, { win = () => true, start = (i) => T0 + i * DAY } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const m = makeMatch({ id: `NA1_${i + 1}`, win: win(i), start: start(i) });
    return gameRecord(m, ME, makeTimeline(m));
  });

test('rank maths', () => {
  assert.equal(rankValue('IRON', 'IV', 0), 0);
  assert.equal(rankValue('SILVER', 'IV', 77), 877);
  assert.equal(rankValue('GOLD', 'IV'), 1200);
  assert.equal(rankValue('MASTER', undefined, 50), 2850);
  assert.throws(() => rankValue('WOOD', 'IV'));

  const goal = { queue: 'ranked_solo', tier: 'GOLD', division: 'IV', start: { tier: 'SILVER', division: 'IV', lp: 77 } };
  const p = goalProgress(goal, { tier: 'SILVER', division: 'II', lp: 20 }, { games: 20, wins: 12 });
  assert.equal(p.lpToGo, 180);
  assert.equal(p.divisionsToGo, 2);
  assert.equal(p.lpGainedSinceSet, 143);
  assert.equal(p.percent, 44);
  assert.equal(p.estimatedGames, 41); // 180 / (22 * 0.2)
  assert.equal(goalProgress(goal, { tier: 'GOLD', division: 'IV', lp: 5 }).status, 'reached');
  assert.equal(goalProgress(goal, null).status, 'unranked');
  assert.equal(goalProgress(goal, { tier: 'SILVER', division: 'IV', lp: 77 }, { games: 20, wins: 9 }).estimatedGames, null);
});

test('goal and focus storage', () => {
  usePlanFile();
  const id = 'Tester#NA1';
  assert.throws(() => setGoal(id, { tier: 'SILVER', division: 'IV' }, { tier: 'GOLD', division: 'IV', lp: 0 }), /already/);
  setGoal(id, { tier: 'gold' }, { tier: 'SILVER', division: 'IV', lp: 77 });
  assert.equal(loadPlan('tester#na1').goal.tier, 'GOLD'); // case-insensitive player key

  const base = { title: 'T', rule: 'R', threshold: 1 };
  const f = addFocus(id, { ...base, metric: 'early_deaths' }, T0);
  assert.equal(f.op, '<=');
  assert.equal(f.targetHits, 8);
  assert.throws(() => addFocus(id, { ...base, metric: 'early_deaths' }), /already an active focus/);
  assert.throws(() => addFocus(id, { ...base, metric: 'nope' }), /Unknown metric/);
  addFocus(id, { ...base, metric: 'control_wards' });
  addFocus(id, { ...base, metric: 'cs_at_10', threshold: 70 });
  assert.throws(() => addFocus(id, { ...base, metric: 'deaths' }), /already 3 active/);
  setFocusStatus(id, f.id, 'achieved');
  assert.equal(addFocus(id, { ...base, metric: 'deaths' }).status, 'active');
  assert.throws(() => setFocusStatus(id, f.id, 'active'), /already 3 active/);
});

test('scorecard splits games at the moment the focus was set', () => {
  const recs = records(14);
  const focus = { metric: 'early_deaths', op: '<=', threshold: 2, targetHits: 8, targetWindow: 10, createdAt: T0 + 3.5 * DAY };
  const card = scorecard(focus, recs);
  assert.equal(card.before.games, 4);
  assert.equal(card.since.games, 10);
  assert.equal(card.since.hits, 10);
  assert.equal(card.achieved, true);
  const strict = scorecard({ ...focus, threshold: 1 }, recs);
  assert.equal(strict.since.hits, 0);
  assert.equal(strict.achieved, false);
  assert.equal(scorecard({ ...focus, role: 'top' }, recs).since.games, 0); // filter
  assert.equal(scorecard({ ...focus, createdAt: T0 + 100 * DAY }, recs).gamesLeftInWindow, 10);
});

test('suggestions and plan status', () => {
  usePlanFile();
  const recs = records(12);
  const sugg = suggestFocuses(recs);
  const wards = sugg.find((s) => s.metric === 'control_wards');
  assert.equal(wards, undefined); // fixture buys 2 per game, mid needs 1
  assert.ok(sugg.every((s) => s.title && s.rule && s.finding && Number.isFinite(s.threshold)));
  assert.deepEqual(suggestFocuses(records(3)), []);

  setGoal('Tester#NA1', { tier: 'GOLD' }, { tier: 'SILVER', division: 'IV', lp: 77 });
  addFocus('Tester#NA1', { title: 'T', rule: 'R', metric: 'deaths', threshold: 3 }, T0 + 1.5 * DAY);
  const status = planStatus('Tester#NA1', { ranks: { ranked_solo: { tier: 'SILVER', division: 'III', lp: 10 } }, records: recs });
  assert.equal(status.goal.lpToGo, 290);
  assert.equal(status.goal.recentWinRate, 100);
  assert.equal(status.activeFocuses[0].scorecard.since.games, 10);
  assert.equal(status.openSlots, 2);
  assert.ok(!status.suggestions.some((s) => s.metric === 'deaths'));
});

test('review data: series and key moments', () => {
  const match = makeMatch();
  const r = reviewData(match, makeTimeline(match), ME, { version: '16.23.1' });
  assert.equal(r.series.length, 21);
  assert.equal(r.series[10].goldDiff, 500);
  assert.equal(r.series[10].csDiff, 10);
  assert.equal(r.timeline.deaths[0].x, 8600);
  assert.equal(r.timeline.deaths[0].minute, 6.5);
  const repeat = r.keyMoments.find((k) => k.type === 'repeat-death');
  assert.match(repeat.title, /Second death to Zed in 2:40/);
  assert.ok(r.keyMoments.every((k, i, a) => i === 0 || a[i - 1].minute <= k.minute), 'in time order');
  assert.ok(!('score' in r.keyMoments[0]));
});

test('OP.GG helpers', () => {
  assert.equal(opggChampion('Miss Fortune'), 'MISS_FORTUNE');
  assert.equal(opggChampion("Kha'Zix"), 'KHAZIX');
  assert.equal(opggChampion('Nunu & Willump'), 'NUNU_WILLUMP');
  assert.equal(opggChampion('Dr. Mundo'), 'DR_MUNDO');
  const m = summarizeMatchup({
    my_champion: 'Diana', opponent_champion: 'Yasuo', position: 'mid',
    data: {
      counters: [{ champion_name: 'Yasuo', play: 1000, win: 466 }],
      lane_advantage_champion: 'Diana',
      core_items: [{ ids_names: ['A', 'B', 'C'], play: 200, win: 97, pick_rate: 0.23 }],
      rune_pages: [{ builds: [{ primary_page_name: 'Domination', primary_rune_names: ['Electrocute', 'X'], secondary_page_name: 'Resolve', secondary_rune_names: ['Y'], play: 10, win: 5 }] }],
      skills: [{ order: ['Q', 'W', 'E'] }],
      summoner_spells: [{ ids_names: ['Flash', 'Ignite'] }],
    },
  }, 'Yasuo');
  assert.deepEqual(m.headToHead, { games: 1000, winRate: 46.6 });
  assert.equal(m.runes.keystone, 'Electrocute');
  assert.equal(m.skillOrder, 'QWE');
  assert.equal(m.coreBuilds[0].winRate, 48.5);
});

test('web app API', async () => {
  usePlanFile();
  const matches = Array.from({ length: 10 }, (_, i) => makeMatch({ id: `NA1_${i + 1}`, win: i % 2 === 0, start: T0 + i * DAY }));
  const client = new RiotClient({
    fetchImpl: fakeFetch(matches), cache: tmp(),
    getConfig: () => ({ apiKey: 'RGAPI-test', riotId: 'Tester#NA1', platform: 'na1' }),
  });
  const opgg = { matchup: async () => { throw new Error('offline'); } };
  const server = http.createServer(createApp({ client, opgg })).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json() }; };
  const post = (p, body) => json(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const o = await json('/api/overview');
    assert.equal(o.status, 200);
    assert.equal(o.body.games.length, 10);
    assert.equal(o.body.games[0].matchId, 'NA1_10'); // newest first
    assert.equal(o.body.ranks.ranked_solo.tier, 'GOLD');

    assert.equal((await post('/api/goal', { tier: 'PLATINUM', division: 'IV' })).status, 200);
    assert.equal((await post('/api/goal', { tier: 'SILVER' })).status, 400); // below current rank
    const f = await post('/api/focus', { title: 'T', rule: 'R', metric: 'deaths', threshold: 3 });
    assert.equal(f.status, 200);
    const plan = (await json('/api/overview')).body.plan;
    assert.equal(plan.goal.target, 'Platinum IV');
    assert.equal(plan.activeFocuses.length, 1);
    assert.equal((await post('/api/focus/status', { id: f.body.id, status: 'dropped' })).body.status, 'dropped');

    const r = await json('/api/review?id=NA1_1');
    assert.equal(r.body.series.length, 21);
    assert.equal((await json('/api/review?id=../etc')).status, 400);
    assert.equal((await json('/api/matchup?id=NA1_1')).body.available, false); // OP.GG offline is not an error

    const st = (await json('/api/static')).body;
    assert.equal(st.version, '16.23.1');
    assert.equal(st.icons.champion['Lee Sin'], 'LeeSin');
    assert.equal(st.icons.item["Rabadon's Deathcap"], '3089');
    assert.equal(st.icons.spell.Flash, 'SummonerFlash');
    assert.match(st.icons.rune.Electrocute, /Electrocute\.png$/);
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/../server.mjs')).status, 404);
    // fetch will not send a forged Host header, so use a raw request for the rebinding check.
    const forged = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/overview', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(forged, 403);
    assert.equal((await json('/api/goal', { method: 'POST', body: 'tier=GOLD' })).status, 415);
  } finally {
    server.close();
    delete process.env.LOL_COACH_PLAN;
  }
});
