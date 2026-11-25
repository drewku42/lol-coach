// Configuration: where the Riot API key, default Riot ID and platform come from.
//
// Sources, highest priority first:
//   1. Config file (~/.config/lol-coach/config.json, or $LOL_COACH_CONFIG)
//      Re-read on every call, so a rotated dev key works without a restart.
//   2. Environment: RIOT_API_KEY, LOL_RIOT_ID, LOL_PLATFORM
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLATFORMS = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea',
};

// Friendly aliases people actually type.
const PLATFORM_ALIASES = {
  na: 'na1', br: 'br1', lan: 'la1', las: 'la2', euw: 'euw1', eune: 'eun1',
  tr: 'tr1', jp: 'jp1', oce: 'oc1', oc: 'oc1', sg: 'sg2', sea: 'sg2',
  tw: 'tw2', vn: 'vn2', me: 'me1',
};

export function normalizePlatform(input) {
  const p = String(input || '').trim().toLowerCase();
  if (!p) return null;
  const resolved = PLATFORM_ALIASES[p] || p;
  if (!PLATFORMS[resolved]) {
    throw new Error(
      `Unknown platform "${input}". Use one of: ${Object.keys(PLATFORMS).join(', ')} ` +
      `(aliases like na, euw, eune, kr, oce also work).`
    );
  }
  return resolved;
}

export function configPath() {
  return process.env.LOL_COACH_CONFIG ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'lol-coach', 'config.json');
}

export function cacheDir() {
  return process.env.LOL_COACH_CACHE ||
    (process.env.CLAUDE_PLUGIN_DATA && path.join(process.env.CLAUDE_PLUGIN_DATA, 'cache')) ||
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'lol-coach');
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// Unexpanded "${...}" placeholders mean the host never substituted a value.
const clean = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && !s.includes('${') ? s : '';
};

export function loadConfig() {
  const file = readConfigFile();
  return {
    apiKey: clean(file.apiKey) || clean(process.env.RIOT_API_KEY),
    riotId: clean(file.riotId) || clean(process.env.LOL_RIOT_ID),
    platform: normalizePlatform(clean(file.platform) || clean(process.env.LOL_PLATFORM)) || 'na1',
  };
}

export function saveConfig(values) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const merged = { ...readConfigFile(), ...values };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function parseRiotId(input) {
  const s = String(input || '').trim();
  const i = s.lastIndexOf('#');
  if (i <= 0 || i === s.length - 1) {
    throw new Error(`Riot ID must look like "GameName#TAG" (got "${s}").`);
  }
  return { gameName: s.slice(0, i).trim(), tagLine: s.slice(i + 1).trim() };
}

export const SETUP_HELP =
  'No Riot API key is configured. Get one at https://developer.riotgames.com (sign in with your Riot ' +
  'account; a development key is free and lasts 24 hours), then run the plugin\'s setup script in a ' +
  'terminal: `node <plugin dir>/server/setup.mjs`. Do not paste the key into chat.';
