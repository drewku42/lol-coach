#!/usr/bin/env node
// Local web app for lol-coach: dashboard, plan and visual game review.
// Serves only on localhost. Start with `npm run app`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateHabits, laneOpponent, findPlayer } from '../server/analysis.mjs';
import { loadConfig } from '../server/config.mjs';
import { OpggClient } from '../server/opgg.mjs';
import { TIERS, addFocus, clearGoal, setFocusStatus, setGoal } from '../server/plan.mjs';
import { RiotClient } from '../server/riot.mjs';
import { getMatch, getPlan, getReview, loadRanks } from '../server/service.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const count = (g, pred) => (g.deathEvents ? g.deathEvents.filter(pred).length : null);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

// One row per game for the match list and trend charts.
const gameRow = (g) => ({
  matchId: g.matchId, start: g.start, queue: g.queue, remake: g.remake, win: g.win,
  champion: g.champion, role: g.role, vs: g.vs, kda: g.kda, minutes: round(g.minutes),
  deaths: g.deaths, earlyDeaths: count(g, (d) => d.phase === 'early'),
  csPerMin: round(g.csPerMin), csAt10: g.csAt10 ?? null, goldDiffAt15: g.goldDiffAt15 ?? null,
  visionPerMin: round(g.visionPerMin, 2), controlWards: g.controlWards, killParticipation: round(g.killParticipation, 0),
});

export function createApp({ client = new RiotClient(), opgg = new OpggClient() } = {}) {
  const player = () => client.resolvePlayer();

  const routes = {
    'GET /api/overview': async () => {
      const p = await player();
      const { status, ranks, records } = await getPlan(client, p, { count: 30 });
      const games = records.slice().sort((a, b) => b.start - a.start);
      return {
        riotId: p.riotId, platform: p.platform, ranks, plan: status, tiers: TIERS,
        habits: aggregateHabits(records),
        games: games.map(gameRow),
      };
    },
    // Image keys for champions, items, runes and spells (served by Riot's Data Dragon CDN).
    'GET /api/static': async () => {
      const s = await client.staticData();
      return { version: s.version, icons: s.icons || { champion: {}, item: {}, rune: {}, spell: {} } };
    },
    'GET /api/review': async (q) => {
      if (!/^[A-Z0-9]+_\d+$/.test(q.id || '')) throw httpError(400, 'Bad match id.');
      return getReview(client, await player(), q.id);
    },
    'GET /api/matchup': async (q) => {
      if (!/^[A-Z0-9]+_\d+$/.test(q.id || '')) throw httpError(400, 'Bad match id.');
      const p = await player();
      const match = await getMatch(client, q.id);
      const me = findPlayer(match, p.puuid);
      const opp = laneOpponent(match, me);
      const position = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support' }[me.teamPosition];
      if (!opp || !position) return { available: false, reason: 'No lane opponent in this game mode.' };
      try {
        return { available: true, ...(await opgg.matchup(me.championName, opp.championName, position)) };
      } catch (err) {
        return { available: false, reason: `OP.GG is unavailable right now (${err.message}).` };
      }
    },
    'POST /api/goal': async (q, body) => {
      const p = await player();
      const queue = body.queue || 'ranked_solo';
      const ranks = await loadRanks(client, p);
      return setGoal(p.riotId, { tier: body.tier, division: body.division, queue }, ranks[queue] || null);
    },
    'DELETE /api/goal': async () => { clearGoal((await player()).riotId); return { cleared: true }; },
    'POST /api/focus': async (q, body) => addFocus((await player()).riotId, body),
    'POST /api/focus/status': async (q, body) => setFocusStatus((await player()).riotId, body.id, body.status),
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // Local only: refuse requests that arrive under another hostname (DNS rebinding).
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(403, { error: 'Local access only.' });

    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      try {
        let body = {};
        if (req.method === 'POST') {
          if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'JSON only.');
          body = JSON.parse((await readBody(req)) || '{}');
        }
        return send(200, await route(Object.fromEntries(url.searchParams), body));
      } catch (err) {
        const status = err.http || (err.status === 401 || err.status === 403 ? 401 : err.status === 404 ? 404 : 400);
        return send(status, { error: err.message, needsSetup: !loadConfig().apiKey });
      }
    }
    if (url.pathname.startsWith('/api/')) return send(404, { error: 'Not found.' });

    if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(403, { error: 'Forbidden.' });
    fs.readFile(file, (err, data) => {
      if (err) return send(404, 'Not found', 'text/plain');
      send(200, data, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  };
}

function httpError(status, message) { const e = new Error(message); e.http = status; return e; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100000) { reject(httpError(413, 'Too large.')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 4173;
  http.createServer(createApp()).listen(port, '127.0.0.1', () => {
    const cfg = loadConfig();
    console.log(`lol-coach is running at http://localhost:${port}`);
    if (!cfg.apiKey || !cfg.riotId) console.log('Not set up yet: run `npm run setup` first to enter your Riot API key and Riot ID.');
  });
}
