---
name: habits
description: Report on a League of Legends player's habits and trends across their recent games - recurring mistakes, strengths, champion pool, laning, death patterns and tilt. Use when the user asks about their habits, tendencies, trends, progress, or for an overall assessment of their play.
argument-hint: "[number of games] [queue, champion or role filter]"
---

# Habit report

Build a habit report for the player using the `riot` MCP tools (`mcp__plugin_lol-coach_riot__*`).
Scope requested: $ARGUMENTS (default: last 20 games, all queues).

## Steps

1. Call `get_player_profile` and `analyze_habits` in parallel. Map the request onto the `count`,
   `queue`, `champion` and `role` arguments. If the player mostly plays ranked, prefer
   `queue: ranked_solo` so ARAM and normals do not dilute the picture.
2. If the result includes `partial`, call `analyze_habits` again with the same arguments (earlier
   games are cached) until it is complete.
3. To confirm the top one or two patterns, pull `get_match_timeline` for two recent games that
   show them.

## Write the report

- **Snapshot**: rank, sample (games, dates, queues), win rate, recent form.
- **Strengths**: two or three, with numbers.
- **Habits costing games**: up to three, ranked by impact. For each: the evidence (numbers and
  example games), why it loses games, and one concrete rule to practice.
- **Champion pool and role**: what to keep playing, what to drop, based on games and win rate.
- **Mental and session habits**: performance after losses and deep into sessions; suggest a
  stop-loss rule only if the data supports it.
- **Focus for the next 10 games**: one primary goal with a measurable target (for example "average
  under 2 deaths before 14:00" or "70 CS at 10:00"), so progress can be checked by running this
  report again.

Follow the benchmarks and delivery guidance in the `coach` skill. Be honest about small samples.
