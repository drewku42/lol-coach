# lol-coach

A League of Legends coach for [Claude Code](https://claude.com/claude-code). It gives Claude your
real Riot match data (profile, match history, minute-by-minute timelines and aggregated habits) and
teaches it how to coach from that data: what is actually losing you games, backed by your own
numbers, with concrete things to practice. It also connects to OP.GG for current builds, runes,
matchups and win rates, so the coach can compare what you did with what works on this patch.

## What you can ask

- `/lol-coach:coach why do I keep losing lane as Ahri?`
- `/lol-coach:review` reviews your most recent game (or `last loss`, a champion, or a match id)
- `/lol-coach:habits 30 ranked_solo` reports on habits across your last 30 solo queue games
- Or just ask in plain language: "what should I work on to get out of Gold?"

## Install

Requires Claude Code and Node.js 18 or newer. No npm install needed.

```bash
claude plugin marketplace add drewku42/lol-coach
```

```bash
claude plugin install lol-coach@lol-coach-marketplace
```

## Setup

You need your own Riot API key. Sign in at <https://developer.riotgames.com> with your Riot
account; the dashboard shows a free **development key** (starts with `RGAPI-`). Development keys
expire every 24 hours, so you regenerate one when you want a coaching session. To get a key that
does not expire, register a **Personal API Key** product on the same site.

Then enter the key, your Riot ID (`GameName#TAG`) and your server one of two ways:

- In Claude Code: `/plugin configure lol-coach@lol-coach-marketplace`, then `/reload-plugins`.
  The key is stored in your system credential store.
- In a terminal: `node server/setup.mjs` from the plugin folder. It saves to
  `~/.config/lol-coach/config.json` (readable only by you) and verifies the key. Use
  `node server/setup.mjs --key` to swap in a fresh key later. This file takes priority over the
  plugin settings and is picked up without restarting.

Do not paste your key into a chat. Run `/lol-coach:setup` any time for help.

## What Claude gets

The bundled MCP server (`server/`, plain Node, no dependencies) exposes these tools:

| Tool | What it returns |
| --- | --- |
| `get_player_profile` | Level, ranked tier/LP/win rate, top champion masteries |
| `get_match_history` | Recent games summarized from your point of view |
| `get_match_detail` | One game: your stats, runes and summoner spells, lane opponent comparison, both scoreboards, objectives |
| `get_match_timeline` | One game minute by minute: CS/gold/XP diffs at 5/10/15/20, every death (when, who, where), objectives, shop visits, warding |
| `analyze_habits` | Patterns over 5-40 games: wins vs losses, per champion and role, laning, lead conversion, death patterns, game length, sessions and tilt |
| `get_live_game` | Whether you are in a game now and the two rosters |
| `get_setup_status` | Whether the key works (never returns the key) |

Every tool defaults to your configured account and accepts `riot_id` and `platform` to look at any
other player, so you can scout a friend or a duo partner.

The plugin also bundles [OP.GG's MCP server](https://github.com/opgginc/opgg-mcp) (`opgg`), which
needs no key. The coach uses it for champion win, pick and ban rates, standard items, runes and
skill order by rank tier, lane matchup guides and tier lists. It is a free third-party service
run by OP.GG; if it is unreachable the coach still works from your Riot data.

Match data is cached on disk (matches never change), which keeps repeat analysis fast and inside
the development key rate limits (20 requests per second and 100 per 2 minutes, per routing value). If a large first-time request hits
the limit, the tool returns what it has and says to call again.

## Limits worth knowing

- The Riot API has no replay data: no cooldowns, health bars or exact fight positioning. Death
  "kinds" and map zones are heuristics from event positions and assist counts. The coach gives
  timestamps so you can check the replay yourself.
- Each user brings their own key. Serving many users from one key requires a Riot Production key
  and a hosted service, which this plugin deliberately avoids.

## Development

```bash
npm test
```

```bash
claude --plugin-dir .
```

```bash
claude plugin validate .
```

Tests run against synthetic match data with a fake `fetch`; no key or network needed.

## Legal

lol-coach is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or
anyone officially involved in producing or managing Riot Games properties. Riot Games and all
associated properties are trademarks or registered trademarks of Riot Games, Inc.

MIT licensed.
