// The coaching plan: one rank goal, up to three active focuses, and a scorecard per focus.
// State lives next to the config file so the Claude Code plugin and the web app share it.
import fs from 'node:fs';
import path from 'node:path';
import { configPath } from './config.mjs';

// ---- rank maths ------------------------------------------------------------------

export const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER'];
const DIVISIONS = { IV: 0, III: 1, II: 2, I: 3 };
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

/** Collapse a rank into one number: 100 per division, 400 per tier, Master starts at 2800. */
export function rankValue(tier, division, lp = 0) {
  const t = String(tier || '').toUpperCase();
  if (APEX.has(t)) return 2800 + lp;
  const ti = TIERS.indexOf(t);
  if (ti < 0) throw new Error(`Unknown tier "${tier}". Use one of: ${TIERS.join(', ')}.`);
  const di = DIVISIONS[String(division || 'IV').toUpperCase()];
  if (di === undefined) throw new Error(`Unknown division "${division}". Use IV, III, II or I.`);
  return ti * 400 + di * 100 + lp;
}

export const rankLabel = (r) =>
  !r ? 'Unranked' : APEX.has(r.tier) ? `${cap(r.tier)} ${r.lp ?? 0} LP` : `${cap(r.tier)} ${r.division}${r.lp === undefined ? '' : ` ${r.lp} LP`}`;
const cap = (s) => s[0] + s.slice(1).toLowerCase();

/** Parse "GOLD IV" style league entries into {tier, division, lp}. */
export function parseRank(entry) {
  if (!entry) return null;
  const [tier, division] = String(entry.rank).split(' ');
  return { tier, division: APEX.has(tier) ? undefined : division, lp: entry.lp };
}

/**
 * Where the player stands against their goal.
 * `recent` is {games, wins} from recent play in the goal's queue, used for a rough pace estimate.
 */
export function goalProgress(goal, current, recent) {
  if (!goal) return null;
  const target = rankValue(goal.tier, goal.division, 0);
  const out = { ...goal, target: rankLabel({ tier: goal.tier, division: goal.division }) };
  if (!current) return { ...out, status: 'unranked', note: `No rank in ${goal.queue} yet. Finish placements first.` };
  const now = rankValue(current.tier, current.division, current.lp);
  const start = goal.start ? rankValue(goal.start.tier, goal.start.division, goal.start.lp) : now;
  out.current = rankLabel(current);
  out.started = rankLabel(goal.start || current);
  out.lpToGo = Math.max(0, target - now);
  out.lpGainedSinceSet = now - start;
  out.divisionsToGo = Math.ceil(out.lpToGo / 100);
  out.percent = target <= start ? (now >= target ? 100 : 0) : Math.max(0, Math.min(100, Math.round((100 * (now - start)) / (target - start))));
  out.status = now >= target ? 'reached' : 'in progress';
  if (recent?.games >= 10 && out.status !== 'reached') {
    const wr = recent.wins / recent.games;
    out.recentWinRate = Math.round(wr * 100);
    // Roughly 22 LP per result is typical; the real figure depends on hidden matchmaking rating.
    const perGame = 22 * (2 * wr - 1);
    out.estimatedGames = perGame > 0.5 ? Math.ceil(out.lpToGo / perGame) : null;
    out.paceNote = out.estimatedGames
      ? `About ${out.estimatedGames} games at your recent ${out.recentWinRate}% win rate (rough: assumes ~22 LP per game).`
      : `At your recent ${out.recentWinRate}% win rate your rank will not rise; the focuses are how that changes.`;
  }
  return out;
}

// ---- focus metrics ---------------------------------------------------------------

const count = (g, pred) => (g.deathEvents ? g.deathEvents.filter(pred).length : null);

