#!/usr/bin/env node
// Print setup status (never the key). Exit code 1 when the key is missing or rejected.
import { RiotClient } from './riot.mjs';
import { TOOLS } from './tools.mjs';

const client = new RiotClient();
const status = await TOOLS.find((t) => t.name === 'get_setup_status').handler(client, {});
if (status.apiKeyValid && status.defaultRiotId) {
  try {
    const p = await client.resolvePlayer();
    status.player = `${p.riotId} found on ${p.platform}`;
  } catch (err) {
    status.player = err.message;
  }
}
console.log(JSON.stringify(status, null, 2));
process.exitCode = status.apiKeyValid && status.defaultRiotId && !/not found|No Riot account/i.test(status.player || '') ? 0 : 1;
