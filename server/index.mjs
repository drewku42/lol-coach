#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
import readline from 'node:readline';
import { RiotClient } from './riot.mjs';
import { TOOLS } from './tools.mjs';

const SERVER_INFO = { name: 'lol-coach', version: '0.3.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function createServer(client = new RiotClient()) {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  return async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion)
            ? params.protocolVersion
            : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Riot API data for League of Legends coaching. Tools default to the configured player; ' +
            'pass riot_id ("Name#TAG") and platform to look at anyone else. Never ask the user to paste their API key into chat.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
        try {
          const result = await tool.handler(client, params.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      }
      default:
        if (id === undefined) return null; // notification
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}

function main() {
  const handle = createServer();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let closed = false;
  const maybeExit = () => { if (closed && pending === 0) process.exit(0); };

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    pending++;
    try {
      const res = await handle(msg);
      if (res && msg.id !== undefined) process.stdout.write(JSON.stringify(res) + '\n');
    } catch (err) {
      console.error('[lol-coach]', err);
    } finally {
      pending--;
      maybeExit();
    }
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
