---
name: review
description: Review a single League of Legends game in depth (the most recent one by default) and explain what decided it and what the player should do differently. Use when the user asks to review, break down or analyze their last game or a specific match.
argument-hint: "[match id | \"last loss\" | champion | blank for most recent game]"
---

# Game review

Review one game for the player using the `riot` MCP tools (`mcp__plugin_lol-coach_riot__*`).
Which game: $ARGUMENTS (blank means the most recent completed game).

## Steps

1. Find the match. If given a match id, use it. Otherwise call `get_match_history` (count 10) and
   pick the game that fits the request: most recent, last loss, latest game on a named champion.
   Skip remakes. If the choice is ambiguous, pick the most recent match that fits and say which
   one you picked.
2. Call `get_match_detail` and `get_match_timeline` for it, in parallel.
3. Optionally call `analyze_habits` if you want to say whether a mistake here is a recurring
   pattern or a one-off.

## Write the review

Structure it as the story of the game, then the lessons:

- **Result line**: champion, role, matchup, result, KDA, length.
- **Laning phase (0:00-14:00)**: use the 5/10/15 checkpoints. Who won lane and why: CS diff, gold
  diff, early deaths (time, who killed them, zone). An early death with two attackers in the enemy
  half of the lane is usually an overextension without vision.
- **Mid game (14:00-25:00)**: objectives each team took and whether the player was involved,
  deaths classified as picks or fights, whether a lead was used or thrown.
- **Late game**: the fights or picks that decided it; deaths with large shutdown gold.
- **Build and vision**: shop visits against what the enemy team needed (heavy AP, healing, tanks),
  control wards bought, wards placed per phase.
- **Turning point**: the one or two moments that swung the game most, with timestamps.
- **Takeaways**: at most three specific habits to practice next game, plus one thing done well.

Timestamps make this useful: the player can open the replay at that minute. Only the player's own
decisions are coachable, so do not blame teammates. The data cannot show cooldowns, health bars or
exact positioning in fights, so phrase inferences as likely explanations and suggest the player
check the replay at that timestamp where it matters.