/** Every number a focus can target. Each is computed per game from a gameRecord. */
export const METRICS = {
  early_deaths: { label: 'Deaths before 14:00', unit: 'deaths', better: 'lower', value: (g) => count(g, (d) => d.phase === 'early') },
  mid_deaths: { label: 'Deaths from 14:00 to 25:00', unit: 'deaths', better: 'lower', value: (g) => count(g, (d) => d.phase === 'mid') },
  solo_deaths: { label: 'Times solo-killed', unit: 'deaths', better: 'lower', value: (g) => count(g, (d) => d.kind === 'solo-killed') },
  deaths: { label: 'Deaths', unit: 'deaths', better: 'lower', value: (g) => g.deaths },
  time_dead_pct: { label: 'Time spent dead', unit: '%', better: 'lower', value: (g) => g.timeDeadPct },
  cs_at_10: { label: 'CS at 10:00', unit: 'CS', better: 'higher', value: (g) => g.csAt10 ?? null },
  cs_per_min: { label: 'CS per minute', unit: 'CS/min', better: 'higher', value: (g) => g.csPerMin },
  gold_diff_15: { label: 'Gold lead over lane opponent at 15:00', unit: 'gold', better: 'higher', value: (g) => g.goldDiffAt15 ?? null },
  control_wards: { label: 'Control wards bought', unit: 'wards', better: 'higher', value: (g) => g.controlWards },
  vision_per_min: { label: 'Vision score per minute', unit: '/min', better: 'higher', value: (g) => g.visionPerMin },
  kill_participation: { label: 'Kill participation', unit: '%', better: 'higher', value: (g) => g.killParticipation },
};

const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const passes = (focus, v) => (v === null || v === undefined ? null : focus.op === '>=' ? v >= focus.threshold : v <= focus.threshold);

const matchesFilter = (focus, g) =>
  !g.remake &&
  (!focus.queue || g.queue === focus.queue) &&
  (!focus.role || g.role === focus.role) &&
  (!focus.champion || g.champion.toLowerCase() === focus.champion.toLowerCase());

/** Mark each game pass/fail for a focus. Games are split at the moment the focus was set. */
export function scorecard(focus, records) {
  const metric = METRICS[focus.metric];
  const rows = records
    .filter((g) => matchesFilter(focus, g))
    .map((g) => {
      const value = r1(metric.value(g));
      return { matchId: g.matchId, start: g.start, champion: g.champion, win: g.win, value, pass: passes(focus, value) };
    })
    .filter((x) => x.pass !== null)
    .sort((a, b) => a.start - b.start);
  const since = rows.filter((x) => x.start >= focus.createdAt);
  const before = rows.filter((x) => x.start < focus.createdAt).slice(-focus.targetWindow);
  const window = since.slice(-focus.targetWindow);
  const hits = window.filter((x) => x.pass).length;
  const tally = (xs) => ({ games: xs.length, hits: xs.filter((x) => x.pass).length });
  return {
    target: `${focus.targetHits} of ${focus.targetWindow} games`,
    since: { ...tally(since), recent: window },
    before: { ...tally(before), recent: before },
    achieved: window.length >= focus.targetWindow && hits >= focus.targetHits,
    gamesLeftInWindow: Math.max(0, focus.targetWindow - window.length),
  };
}

// ---- suggestions -----------------------------------------------------------------

const avg = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const wr = (gs) => (gs.length ? Math.round((100 * gs.filter((g) => g.win).length) / gs.length) : null);

/**
 * Rule-based focus candidates from recent games, ranked by how many games each costs.
 * The coach can adopt these as they are or write better ones.
 */
