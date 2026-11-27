// Chat with the coach by running the user's own Claude Code CLI in headless mode.
// It uses whatever login Claude Code already has (for example a Claude subscription),
// loads this plugin, and may only call the plugin's Riot and OP.GG tools.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SYSTEM = `You are the coach inside the lol-coach web app, talking with the player in a narrow chat panel next to their dashboard and game reviews.
Follow the lol-coach "coach" skill: ground everything in the player's data from the riot tools and current-patch data from the opgg tools, and work through their plan (rank goal, focuses, scorecards).
Keep replies short and conversational: a few sentences or a short list, no tables, no headers larger than bold text. Give timestamps so the player can check the replay.
When the player agrees to a goal or focus, set it with the plan tools so it appears on their dashboard. Never ask for or mention API keys beyond telling them to run the setup script.`;

// Only the plugin's own servers and its skills; no shell, file or web access from the chat.
const ALLOWED = ['mcp__plugin_lol-coach_riot', 'mcp__plugin_lol-coach_opgg', 'Skill'];
const DISALLOWED = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task'];

export function chatArgs({ message, sessionId, model }) {
  const args = [
    '-p', message,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--plugin-dir', PLUGIN_ROOT,
    '--allowedTools', ALLOWED.join(','),
    '--disallowedTools', DISALLOWED.join(','),
    '--append-system-prompt', SYSTEM,
    '--model', model || process.env.LOL_COACH_CHAT_MODEL || 'sonnet',
  ];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

const TOOL_LABELS = {
  get_coaching_plan: 'Reading your plan', get_player_profile: 'Looking up your profile', get_match_history: 'Loading recent games',
  get_match_detail: 'Reading a game', get_match_timeline: 'Reading a game timeline', analyze_habits: 'Analyzing your habits',
  set_rank_goal: 'Setting your rank goal', set_focus: 'Adding a focus', update_focus: 'Updating a focus', get_live_game: 'Checking for a live game',
  lol_get_champion_analysis: 'Checking champion data on OP.GG', lol_get_lane_matchup_guide: 'Checking the matchup on OP.GG',
  lol_list_lane_meta_champions: 'Checking the tier list on OP.GG',
};
const PLAN_TOOLS = /set_rank_goal|set_focus|update_focus/;

/**
 * Turn Claude Code's stream-json lines into the few events the chat panel needs:
 * {type:'text', delta}, {type:'tool', label}, {type:'done', sessionId, planChanged, error}.
 */
export function createTranslator(emit) {
  const state = { sessionId: null, planChanged: false, sawText: false, done: false };
  return {
    state,
    line(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.session_id) state.sessionId = msg.session_id;
      if (msg.type === 'stream_event') {
        const ev = msg.event || {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          state.sawText = true;
          emit({ type: 'text', delta: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          const name = String(ev.content_block.name || '').split('__').pop();
          if (PLAN_TOOLS.test(name)) state.planChanged = true;
          if (name !== 'ToolSearch') emit({ type: 'tool', label: TOOL_LABELS[name] || (name === 'Skill' ? 'Loading coaching notes' : `Using ${name}`) });
        } else if (ev.type === 'message_start' && state.sawText) {
          emit({ type: 'text', delta: '\n\n' }); // a new assistant message after tool use
        }
      } else if (msg.type === 'result' && !state.done) {
        state.done = true;
        const failed = msg.is_error || (msg.subtype && msg.subtype !== 'success');
        // If nothing streamed (older CLI), fall back to the final text.
        if (!failed && !state.sawText && msg.result) emit({ type: 'text', delta: String(msg.result) });
        emit({
          type: 'done', sessionId: state.sessionId, planChanged: state.planChanged,
          error: failed ? String(msg.result || msg.subtype || 'The coach could not finish that reply.') : undefined,
        });
      }
    },
  };
}

/** Run one chat turn. Returns a function that stops it. */
export function runChat({ message, sessionId, model }, emit, { spawnImpl = spawn, command = process.env.LOL_COACH_CLAUDE_BIN || 'claude' } = {}) {
  // An empty working directory: the chat has nothing to do with local files.
  const cwd = path.join(os.tmpdir(), 'lol-coach-chat');
  fs.mkdirSync(cwd, { recursive: true });
  // Use the Claude Code login, not an API key that happens to be in the environment.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const child = spawnImpl(command, chatArgs({ message, sessionId, model }), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const translator = createTranslator(emit);
  let buffer = '', stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { translator.line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
  child.on('error', (err) => {
    if (translator.state.done) return;
    translator.state.done = true;
    emit({
      type: 'done',
      error: err.code === 'ENOENT'
        ? 'The chat needs Claude Code installed and logged in on this computer (the `claude` command was not found). The rest of the app works without it.'
        : `Could not start Claude Code: ${err.message}`,
    });
  });
  child.on('close', (code) => {
    if (buffer.trim()) translator.line(buffer);
    if (translator.state.done) return;
    translator.state.done = true;
    emit({ type: 'done', sessionId: translator.state.sessionId, planChanged: translator.state.planChanged,
      error: code === 0 ? undefined : `Claude Code exited with an error. ${stderr.trim().split('\n').pop() || 'Run `claude` in a terminal to check that you are logged in.'}` });
  });
  return () => { if (!translator.state.done) child.kill(); };
}
