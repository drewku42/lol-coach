---
name: setup
description: Set up or fix the lol-coach plugin - Riot API key, default Riot ID and server. Use when the user wants to connect their League account, when a riot tool reports a missing, invalid or expired API key, or when the user asks how to share the plugin.
---

# lol-coach setup

Start by calling `mcp__plugin_lol-coach_riot__get_setup_status` to see what is configured.

**Never ask the user to paste their API key into the chat, and never write it to a file yourself.**
The key goes in through one of the two routes below, which the user performs.

## What the user needs

1. A Riot API key: sign in at https://developer.riotgames.com with their Riot account. The
   dashboard shows a **development key** (starts with `RGAPI-`). It is free and expires every
   24 hours; they regenerate it on the same page.
2. Their Riot ID (`GameName#TAG`, visible in the League client by hovering their profile) and
   server (na1, euw1, eun1, kr, br1, la1, la2, oc1, jp1, tr1, ru, me1, sg2, tw2, vn2).

## Two ways to enter it

- **Plugin settings (simplest)**: run `/plugin configure lol-coach@lol-coach-marketplace` and fill
  in the key, Riot ID and server. The key is stored in the system credential store. Then run
  `/reload-plugins`.
- **Setup script**: in a terminal, run `node "${CLAUDE_SKILL_DIR}/../../server/setup.mjs"`. It prompts
  for the three values, saves them to `~/.config/lol-coach/config.json` (private to the user) and
  verifies the key. When only the key has expired: `node "${CLAUDE_SKILL_DIR}/../../server/setup.mjs" --key`.
  Values in this file take priority over plugin settings and are picked up without a restart.

After either route, call `get_setup_status` again to confirm `apiKeyValid` is true, then offer to
run a first habit report.

## Keys that do not expire daily

For regular personal use, the user can register a **Personal API key** on the Riot developer
portal ("Register Product" > "Personal API Key"): describe the project, wait for approval, and the
key stops expiring. Each person who installs this plugin uses their own key; a single shared key
for many users would need a Riot **Production key** and a hosted service.

## Troubleshooting

- 401/403: key expired or mistyped. Regenerate and re-enter it.
- "No Riot account found": check the tag after `#` and the server.
- Rate limit messages or `partial` results: development keys allow 100 requests per 2 minutes.
  Wait and call again; fetched matches are cached on disk, so repeat calls are cheap.