export function suggestFocuses(records) {
  const games = records.filter((g) => !g.remake);
  if (games.length < 8) return [];
  const timed = games.filter((g) => g.deathEvents);
  const mainRole = mode(games.map((g) => g.role));
  const out = [];
  const add = (impact, f) => out.push({ impact: Math.round(impact), op: METRICS[f.metric].better === 'higher' ? '>=' : '<=', targetHits: 8, targetWindow: 10, ...f });

  if (timed.length >= 8) {
    const early = (g) => METRICS.early_deaths.value(g);
    const bad = timed.filter((g) => early(g) >= 2), ok = timed.filter((g) => early(g) <= 1);
    if (bad.length >= 3 && wr(ok) - wr(bad) >= 15) {
      add(bad.length * (wr(ok) - wr(bad)), {
        metric: 'early_deaths', threshold: 1, title: 'Survive the early game',
        finding: `With 0-1 deaths before 14:00 you win ${wr(ok)}% (${ok.length} games); with 2 or more you win ${wr(bad)}% (${bad.length} games).`,
        rule: 'Before 14:00, do not take a fight unless you can see the enemy jungler on the map.',
      });
    }
    const mid = (g) => METRICS.mid_deaths.value(g);
    const badMid = timed.filter((g) => mid(g) >= 3), okMid = timed.filter((g) => mid(g) <= 1);
    if (badMid.length >= 3 && okMid.length >= 3 && wr(okMid) - wr(badMid) >= 15) {
      add(badMid.length * (wr(okMid) - wr(badMid)) * 0.9, {
        metric: 'mid_deaths', threshold: 1, title: 'Stop getting picked in the mid game',
        finding: `With 0-1 deaths between 14:00 and 25:00 you win ${wr(okMid)}% (${okMid.length} games); with 3 or more you win ${wr(badMid)}% (${badMid.length} games).`,
        rule: 'After 14:00, do not walk into river or enemy jungle alone without a ward ahead of you.',
      });
    }
    const solo = avg(timed.map((g) => METRICS.solo_deaths.value(g)));
    if (solo >= 1.2) {
      add(timed.length * solo * 4, {
        metric: 'solo_deaths', threshold: 0, title: 'Stop losing 1v1s', targetHits: 6,
        finding: `You are solo-killed ${r1(solo)} times per game on average.`,
        rule: 'After losing a 1v1 to someone, do not fight them alone again that game.',
      });
    }
  }

  const wards = avg(games.map((g) => g.controlWards));
  const wardGoal = mainRole === 'support' ? 3 : mainRole === 'jungle' ? 2 : 1;
  if (wards < wardGoal * 0.6) {
    const none = games.filter((g) => g.controlWards === 0).length;
    add(none * 6, {
      metric: 'control_wards', threshold: wardGoal, title: 'Buy control wards',
      finding: `You bought no control ward in ${none} of ${games.length} games (average ${r1(wards)} per game).`,
      rule: `Buy a control ward on your first two backs after 8:00 and place it before the next objective.`,
    });
  }

  const laners = games.filter((g) => ['top', 'mid', 'adc'].includes(g.role) && Number.isFinite(g.csAt10));
  const cs10 = avg(laners.map((g) => g.csAt10));
  if (laners.length >= 6 && cs10 < 70) {
    const goal = Math.round((cs10 + 8) / 5) * 5;
    add(laners.length * (70 - cs10) * 0.8, {
      metric: 'cs_at_10', threshold: goal, title: 'Farm better in lane', targetHits: 7,
      finding: `You average ${Math.round(cs10)} CS at 10:00 in lane (${laners.length} games); around 80 is strong.`,
      rule: 'Last-hit every minion you can reach safely before thinking about trading.',
    });
  }

  const deaths = avg(games.map((g) => g.deaths));
  if (deaths >= 6 && !out.some((f) => f.metric.endsWith('deaths'))) {
    add(games.length * (deaths - 5) * 5, {
      metric: 'deaths', threshold: 5, title: 'Die less',
      finding: `You average ${r1(deaths)} deaths per game.`,
      rule: 'Before every fight, ask whether you would still take it if you could not get the kill.',
    });
  }

  return out.sort((a, b) => b.impact - a.impact);
}

