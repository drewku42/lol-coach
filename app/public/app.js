// lol-coach web app: dashboard (goal, focuses, trends, games) and visual game review.
const view = document.getElementById('view');
const tip = document.getElementById('tip');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US'));
const signed = (n) => (n === null || n === undefined ? '–' : `${n > 0 ? '+' : ''}${fmt(Math.round(n))}`);
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const clock = (minute) => `${Math.floor(minute)}:${String(Math.round((minute % 1) * 60)).padStart(2, '0')}`;
const QUEUE = { ranked_solo: 'Solo', ranked_flex: 'Flex', normal_draft: 'Normal', quickplay: 'Quickplay', swiftplay: 'Swiftplay', aram: 'ARAM', clash: 'Clash' };
const queueLabel = (q) => QUEUE[q] || (String(q).startsWith('queue_') ? 'Other' : q);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '');

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { needsSetup: data.needsSetup });
  return data;
}

function showTip(html, ev) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14, r = tip.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.hidden = true; };

function showError(err) {
  const setup = err.needsSetup
    ? '<p>No Riot API key is configured. In a terminal, run <code>npm run setup</code> in the lol-coach folder, then refresh.</p>'
    : '<p class="muted">If this mentions the API key, development keys expire every 24 hours: get a new one at developer.riotgames.com and run <code>npm run setup -- --key</code>.</p>';
  view.innerHTML = `<div class="card error"><h2>Could not load</h2><p>${esc(err.message)}</p>${setup}</div>`;
}

// ---- nice axis ticks ----------------------------------------------------------
function ticks(min, max, n = 5) {
  if (min === max) { min -= 1; max += 1; }
  const step0 = (max - min) / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
const kfmt = (v) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : `${v}`);

// ---- dashboard ----------------------------------------------------------------
let overview = null;

async function dashboard(force) {
  if (!overview || force) {
    view.innerHTML = '<p class="muted pad">Loading your games…</p>';
    overview = await api('/api/overview');
  }
  const o = overview;
  document.getElementById('who').textContent = `${o.riotId} · ${o.platform.toUpperCase()}`;
  view.innerHTML = `
    ${goalCard(o)}
    <section>
      <div class="row" style="margin-bottom:10px"><h2 style="margin:0">Active focuses</h2>
        <span class="muted small">${o.plan.activeFocuses.length} of 3 · each game is checked automatically</span></div>
      <div class="grid3">${o.plan.activeFocuses.map(focusCard).join('') || '<p class="muted">No focus yet. Adopt one of the suggestions below, or ask the coach in Claude Code to set one.</p>'}</div>
    </section>
    ${o.plan.openSlots && o.plan.suggestions.length ? `<section><h2>Suggested from your last ${o.habits.sample?.games ?? ''} games</h2>
      <div class="grid3">${o.plan.suggestions.slice(0, 3).map(suggestCard).join('')}</div></section>` : ''}
    <section class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0">Trend</h2>
      <select id="metric" aria-label="Metric">${TRENDS.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select>
      <span class="muted small">each dot is a game, oldest on the left; the line is a 5-game average</span></div>
      <div id="trend" class="chart"></div>
      <div class="legend"><span>● win</span><span>○ loss</span><span><i class="swatch" style="background:var(--series-1)"></i>5-game average</span></div>
    </section>
    <section class="card"><h2>Recent games</h2><div class="tablewrap">${gamesTable(o.games)}</div></section>`;

  const sel = document.getElementById('metric');
  const focusMetric = o.plan.activeFocuses[0]?.metric;
  const startIdx = Math.max(0, TRENDS.findIndex((t) => t.metric === focusMetric));
  sel.value = String(startIdx);
  const draw = () => trendChart(document.getElementById('trend'), o, TRENDS[Number(sel.value)]);
  sel.onchange = draw;
  draw();

  view.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => { location.hash = `#/match/${tr.dataset.id}`; }; });
  view.querySelectorAll('[data-adopt]').forEach((b) => { b.onclick = () => act(() => api('/api/focus', { method: 'POST', body: o.plan.suggestions[Number(b.dataset.adopt)] })); });
  view.querySelectorAll('[data-status]').forEach((b) => { b.onclick = () => act(() => api('/api/focus/status', { method: 'POST', body: { id: b.dataset.id, status: b.dataset.status } })); });
  const form = document.getElementById('goalform');
  if (form) form.onsubmit = (e) => { e.preventDefault(); const f = new FormData(form); act(() => api('/api/goal', { method: 'POST', body: Object.fromEntries(f) })); };
  const edit = document.getElementById('goaledit');
  if (edit) edit.onclick = () => { document.getElementById('goalformwrap').hidden = false; edit.hidden = true; };
}

