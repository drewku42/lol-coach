// Riot API client: routing, rate limiting, retries, and an on-disk cache.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PLATFORMS, cacheDir, loadConfig, parseRiotId, SETUP_HELP } from './config.mjs';

export class RiotError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sliding-window limiter sized for a development key (20 req/s, 100 req/2 min),
// kept slightly under so we rarely see a 429.
class RateLimiter {
  constructor(windows = [[1000, 18], [120000, 95]]) {
    this.windows = windows;
    this.stamps = [];
    this.chain = Promise.resolve();
  }

  // How long a new request would have to wait right now.
  waitMs(now = Date.now()) {
    let wait = 0;
    for (const [span, max] of this.windows) {
      const inWindow = this.stamps.filter((t) => now - t < span);
      if (inWindow.length >= max) {
        wait = Math.max(wait, inWindow[inWindow.length - max] + span - now);
      }
    }
    return wait;
  }

  acquire() {
    const next = this.chain.then(async () => {
      for (;;) {
        const wait = this.waitMs();
        if (wait <= 0) break;
        await sleep(wait + 5);
      }
      const now = Date.now();
      this.stamps.push(now);
      const longest = Math.max(...this.windows.map((w) => w[0]));
      this.stamps = this.stamps.filter((t) => now - t < longest);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export class RiotClient {
  constructor({ fetchImpl = globalThis.fetch, cache = cacheDir(), getConfig = loadConfig } = {}) {
    this.fetch = fetchImpl;
    this.cache = cache;
    this.getConfig = getConfig;
    // Riot enforces limits per routing value (na1, americas, ...), so each host gets its own budget.
    this.limiters = new Map();
    this.memo = new Map();
  }

  regionFor(platform) {
    return PLATFORMS[platform];
  }

  // ---- low-level -----------------------------------------------------------

  limiterFor(host) {
    if (!this.limiters.has(host)) this.limiters.set(host, new RateLimiter());
    return this.limiters.get(host);
  }

  async request(host, pathname, { query, allow404 = false } = {}) {
    const { apiKey } = this.getConfig();
    if (!apiKey) throw new RiotError(SETUP_HELP, 401);

    const url = new URL(`https://${host}.api.riotgames.com${pathname}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      await this.limiterFor(host).acquire();
      let res;
      try {
        res = await this.fetch(url, { headers: { 'X-Riot-Token': apiKey } });
      } catch (err) {
        if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
        throw new RiotError(`Network error reaching the Riot API (${host}): ${err.message}`, 0);
      }

      if (res.ok) return res.json();
      if (res.status === 404 && allow404) return null;

      if (res.status === 429 && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(Math.min(retryAfter, 120) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }

      throw new RiotError(describeStatus(res.status, pathname), res.status);
    }
  }

  readCache(kind, id) {
    try {
      const buf = fs.readFileSync(path.join(this.cache, kind, `${id}.json.gz`));
      return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    } catch {
      return null;
    }
  }

  writeCache(kind, id, data) {
    try {
      const dir = path.join(this.cache, kind);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json.gz`), zlib.gzipSync(JSON.stringify(data)));
    } catch {
      // Cache is best-effort.
    }
  }

  isCached(kind, id) {
    return fs.existsSync(path.join(this.cache, kind, `${id}.json.gz`));
  }

  // ---- endpoints -----------------------------------------------------------

  /** Resolve "Name#TAG" (or the configured default) to an account with puuid. */
  async resolvePlayer(riotId, platformArg) {
    const cfg = this.getConfig();
    const id = riotId || cfg.riotId;
    if (!id) {
      throw new RiotError(
        'No Riot ID given and no default configured. Pass riot_id as "GameName#TAG" or run the setup script.',
        400
      );
    }
    const platform = platformArg || cfg.platform;
    const region = this.regionFor(platform);
    const { gameName, tagLine } = parseRiotId(id);
    const key = `${gameName.toLowerCase()}#${tagLine.toLowerCase()}`;
    if (!this.memo.has(key)) {
      const account = await this.request(
        region,
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
        { allow404: true }
      );
      if (!account) {
        throw new RiotError(`No Riot account found for "${gameName}#${tagLine}". Check spelling and tag.`, 404);
      }
      this.memo.set(key, account);
    }
    const account = this.memo.get(key);
    return {
      puuid: account.puuid,
      riotId: `${account.gameName}#${account.tagLine}`,
      platform,
      region,
    };
  }

  summoner(player) {
    return this.request(player.platform, `/lol/summoner/v4/summoners/by-puuid/${player.puuid}`);
  }

  leagueEntries(player) {
    return this.request(player.platform, `/lol/league/v4/entries/by-puuid/${player.puuid}`);
  }

  topMasteries(player, count = 10) {
    return this.request(
      player.platform,
      `/lol/champion-mastery/v4/champion-masteries/by-puuid/${player.puuid}/top`,
      { query: { count } }
    );
  }

  matchIds(player, { start = 0, count = 20, queue, startTime, endTime } = {}) {
    return this.request(player.region, `/lol/match/v5/matches/by-puuid/${player.puuid}/ids`, {
      query: { start, count, queue, startTime, endTime },
    });
  }

  async match(matchId, region) {
    const cached = this.readCache('matches', matchId);
    if (cached) return cached;
    const data = await this.request(region || regionOfMatch(matchId), `/lol/match/v5/matches/${matchId}`);
    this.writeCache('matches', matchId, data);
    return data;
  }

  async timeline(matchId, region) {
    const cached = this.readCache('timelines', matchId);
    if (cached) return cached;
    const data = await this.request(region || regionOfMatch(matchId), `/lol/match/v5/matches/${matchId}/timeline`);
    this.writeCache('timelines', matchId, data);
    return data;
  }

  liveGame(player) {
    return this.request(player.platform, `/lol/spectator/v5/active-games/by-summoner/${player.puuid}`, {
      allow404: true,
    });
  }

  // ---- static data (Data Dragon, no key needed) -----------------------------

  async staticData() {
    if (this._static) return this._static;
    const cached = this.readCache('static', 'ddragon');
    if (cached && Date.now() - cached.fetchedAt < 3 * 24 * 3600 * 1000) {
      return (this._static = cached);
    }
    try {
      const get = async (u) => {
        const r = await this.fetch(u);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };
      const base = 'https://ddragon.leagueoflegends.com';
      const [version] = await get(`${base}/api/versions.json`);
      const [items, champs] = await Promise.all([
        get(`${base}/cdn/${version}/data/en_US/item.json`),
        get(`${base}/cdn/${version}/data/en_US/champion.json`),
      ]);
      const data = { fetchedAt: Date.now(), version, items: {}, champions: {} };
      for (const [id, item] of Object.entries(items.data)) data.items[id] = item.name;
      for (const champ of Object.values(champs.data)) data.champions[champ.key] = champ.name;
      this.writeCache('static', 'ddragon', data);
      return (this._static = data);
    } catch {
      // Names are a nicety; fall back to stale cache or raw IDs.
      return (this._static = cached || { version: null, items: {}, champions: {} });
    }
  }
}

// Match IDs are prefixed with the platform, e.g. "NA1_5012345678".
export function regionOfMatch(matchId) {
  const prefix = String(matchId).split('_')[0].toLowerCase();
  const region = PLATFORMS[prefix];
  if (!region) throw new RiotError(`Cannot infer region from match id "${matchId}".`, 400);
  return region;
}

function describeStatus(status, pathname) {
  switch (status) {
    case 400: return `Riot API rejected the request (400) for ${pathname}.`;
    case 401:
    case 403:
      return (
        `Riot API refused the key (${status}). Development keys expire every 24 hours: regenerate it at ` +
        'https://developer.riotgames.com and re-run the setup script (`node <plugin dir>/server/setup.mjs`).'
      );
    case 404: return `Not found (404): ${pathname}.`;
    case 429: return 'Riot API rate limit exceeded (429) even after retries. Wait a couple of minutes and try again.';
    default: return `Riot API error ${status} for ${pathname}.`;
  }
}