function mode(xs) {
  const c = new Map();
  for (const x of xs) if (x) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// ---- storage ---------------------------------------------------------------------

export const MAX_ACTIVE = 3;
export const planPath = () => process.env.LOL_COACH_PLAN || path.join(path.dirname(configPath()), 'plan.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(planPath(), 'utf8')); } catch { return { players: {} }; }
}

function writeAll(data) {
  const file = planPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const keyOf = (riotId) => String(riotId).toLowerCase();

export function loadPlan(riotId) {
  const plan = readAll().players?.[keyOf(riotId)] || {};
  return { goal: plan.goal || null, focuses: plan.focuses || [] };
}

function savePlan(riotId, plan) {
  const all = readAll();
  all.players = { ...all.players, [keyOf(riotId)]: plan };
  writeAll(all);
  return plan;
}

export function setGoal(riotId, { tier, division, queue = 'ranked_solo' }, currentRank, now = Date.now()) {
  const t = String(tier || '').toUpperCase();
  if (!TIERS.includes(t)) throw new Error(`Goal tier must be one of: ${TIERS.join(', ')}.`);
  if (!['ranked_solo', 'ranked_flex'].includes(queue)) throw new Error('Goal queue must be ranked_solo or ranked_flex.');
  const d = t === 'MASTER' ? undefined : String(division || 'IV').toUpperCase();
  const target = rankValue(t, d);
  if (currentRank && rankValue(currentRank.tier, currentRank.division, currentRank.lp) >= target) {
    throw new Error(`You are already ${rankLabel(currentRank)}, at or above that goal. Pick a higher one.`);
  }
  const plan = loadPlan(riotId);
  plan.goal = { queue, tier: t, division: d, setAt: now, start: currentRank || null };
  return savePlan(riotId, plan).goal;
}

export function clearGoal(riotId) {
  const plan = loadPlan(riotId);
  plan.goal = null;
  savePlan(riotId, plan);
}

export function addFocus(riotId, input, now = Date.now()) {
  const metric = METRICS[input.metric];
  if (!metric) throw new Error(`Unknown metric "${input.metric}". Use one of: ${Object.keys(METRICS).join(', ')}.`);
  if (!Number.isFinite(Number(input.threshold))) throw new Error('A focus needs a numeric threshold.');
  if (!input.title || !input.rule) throw new Error('A focus needs a title and a rule to practise.');
  const plan = loadPlan(riotId);
  const active = plan.focuses.filter((f) => f.status === 'active');
  if (active.length >= MAX_ACTIVE) {
    throw new Error(`There are already ${MAX_ACTIVE} active focuses (${active.map((f) => f.title).join('; ')}). Retire one before adding another.`);
  }
  if (active.some((f) => f.metric === input.metric)) throw new Error(`There is already an active focus on ${metric.label}.`);
  const targetWindow = clamp(input.targetWindow ?? 10, 3, 20);
  const focus = {
    id: `f${now.toString(36)}`,
    title: String(input.title),
    finding: String(input.finding || ''),
    rule: String(input.rule),
    metric: input.metric,
    op: input.op === '>=' || input.op === '<=' ? input.op : metric.better === 'higher' ? '>=' : '<=',
    threshold: Number(input.threshold),
    targetHits: clamp(input.targetHits ?? Math.ceil(targetWindow * 0.8), 1, targetWindow),
    targetWindow,
    queue: input.queue || undefined,
    role: input.role || undefined,
    champion: input.champion || undefined,
    status: 'active',
    createdAt: now,
  };
  plan.focuses.push(focus);
  savePlan(riotId, plan);
  return focus;
}

export function setFocusStatus(riotId, id, status, now = Date.now()) {
  if (!['active', 'achieved', 'dropped'].includes(status)) throw new Error('Status must be active, achieved or dropped.');
  const plan = loadPlan(riotId);
  const focus = plan.focuses.find((f) => f.id === id);
  if (!focus) throw new Error(`No focus with id "${id}".`);
  if (status === 'active' && focus.status !== 'active' && plan.focuses.filter((f) => f.status === 'active').length >= MAX_ACTIVE) {
    throw new Error(`There are already ${MAX_ACTIVE} active focuses.`);
  }
  focus.status = status;
  focus.closedAt = status === 'active' ? undefined : now;
  savePlan(riotId, plan);
  return focus;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v))));

/** The whole plan with live numbers: goal progress and a scorecard per focus. */
export function planStatus(riotId, { ranks = {}, records = [] } = {}) {
  const plan = loadPlan(riotId);
  const describe = (f) => ({
    ...f,
    metricLabel: METRICS[f.metric].label,
    unit: METRICS[f.metric].unit,
    targetText: `${METRICS[f.metric].label} ${f.op === '>=' ? 'at least' : 'at most'} ${f.threshold}, in ${f.targetHits} of ${f.targetWindow} games`,
    scorecard: scorecard(f, records),
  });
  let goal = null;
  if (plan.goal) {
    const inQueue = records.filter((g) => !g.remake && g.queue === plan.goal.queue).sort((a, b) => b.start - a.start).slice(0, 20);
    goal = goalProgress(plan.goal, ranks[plan.goal.queue] || null, { games: inQueue.length, wins: inQueue.filter((g) => g.win).length });
  }
  const active = plan.focuses.filter((f) => f.status === 'active').map(describe);
  return {
    riotId,
    goal,
    activeFocuses: active,
    pastFocuses: plan.focuses.filter((f) => f.status !== 'active').map(({ id, title, status, metric, closedAt }) => ({ id, title, status, metric, closedAt })),
    openSlots: MAX_ACTIVE - active.length,
    suggestions: suggestFocuses(records).filter((s) => !active.some((f) => f.metric === s.metric)),
  };
}
