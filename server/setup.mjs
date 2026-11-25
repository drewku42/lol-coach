#!/usr/bin/env node
// Interactive setup: stores the Riot API key and default player in a private
// config file so the key never has to pass through a chat.
//
//   node server/setup.mjs            full setup
//   node server/setup.mjs --key      only replace the API key (dev keys expire daily)
import readline from 'node:readline/promises';
import { configPath, loadConfig, normalizePlatform, parseRiotId, saveConfig, PLATFORMS } from './config.mjs';
import { RiotClient } from './riot.mjs';

const keyOnly = process.argv.includes('--key');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const current = loadConfig();

const ask = async (question, fallback) => {
  const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
  return answer || fallback || '';
};

console.log('lol-coach setup');
console.log('Get an API key at https://developer.riotgames.com (development keys last 24 hours).\n');

const values = {};
const key = await ask(current.apiKey ? 'Riot API key (enter to keep current)' : 'Riot API key (starts with RGAPI-)');
if (key) values.apiKey = key;

if (!keyOnly) {
  for (;;) {
    const id = await ask('Your Riot ID (GameName#TAG)', current.riotId);
    try { parseRiotId(id); values.riotId = id; break; } catch (e) { console.log(e.message); }
  }
  for (;;) {
    const p = await ask(`Platform (${Object.keys(PLATFORMS).join(', ')})`, current.platform);
    try { values.platform = normalizePlatform(p); break; } catch (e) { console.log(e.message); }
  }
}
rl.close();

const file = saveConfig(values);
console.log(`\nSaved to ${file} (readable only by you).`);

try {
  const client = new RiotClient();
  const player = await client.resolvePlayer();
  console.log(`Key works. Found ${player.riotId} on ${player.platform}. You're ready: try /lol-coach:coach in Claude Code.`);
} catch (err) {
  console.log(`Could not verify: ${err.message}`);
  process.exitCode = 1;
}