async function act(fn) {
  try { await fn(); await dashboard(true); } catch (err) { alert(err.message); }
}

function rankText(r) {
  if (!r) return 'Unranked';
  return ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier) ? `${cap(r.tier)} ${r.lp} LP` : `${cap(r.tier)} ${r.division} · ${r.lp} LP`;
}

function goalForm(o, hidden) {
  const g = o.plan.goal;
  const opt = (v, cur, text = v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${text}</option>`;
  return `<div id="goalformwrap" ${hidden ? 'hidden' : ''}><form id="goalform" class="row" style="margin-top:10px">
    <span class="muted">Reach</span>
    <select name="tier" aria-label="Tier">${o.tiers.map((t) => opt(t, g?.tier || 'GOLD', cap(t))).join('')}</select>
    <select name="division" aria-label="Division">${['IV', 'III', 'II', 'I'].map((d) => opt(d, g?.division || 'IV')).join('')}</select>
    <span class="muted">in</span>
    <select name="queue" aria-label="Queue">${opt('ranked_solo', g?.queue || 'ranked_solo', 'Solo/Duo')}${opt('ranked_flex', g?.queue, 'Flex')}</select>
    <button class="primary" type="submit">${g ? 'Update goal' : 'Set goal'}</button></form></div>`;
}

function goalCard(o) {
  const g = o.plan.goal;
  if (!g) {
    return `<section class="card"><h2>Rank goal</h2>
      <p class="muted" style="margin:0">Solo/Duo: <b>${esc(rankText(o.ranks.ranked_solo))}</b> · Flex: <b>${esc(rankText(o.ranks.ranked_flex))}</b>. Pick the rank you are working towards; the focuses below are how you get there.</p>
      ${goalForm(o, false)}</section>`;
  }
  return `<section class="card"><div class="row"><h2 style="margin:0">Rank goal · ${esc(queueLabel(g.queue))}</h2><span class="spacer"></span>
      <button id="goaledit" class="ghost small" type="button">Change</button></div>
    <div class="goal-ranks" style="margin-top:8px"><span>${esc(g.current || 'Unranked')}</span><span class="arrow">→</span><span>${esc(g.target)}</span></div>
    ${g.status === 'unranked' ? `<p class="muted">${esc(g.note)}</p>` : `
    <div class="bar" role="progressbar" aria-valuenow="${g.percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${g.percent}%"></i></div>
    <div class="row muted small"><span>${g.status === 'reached' ? '<b>Goal reached.</b> Set the next one.' : `<b>${fmt(g.lpToGo)} LP to go</b> (${g.divisionsToGo} division${g.divisionsToGo === 1 ? '' : 's'})`}</span>
      <span>· started at ${esc(g.started)} (${signed(g.lpGainedSinceSet)} LP since)</span>${g.paceNote ? `<span>· ${esc(g.paceNote)}</span>` : ''}</div>`}
    ${goalForm(o, true)}</section>`;
}

function chips(rows, size) {
  const cells = rows.map((r) => `<a class="chip ${r.pass ? 'pass' : 'fail'}" href="#/match/${esc(r.matchId)}" data-tip="${esc(`${day(r.start)} · ${r.champion} · ${r.win ? 'Win' : 'Loss'} · value ${r.value}`)}" aria-label="${r.pass ? 'pass' : 'miss'}">${r.pass ? '✓' : '✕'}</a>`);
  for (let i = rows.length; i < size; i++) cells.push('<span class="chip empty" aria-label="not played yet"></span>');
  return cells.join('');
}

function focusCard(f) {
  const s = f.scorecard;
  return `<article class="card focus"><div class="muted small">${esc(f.title)}</div>
    <div class="rule">${esc(f.rule)}</div>
    <div class="small"><b>Target:</b> ${esc(f.targetText)}${f.role || f.champion || f.queue ? ` <span class="muted">(${esc([f.champion, f.role, QUEUE[f.queue]].filter(Boolean).join(', '))} games)</span>` : ''}</div>
    <div class="chips"><span class="label">Since set</span>${chips(s.since.recent, f.targetWindow)}</div>
    <div class="small">${s.since.games ? `<b>${s.since.recent.filter((r) => r.pass).length} of ${s.since.recent.length}</b> so far` : 'No games since you set this.'}${s.achieved ? ' · <b>Target met</b>' : s.since.games ? ` · need ${f.targetHits} of ${f.targetWindow}` : ''}</div>
    ${s.before.games ? `<div class="chips"><span class="label">Before</span>${chips(s.before.recent, 0)}</div><div class="small muted">${s.before.hits} of ${s.before.games} in the games before you set it</div>` : ''}
    ${f.finding ? `<p class="small muted" style="margin:8px 0 0">${esc(f.finding)}</p>` : ''}
    <div class="row" style="margin-top:10px">${s.achieved ? `<button class="primary" data-id="${f.id}" data-status="achieved">Mark achieved</button>` : ''}
      <button class="ghost small" data-id="${f.id}" data-status="dropped">Drop</button></div></article>`;
}

function suggestCard(s, i) {
  return `<article class="card suggest"><h3>${esc(s.title)}</h3><p class="small muted" style="margin:0 0 6px">${esc(s.finding)}</p>
    <p class="small" style="margin:0 0 10px"><b>Rule:</b> ${esc(s.rule)}</p><button data-adopt="${i}" type="button">Adopt this focus</button></article>`;
}

function gamesTable(games) {
  const rows = games.map((g) => `<tr class="click" data-id="${esc(g.matchId)}"><td>${day(g.start)}</td><td>${esc(queueLabel(g.queue))}</td>
    <td>${g.remake ? '<span class="muted">Remake</span>' : `<span class="wl ${g.win ? 'w' : 'l'}">${g.win ? 'W' : 'L'}</span>`}</td>
    <td>${esc(g.champion)}</td><td>${esc(g.role || '–')}</td><td class="muted">${g.vs ? `vs ${esc(g.vs)}` : ''}</td>
    <td class="num">${esc(g.kda)}</td><td class="num">${fmt(g.csPerMin)}</td><td class="num">${fmt(g.earlyDeaths)}</td>
    <td class="num">${signed(g.goldDiffAt15)}</td><td class="num">${fmt(g.minutes)}m</td></tr>`).join('');
  return `<table><thead><tr><th>Date</th><th>Queue</th><th></th><th>Champion</th><th>Role</th><th></th><th class="num">K/D/A</th>
    <th class="num">CS/min</th><th class="num">Early deaths</th><th class="num">Gold @15</th><th class="num">Length</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small" style="margin:8px 0 0">Click a game to open its review. Gold @15 is your lead over your lane opponent.</p>`;
}

const TRENDS = [
  { label: 'Deaths before 14:00', key: 'earlyDeaths', metric: 'early_deaths' },
  { label: 'Deaths', key: 'deaths', metric: 'deaths' },
  { label: 'CS per minute', key: 'csPerMin', metric: 'cs_per_min' },
  { label: 'CS at 10:00', key: 'csAt10', metric: 'cs_at_10' },
  { label: 'Gold lead at 15:00', key: 'goldDiffAt15', metric: 'gold_diff_15' },
  { label: 'Control wards bought', key: 'controlWards', metric: 'control_wards' },
  { label: 'Vision score per minute', key: 'visionPerMin', metric: 'vision_per_min' },
  { label: 'Kill participation %', key: 'killParticipation', metric: 'kill_participation' },
];

function trendChart(el, o, trend) {
  const games = o.games.filter((g) => !g.remake && g[trend.key] !== null && g[trend.key] !== undefined).slice().reverse();
  if (games.length < 2) { el.innerHTML = '<p class="muted">Not enough games with this number yet.</p>'; return; }
  const W = 1040, H = 240, m = { l: 44, r: 16, t: 12, b: 26 };
  const vals = games.map((g) => g[trend.key]);
  const focus = o.plan.activeFocuses.find((f) => f.metric === trend.metric);
  let lo = Math.min(0, ...vals), hi = Math.max(...vals, focus ? focus.threshold : -Infinity);
  if (hi === lo) hi = lo + 1;
  const tk = ticks(lo, hi, 4); lo = Math.min(lo, tk[0]); hi = Math.max(hi, tk[tk.length - 1]);
  const x = (i) => m.l + ((W - m.l - m.r) * (i + 0.5)) / games.length;
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  const avg = vals.map((_, i) => { const w = vals.slice(Math.max(0, i - 4), i + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(trend.label)} per game">
    ${tk.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${kfmt(t)}</text>`).join('')}
    ${focus ? `<line x1="${m.l}" x2="${W - m.r}" y1="${y(focus.threshold)}" y2="${y(focus.threshold)}" stroke="var(--text-secondary)" stroke-dasharray="5 4"/>
      <text class="direct" x="${W - m.r}" y="${y(focus.threshold) - 6}" text-anchor="end" style="paint-order:stroke;stroke:var(--surface-1);stroke-width:5px">focus target: ${focus.op === '>=' ? 'at least' : 'at most'} ${focus.threshold}</text>` : ''}
    <polyline fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" points="${avg.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>
    ${games.map((g, i) => `<circle cx="${x(i)}" cy="${y(g[trend.key])}" r="5" fill="${g.win ? 'var(--text-primary)' : 'var(--surface-1)'}" stroke="var(--text-primary)" stroke-width="1.5"/>
      <rect data-i="${i}" x="${x(i) - (W - m.l - m.r) / games.length / 2}" y="${m.t}" width="${(W - m.l - m.r) / games.length}" height="${H - m.t - m.b}" fill="transparent"/>`).join('')}
    <text x="${m.l}" y="${H - 6}">${day(games[0].start)}</text><text x="${W - m.r}" y="${H - 6}" text-anchor="end">${day(games[games.length - 1].start)}</text></svg>`;
  el.querySelectorAll('rect[data-i]').forEach((r) => {
    const g = games[Number(r.dataset.i)];
    r.onmousemove = (ev) => showTip(`<b>${esc(g.champion)}</b> ${g.vs ? `vs ${esc(g.vs)}` : ''} · ${g.win ? 'Win' : 'Loss'}<br>${day(g.start)} · ${esc(queueLabel(g.queue))} · ${esc(g.kda)}<br>${esc(trend.label)}: <b>${fmt(g[trend.key])}</b><br><span class="muted">5-game average: ${fmt(Math.round(avg[Number(r.dataset.i)] * 10) / 10)}</span>`, ev);
    r.onmouseleave = hideTip;
    r.onclick = () => { location.hash = `#/match/${g.matchId}`; };
    r.style.cursor = 'pointer';
  });
}

// ---- game review --------------------------------------------------------------
async function review(id) {
  view.innerHTML = '<p class="muted pad">Loading the game…</p>';
  const r = await api(`/api/review?id=${encodeURIComponent(id)}`);
  const d = r.detail, tl = r.timeline;
  view.innerHTML = `
    <div class="row"><a href="#/" class="muted">← Dashboard</a></div>
    <section class="card"><div class="row"><span class="wl ${d.win ? 'w' : 'l'}">${d.win ? 'W' : 'L'}</span>
      <h1>${esc(d.champion)} ${esc(d.role || '')} ${d.vs ? `vs ${esc(d.vs)}` : ''}</h1><span class="spacer"></span>
      <span class="muted">${day(Date.parse(d.playedAt))} · ${esc(queueLabel(d.queue))} · ${fmt(d.durationMin)} min · patch ${esc(d.patch)}</span></div>
      <div class="row" style="margin-top:10px;gap:22px">${[['K/D/A', d.kda], ['Kill participation', `${d.killParticipation}%`], ['CS/min', d.csPerMin], ['Damage share', `${d.damageShare}%`],
        ['Vision score', d.visionScore], ['Control wards', d.controlWardsBought], ['Time dead', `${d.player.timeDeadPct}%`]]
        .map(([k, v]) => `<div><div class="muted small">${k}</div><div style="font-size:18px;font-weight:600">${esc(v)}</div></div>`).join('')}</div></section>
    <section class="card"><h2>Gold lead through the game</h2><div id="gold" class="chart"></div>
      <div class="legend"><span><i class="swatch" style="background:var(--series-1)"></i>You vs ${esc(d.vs || 'lane opponent')}</span>
        <span><i class="swatch" style="background:var(--series-2)"></i>Your team vs theirs</span>
        <span>✕ your death</span><span>● your kill or assist</span><span>▲ objective for your team</span><span>▼ objective for the enemy</span></div></section>
    <div class="grid2">
      <section class="card"><h2>Where you died</h2><div class="row" style="align-items:flex-start;flex-wrap:nowrap;gap:14px">
        <div class="mapwrap" id="map"></div></div>
        <ol class="deaths small" id="deathlist" style="margin-top:10px"></ol></section>
      <section class="card"><h2>Key moments</h2><div id="moments"></div>
        <p class="muted small">Open the replay in the League client at these times. The data cannot show health bars, cooldowns or minion waves.</p></section>
    </div>
    <section class="card"><h2>Build check <span class="muted small">· your choices against the most common ones in this matchup (OP.GG)</span></h2><div id="build"><p class="muted">Loading matchup data…</p></div></section>
    <section class="card"><h2>Scoreboard</h2><div class="tablewrap">${scoreboard(d)}</div></section>`;

  goldChart(document.getElementById('gold'), r);
  deathMap(document.getElementById('map'), document.getElementById('deathlist'), r);
  document.getElementById('moments').innerHTML = r.keyMoments.map((k) => `<div class="moment ${k.type === 'good-play' || k.type === 'swing-for' ? 'good' : 'bad'}">
    <div class="t">${esc(k.time)}</div><div><b>${esc(k.title)}</b></div><div class="small muted">${esc(k.detail)}</div></div>`).join('') || '<p class="muted">Nothing stood out in this game.</p>';
  api(`/api/matchup?id=${encodeURIComponent(id)}`).then((mu) => buildCheck(document.getElementById('build'), r, mu)).catch((e) => { document.getElementById('build').innerHTML = `<p class="muted">${esc(e.message)}</p>`; });
}

function goldChart(el, r) {
  const s = r.series, tl = r.timeline, hasLane = s.some((p) => p.goldDiff !== null);
  const W = 1040, H = 340, m = { l: 62, r: 120, t: 14, b: 76 };
  const all = s.flatMap((p) => [p.teamGoldDiff, hasLane ? p.goldDiff : 0]);
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const tk = ticks(lo, hi, 5); lo = Math.min(lo, tk[0]); hi = Math.max(hi, tk[tk.length - 1]);
  const last = s.length - 1;
  const x = (min) => m.l + ((W - m.l - m.r) * min) / last;
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  const line = (key) => s.map((p) => `${x(p.minute)},${y(p[key])}`).join(' ');
  const laneY = H - m.b + 32;
  const marks = [
    ...tl.objectives.map((o) => ({ ...o, kind: 'obj' })),
    ...tl.killsAndAssists.map((k) => ({ ...k, kind: 'ka' })),
    ...tl.deaths.map((dth) => ({ ...dth, kind: 'death' })),
  ].filter((e) => e.minute <= last);
  const markSvg = (e) => {
    const cx = x(e.minute);
    if (e.kind === 'death') return `<g stroke="var(--critical)" stroke-width="2.5" stroke-linecap="round"><line x1="${cx - 5}" y1="${laneY - 5}" x2="${cx + 5}" y2="${laneY + 5}"/><line x1="${cx - 5}" y1="${laneY + 5}" x2="${cx + 5}" y2="${laneY - 5}"/></g>`;
    if (e.kind === 'ka') return `<circle cx="${cx}" cy="${laneY + 14}" r="3.5" fill="var(--good)"/>`;
    const yy = laneY - 16, up = e.team === 'ally';
    return `<path d="M${cx - 5},${yy + (up ? 4 : -4)} L${cx + 5},${yy + (up ? 4 : -4)} L${cx},${yy + (up ? -5 : 5)} Z" fill="${up ? 'var(--good)' : 'var(--critical)'}"/>`;
  };
  const labelY = (key) => y(s[last][key]);
  let ly1 = hasLane ? labelY('goldDiff') : null, ly2 = labelY('teamGoldDiff');
  if (hasLane && Math.abs(ly1 - ly2) < 14) { if (ly1 < ly2) ly2 = ly1 + 14; else ly1 = ly2 + 14; }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gold lead per minute">
    ${tk.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? 'var(--axis)' : 'var(--grid)'}"/><text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${t > 0 ? '+' : ''}${kfmt(t)}</text>`).join('')}
    ${s.filter((p) => p.minute % 5 === 0).map((p) => `<text x="${x(p.minute)}" y="${H - 4}" text-anchor="middle">${p.minute}:00</text>`).join('')}
    <text x="${m.l - 6}" y="${laneY - 12}" text-anchor="end">objectives</text><text x="${m.l - 6}" y="${laneY + 4}" text-anchor="end">deaths</text><text x="${m.l - 6}" y="${laneY + 18}" text-anchor="end">kills</text>
    <polyline fill="none" stroke="var(--series-2)" stroke-width="2" stroke-linejoin="round" points="${line('teamGoldDiff')}"/>
    ${hasLane ? `<polyline fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" points="${line('goldDiff')}"/>` : ''}
    ${hasLane ? `<circle cx="${x(last)}" cy="${y(s[last].goldDiff)}" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/><text class="direct" x="${x(last) + 9}" y="${ly1 + 4}">You ${signed(s[last].goldDiff)}</text>` : ''}
    <circle cx="${x(last)}" cy="${y(s[last].teamGoldDiff)}" r="4" fill="var(--series-2)" stroke="var(--surface-1)" stroke-width="2"/><text class="direct" x="${x(last) + 9}" y="${ly2 + 4}">Team ${signed(s[last].teamGoldDiff)}</text>
    ${marks.map(markSvg).join('')}
    <line x1="${m.l}" x2="${W - m.r}" y1="${laneY + 24}" y2="${laneY + 24}" stroke="var(--grid)"/>
    <line id="cross" y1="${m.t}" y2="${laneY + 24}" stroke="var(--axis)" stroke-dasharray="3 3" visibility="hidden"/>
    <rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${laneY + 22 - m.t}" fill="transparent"/></svg>`;
  const svg = el.querySelector('svg'), cross = el.querySelector('#cross'), hit = el.querySelector('#hit');
  hit.onmousemove = (ev) => {
    const box = svg.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * W;
    const min = Math.max(0, Math.min(last, Math.round(((sx - m.l) / (W - m.l - m.r)) * last)));
    cross.setAttribute('x1', x(min)); cross.setAttribute('x2', x(min)); cross.setAttribute('visibility', 'visible');
    const p = s[min];
    const near = marks.filter((e) => e.minute >= min - 0.5 && e.minute < min + 0.5).sort((a, b) => a.minute - b.minute).map((e) =>
      e.kind === 'death' ? `✕ ${e.time} died to ${esc(e.killedBy)}${e.assistedBy.length ? ` +${e.assistedBy.length}` : ''}`
      : e.kind === 'ka' ? `● ${e.time} ${esc(e.type)} on ${esc(e.victim)}`
      : `${e.team === 'ally' ? '▲' : '▼'} ${e.time} ${e.team === 'ally' ? 'your team' : 'enemy'}: ${esc(e.objective)}`);
    showTip(`<b>${min}:00</b>${hasLane ? `<div class="tl"><span><i class="swatch" style="background:var(--series-1)"></i> You vs lane</span><b>${signed(p.goldDiff)}</b></div>` : ''}
      <div class="tl"><span><i class="swatch" style="background:var(--series-2)"></i> Team</span><b>${signed(p.teamGoldDiff)}</b></div>
      <div class="tl muted"><span>CS ${p.cs}${p.csDiff !== null ? ` (${signed(p.csDiff)})` : ''}</span><span>Level ${p.level}</span></div>${near.length ? `<hr style="border:0;border-top:1px solid var(--border)">${near.join('<br>')}` : ''}`, ev);
  };
  hit.onmouseleave = () => { hideTip(); cross.setAttribute('visibility', 'hidden'); };
}

function deathMap(el, list, r) {
  const size = r.mapSize, tl = r.timeline;
  const px = (v) => (100 * v) / size, py = (v) => 100 - (100 * v) / size;
  const img = r.ddragonVersion ? `<img alt="" src="https://ddragon.leagueoflegends.com/cdn/${esc(r.ddragonVersion)}/img/map/map11.png" onerror="this.remove()">` : '';
  const deaths = tl.deaths.filter((d) => d.x !== undefined);
  el.innerHTML = `${img}<svg viewBox="0 0 100 100" role="img" aria-label="Map of your deaths">
    ${tl.killsAndAssists.filter((k) => k.x !== undefined).map((k) => `<circle cx="${px(k.x)}" cy="${py(k.y)}" r="1.3" fill="var(--good)" stroke="#000" stroke-width=".3"/>`).join('')}
    ${deaths.map((d, i) => `<g data-d="${i}" style="cursor:default"><circle cx="${px(d.x)}" cy="${py(d.y)}" r="3.6" fill="var(--critical)" stroke="#fff" stroke-width=".6"/>
      <text x="${px(d.x)}" y="${py(d.y) + 1.3}" text-anchor="middle" style="fill:#fff;font-size:3.6px;font-weight:700">${i + 1}</text></g>`).join('')}</svg>`;
  const text = (d) => `<b>${esc(d.time)}</b> · ${esc(d.kind)} by ${esc(d.killedBy)}${d.assistedBy.length ? ` with ${esc(d.assistedBy.join(', '))}` : ''} · ${esc(d.zone || '')}${d.goldDiffVsLaner !== undefined ? ` <span class="muted">(you were ${signed(d.goldDiffVsLaner)} gold vs lane)</span>` : ''}`;
  list.innerHTML = deaths.map((d) => `<li>${text(d)}</li>`).join('') || '<p class="muted">No deaths. Clean game.</p>';
  el.querySelectorAll('g[data-d]').forEach((g) => {
    const d = deaths[Number(g.dataset.d)];
    g.onmousemove = (ev) => showTip(`Death ${Number(g.dataset.d) + 1}<br>${text(d)}`, ev);
    g.onmouseleave = hideTip;
  });
  el.insertAdjacentHTML('afterend', '');
  list.insertAdjacentHTML('beforebegin', '<div class="legend"><span><i class="swatch" style="background:var(--critical);height:10px;width:10px;border-radius:50%"></i>your deaths, numbered in order</span><span><i class="swatch" style="background:var(--good);height:8px;width:8px;border-radius:50%"></i>your kills and assists</span><span>your base is ' + (r.detail.side === 'blue' ? 'bottom-left' : 'top-right') + '</span></div>');
}

function buildCheck(el, r, mu) {
  if (!mu.available) { el.innerHTML = `<p class="muted">${esc(mu.reason)}</p>`; return; }
  const me = r.detail.player, tl = r.timeline;
  const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
  const mark = (ok) => (ok ? '' : ' <span class="diff">differs</span>');
  const myRunes = me.runes ? [me.runes.keystone, ...me.runes.primary] : [];
  const stdRunes = mu.runes ? [mu.runes.keystone, ...mu.runes.primary] : [];
  const finished = (me.items || []).filter((i) => !/Ward|Lens|Trinket|Potion|Doran|Boots$|Long Sword|Amplifying|Cloth Armor|Ruby Crystal|Dagger|Glowing Mote|Sapphire/.test(i));
  const std = mu.coreBuilds[0];
  const coreOverlap = std ? std.items.filter((i) => finished.includes(i)).length : 0;
  const order = tl.skillOrder.slice(0, mu.skillOrder.length || 15);
  const row = (label, mine, theirs) => `<div class="h">${label}</div><div>${mine}</div><div>${theirs}</div>`;
  el.innerHTML = `
    <p style="margin-top:0">${mu.headToHead ? `<b>${esc(mu.champion)}</b> wins <b>${mu.headToHead.winRate}%</b> of games against ${esc(mu.opponent)} (${fmt(mu.headToHead.games)} games). ` : ''}
      ${mu.laneAdvantage ? `Lane advantage: <b>${esc(mu.laneAdvantage === 'EVEN' ? 'even' : mu.laneAdvantage)}</b>. ` : ''}${mu.soloKillAdvantage ? `Solo-kill advantage: <b>${esc(mu.soloKillAdvantage === 'EVEN' ? 'even' : mu.soloKillAdvantage)}</b>.` : ''}</p>
    ${mu.tip ? `<p class="muted small">${esc(mu.tip)}</p>` : ''}
    <div class="kv">
      <div></div><div class="h">You</div><div class="h">Most common in this matchup</div>
      ${row('Runes', `${esc(myRunes.join(', ') || '–')}<br><span class="muted">${esc(me.runes?.secondaryTree || '')}: ${esc((me.runes?.secondary || []).join(', '))}</span>${mark(same(myRunes, stdRunes) && same(me.runes?.secondary, mu.runes?.secondary))}`,
        `${esc(stdRunes.join(', ') || '–')}<br><span class="muted">${esc(mu.runes?.secondaryTree || '')}: ${esc((mu.runes?.secondary || []).join(', '))}</span>${mu.runes ? `<br><span class="muted small">${mu.runes.winRate}% win rate over ${fmt(mu.runes.games)} games</span>` : ''}`)}
      ${row('Summoner spells', `${esc((me.summonerSpells || []).join(', '))}${mark(same(me.summonerSpells, mu.summonerSpells))}`, esc((mu.summonerSpells || []).join(', ')))}
      ${row('Skill order', `<code>${esc(order)}</code>${mark(!mu.skillOrder || order === mu.skillOrder.slice(0, order.length))}`, `<code>${esc(mu.skillOrder)}</code>`)}
      ${row('Items', `${esc(finished.join(', ') || '–')}${std ? (coreOverlap === std.items.length ? '' : ` <span class="diff">${coreOverlap} of ${std.items.length} core items</span>`) : ''}`,
        mu.coreBuilds.map((b) => `${esc(b.items.join(' → '))} <span class="muted small">${b.winRate}% over ${fmt(b.games)} games</span>`).join('<br>'))}
      ${mu.boots ? row('Boots', esc((me.items || []).find((i) => /Boots|Greaves|Shoes|Steelcaps|Treads|Swiftness|Lucidity/.test(i)) || '–'), `${esc(mu.boots.items.join(', '))} <span class="muted small">${mu.boots.pickRate}% pick</span>`) : ''}
    </div>
    <p class="muted small" style="margin-bottom:0">A difference is not automatically a mistake: a situational item that answers the enemy team can be right. Small samples are noisy.</p>`;
}

function scoreboard(d) {
  const maxDmg = Math.max(...d.teams.flatMap((t) => t.players.map((p) => p.damageToChamps)));
  const team = (t) => `<tr><th colspan="7">${t.isPlayersTeam ? 'Your team' : 'Enemy team'} · ${t.win ? 'Victory' : 'Defeat'} · ${t.kills} kills · ${fmt(t.gold)} gold · towers ${t.objectives.towers ?? 0} · dragons ${t.objectives.dragons ?? 0} · barons ${t.objectives.barons ?? 0}</th></tr>
    ${t.players.map((p) => `<tr class="${t.isPlayersTeam && p.champion === d.champion && p.role === d.role ? 'me' : ''}"><td>${esc(p.champion)}</td><td class="muted">${esc(p.role || '')}</td><td class="num">${esc(p.kda)}</td>
      <td class="num">${p.cs}</td><td class="num">${fmt(p.gold)}</td>
      <td style="min-width:150px"><div class="row" style="flex-wrap:nowrap;gap:6px"><div class="bar" style="flex:1;margin:0;height:6px"><i style="width:${(100 * p.damageToChamps) / maxDmg}%"></i></div><span class="small" style="min-width:46px;text-align:right">${fmt(p.damageToChamps)}</span></div></td>
      <td class="num">${p.visionScore}</td></tr>`).join('')}`;
  return `<table><thead><tr><th>Champion</th><th>Role</th><th class="num">K/D/A</th><th class="num">CS</th><th class="num">Gold</th><th>Damage to champions</th><th class="num">Vision</th></tr></thead>
    <tbody>${d.teams.slice().sort((a) => (a.isPlayersTeam ? -1 : 1)).map(team).join('')}</tbody></table>`;
}

// ---- routing and shared behaviour ---------------------------------------------
async function route(force) {
  hideTip();
  const m = location.hash.match(/^#\/match\/([A-Z0-9]+_\d+)$/);
  try { if (m) await review(m[1]); else await dashboard(force); } catch (err) { showError(err); }
  window.scrollTo(0, 0);
}
addEventListener('hashchange', () => route(false));
document.getElementById('refresh').onclick = () => { overview = null; route(true); };
document.addEventListener('mouseover', (ev) => { const t = ev.target.closest?.('[data-tip]'); if (t) showTip(esc(t.dataset.tip), ev); });
document.addEventListener('mouseout', (ev) => { if (ev.target.closest?.('[data-tip]')) hideTip(); });
route(false);
