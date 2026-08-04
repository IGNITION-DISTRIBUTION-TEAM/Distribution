/* Shared date/format/chart helpers for the static telco-dashboard-web rebuild.
   Pairs with assets/spot-ci.css. Every page's inline <script> reuses these instead
   of re-deriving date math / Plotly boilerplate per page. */

const PALETTE = {
  hypermint: '#13f460', sonicBlue: '#2d40e9', ultraviolet: '#52bec0',
  highvolt: '#f44610', zeroWhite: '#12141a', surface1: '#ffffff', border: '#e3e5ea',
};
const CHART_PALETTE = [PALETTE.highvolt, PALETTE.hypermint, PALETTE.sonicBlue, PALETTE.ultraviolet, '#a0a0a0'];
const DAY_MS = 86400000;

function toDate(s) { return new Date(s + 'T00:00:00Z'); }
function dateStr(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }
function fmtDay(d) { return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }); }
function fmtDayName(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }); }
function fmtMonth(d) { return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', " '"); }
function fmtMonthLong(d) { return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function fmtWeek(d) { return "Wk " + fmtDay(d) + " '" + String(d.getUTCFullYear()).slice(2); }
function fmtNum(n) { return Math.round(n).toLocaleString('en-US'); }
function fmtPct(n, decimals) { return (n * 100).toFixed(decimals == null ? 1 : decimals) + '%'; }
function fmtCurrency(n) { return 'R' + fmtNum(n); }

function mondayOf(d) {
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow === 0 ? -6 : 1 - dow);
  return addDays(d, diff);
}
function monthStart(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }

function denseDateRange(dateStrs) {
  const dates = dateStrs.map(toDate).sort((a, b) => a - b);
  const min = dates[0], max = dates[dates.length - 1];
  const out = [];
  for (let t = min.getTime(); t <= max.getTime(); t += DAY_MS) out.push(new Date(t));
  return out;
}

function aggregateWeekly(series) {
  const buckets = {};
  series.forEach(({ date, value }) => {
    const wk = dateStr(mondayOf(date));
    buckets[wk] = (buckets[wk] || 0) + value;
  });
  return Object.keys(buckets).sort().map(k => ({ date: toDate(k), value: buckets[k] }));
}

function aggregateMonthly(series) {
  const buckets = {};
  series.forEach(({ date, value }) => {
    const m = dateStr(monthStart(date));
    buckets[m] = (buckets[m] || 0) + value;
  });
  return Object.keys(buckets).sort().map(k => ({ date: toDate(k), value: buckets[k] }));
}

function rollingAvg(series, window) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = series.slice(start, i + 1);
    const avg = slice.reduce((a, r) => a + r.value, 0) / slice.length;
    out.push({ date: series[i].date, value: series[i].value, rolling: Math.round(avg * 10) / 10 });
  }
  return out;
}

function baseLayout(title) {
  return {
    title: { text: title, font: { color: PALETTE.zeroWhite, size: 14 }, x: 0 },
    paper_bgcolor: PALETTE.surface1, plot_bgcolor: PALETTE.surface1,
    font: { color: '#888', size: 11 },
    margin: { l: 44, r: 8, t: 40, b: 36 },
    xaxis: { showgrid: false, linecolor: PALETTE.border, tickfont: { size: 10, color: '#888' } },
    yaxis: { showgrid: true, gridcolor: PALETTE.border, linecolor: 'rgba(0,0,0,0)', tickformat: ',' },
    bargap: 0.3,
  };
}
const PLOTLY_CFG = { displayModeBar: false, responsive: true };

function spotBar(elId, x, y, title, colour) {
  Plotly.newPlot(elId, [{
    x, y, type: 'bar', marker: { color: colour, line: { width: 0 } },
    hovertemplate: '%{x}<br><b>%{y:,}</b><extra></extra>',
  }], baseLayout(title), PLOTLY_CFG);
}

function spotMultiBar(elId, x, series, title) {
  // series: [{name, y, color}]
  const traces = series.map(s => ({
    x, y: s.y, type: 'bar', name: s.name,
    marker: { color: s.color, line: { width: 0 } },
    hovertemplate: '%{x}<br>' + s.name + ': <b>%{y:,}</b><extra></extra>',
  }));
  const layout = baseLayout(title);
  layout.barmode = 'group';
  layout.legend = { orientation: 'h', y: 1.14, font: { color: PALETTE.zeroWhite, size: 10 }, bgcolor: 'rgba(0,0,0,0)' };
  Plotly.newPlot(elId, traces, layout, PLOTLY_CFG);
}

function spotStackedBar(elId, x, series, title) {
  const traces = series.map(s => ({
    x, y: s.y, type: 'bar', name: s.name,
    marker: { color: s.color, line: { width: 0 } },
    hovertemplate: '%{x}<br>' + s.name + ': <b>%{y:,}</b><extra></extra>',
  }));
  const layout = baseLayout(title);
  layout.barmode = 'stack';
  layout.legend = { orientation: 'h', y: 1.14, font: { color: PALETTE.zeroWhite, size: 10 }, bgcolor: 'rgba(0,0,0,0)' };
  Plotly.newPlot(elId, traces, layout, PLOTLY_CFG);
}

function spotLine(elId, x, series, title) {
  const traces = series.map(s => ({
    x, y: s.y, type: 'scatter', mode: 'lines', name: s.name,
    line: { color: s.color, width: 2 },
    hovertemplate: '%{x}<br>' + s.name + ': <b>%{y:,}</b><extra></extra>',
  }));
  const layout = baseLayout(title);
  layout.hovermode = 'x unified';
  if (series.length > 1) {
    layout.legend = { orientation: 'h', y: 1.14, font: { color: PALETTE.zeroWhite, size: 10 }, bgcolor: 'rgba(0,0,0,0)' };
  }
  Plotly.newPlot(elId, traces, layout, PLOTLY_CFG);
}

function spotCombo(elId, x, barSeries, lineSeries, title) {
  const traces = [
    { x, y: barSeries.y, type: 'bar', name: barSeries.name, opacity: 0.7,
      marker: { color: barSeries.color, line: { width: 0 } },
      hovertemplate: '%{x}<br>' + barSeries.name + ': <b>%{y:,}</b><extra></extra>' },
    { x, y: lineSeries.y, type: 'scatter', mode: 'lines', name: lineSeries.name,
      line: { color: lineSeries.color, width: 2 },
      hovertemplate: '%{x}<br>' + lineSeries.name + ': <b>%{y:,.1f}</b><extra></extra>' },
  ];
  const layout = baseLayout(title);
  layout.legend = { orientation: 'h', y: 1.12, font: { color: PALETTE.zeroWhite, size: 11 }, bgcolor: 'rgba(0,0,0,0)' };
  layout.hovermode = 'x unified';
  Plotly.newPlot(elId, traces, layout, PLOTLY_CFG);
}

function spotDualAxis(elId, x, barSeries, lineSeries, title) {
  const traces = [
    { x, y: barSeries.y, type: 'bar', name: barSeries.name, yaxis: 'y',
      marker: { color: barSeries.color, line: { width: 0 } },
      hovertemplate: '%{x}<br><b>%{y:,}</b><extra></extra>' },
    { x, y: lineSeries.y, type: 'scatter', mode: 'lines+markers', name: lineSeries.name, yaxis: 'y2',
      line: { color: lineSeries.color, width: 2 }, marker: { size: 4 },
      hovertemplate: '%{x}<br><b>%{y:,.0f}</b><extra></extra>' },
  ];
  const layout = baseLayout(title);
  layout.yaxis.title = { text: barSeries.name, font: { color: barSeries.color, size: 11 } };
  layout.yaxis2 = { overlaying: 'y', side: 'right', showgrid: false,
    title: { text: lineSeries.name, font: { color: lineSeries.color, size: 11 } } };
  layout.legend = { orientation: 'h', y: 1.1, font: { color: PALETTE.zeroWhite, size: 11 }, bgcolor: 'rgba(0,0,0,0)' };
  Plotly.newPlot(elId, traces, layout, PLOTLY_CFG);
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function spotAreaLine(elId, x, y, title, colour) {
  Plotly.newPlot(elId, [{
    x, y, type: 'scatter', mode: 'lines+markers', line: { color: colour, width: 2 },
    fill: 'tozeroy', fillcolor: hexToRgba(colour, 0.1), marker: { color: colour, size: 5 },
    hovertemplate: '%{x}<br><b>%{y:,}</b><extra></extra>',
  }], baseLayout(title), PLOTLY_CFG);
}

function spotActivationCombo(elId, x, counts, pcts, title, showLegend) {
  const layout = baseLayout(title);
  layout.yaxis.title = { text: 'Activations', font: { color: PALETTE.sonicBlue, size: 11 } };
  layout.yaxis.tickfont = { color: PALETTE.sonicBlue };
  layout.yaxis2 = {
    title: { text: 'Active 1 %', font: { color: PALETTE.hypermint, size: 11 } },
    overlaying: 'y', side: 'right', showgrid: false, tickformat: '.0f',
    ticksuffix: '%', tickfont: { color: PALETTE.hypermint }, range: [0, 105],
  };
  layout.hovermode = 'x unified';
  if (showLegend !== false) {
    layout.legend = { orientation: 'h', y: 1.08, font: { color: PALETTE.zeroWhite, size: 11 }, bgcolor: 'rgba(0,0,0,0)' };
  } else {
    layout.showlegend = false;
  }
  Plotly.newPlot(elId, [
    { x, y: counts, type: 'bar', name: 'Daily Activations', yaxis: 'y1',
      marker: { color: PALETTE.sonicBlue, line: { width: 0 } },
      hovertemplate: '%{x}<br><b>Activations: %{y:,}</b><extra></extra>' },
    { x, y: pcts.map(p => Math.round(p * 1000) / 10), type: 'scatter', mode: 'lines+markers', name: 'Active 1 %', yaxis: 'y2',
      line: { color: PALETTE.hypermint, width: 2 }, marker: { size: 5, color: PALETTE.hypermint },
      hovertemplate: '%{x}<br><b>Active 1 %: %{y:.1f}%</b><extra></extra>' },
  ], layout, PLOTLY_CFG);
}

function spotPie(elId, labels, values, title) {
  Plotly.newPlot(elId, [{
    labels, values, type: 'pie', hole: 0.45,
    marker: { colors: CHART_PALETTE },
    textfont: { size: 11 },
    hovertemplate: '%{label}<br><b>%{value:,} (%{percent})</b><extra></extra>',
  }], {
    title: { text: title, font: { color: PALETTE.zeroWhite, size: 14 }, x: 0 },
    paper_bgcolor: PALETTE.surface1, plot_bgcolor: PALETTE.surface1,
    font: { color: '#888', size: 11 }, margin: { l: 8, r: 8, t: 40, b: 8 },
    legend: { orientation: 'h', y: -0.1, font: { color: PALETTE.zeroWhite, size: 11 }, bgcolor: 'rgba(0,0,0,0)' },
  }, PLOTLY_CFG);
}

function spotHBar(elId, y, x, title, colour) {
  Plotly.newPlot(elId, [{
    y, x, type: 'bar', orientation: 'h',
    marker: { color: colour, line: { width: 0 } },
    hovertemplate: '%{y}<br><b>%{x:,}</b><extra></extra>',
  }], {
    title: { text: title, font: { color: PALETTE.zeroWhite, size: 14 }, x: 0 },
    paper_bgcolor: PALETTE.surface1, plot_bgcolor: PALETTE.surface1,
    font: { color: '#888', size: 11 }, margin: { l: 8, r: 8, t: 40, b: 8 },
    xaxis: { showgrid: true, gridcolor: PALETTE.border, tickformat: ',' },
    yaxis: { showgrid: false, autorange: 'reversed' },
    bargap: 0.3,
  }, PLOTLY_CFG);
}

function renderKpiRow(elId, tiles) {
  // tiles: [{label, value, delta}] — delta optional (number, +/- rendered)
  document.getElementById(elId).innerHTML = tiles.map(t => {
    let deltaHtml = '';
    if (t.delta !== undefined && t.delta !== null) {
      const cls = t.delta >= 0 ? 'up' : 'down';
      const sign = t.delta >= 0 ? '+' : '';
      deltaHtml = `<div class="kpi-delta ${cls}">${sign}${fmtNum(t.delta)}</div>`;
    }
    return `<div class="kpi-tile"><div class="kpi-label">${t.label}</div>
      <div class="kpi-value">${t.value}</div>${deltaHtml}</div>`;
  }).join('');
}

function renderChips(elId, groups, onToggle) {
  const row = document.getElementById(elId);
  const selected = new Set();
  groups.forEach(g => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = g;
    chip.onclick = () => {
      if (selected.has(g)) { selected.delete(g); chip.classList.remove('active'); }
      else { selected.add(g); chip.classList.add('active'); }
      onToggle(selected);
    };
    row.appendChild(chip);
  });
  return selected;
}

function updateFilterNote(elId, selected) {
  const note = document.getElementById(elId);
  if (selected.size === 0) { note.textContent = ''; return; }
  const list = Array.from(selected);
  note.textContent = '⬟ Filtered: ' + list.slice(0, 3).join(', ') + (list.length > 3 ? '…' : '');
}

function renderLeagueTable(rows, accentColour, caption, valueLabel) {
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const body = rows.map((r, i) => {
    const rank = i + 1;
    const medal = medals[rank] || (rank + '.');
    return `<tr><td class="rank">${medal}</td><td>${r.label}</td>
      <td class="num" style="color:${accentColour}">${r.formatted != null ? r.formatted : fmtNum(r.value)}</td></tr>`;
  }).join('');
  return `
    <div>
      <div class="table-caption">${caption}</div>
      <table class="league">
        <thead><tr><th>#</th><th>Tenant</th><th class="num">${valueLabel || 'Activations'}</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// ── Subscription billing page — shared renderer for pages 14, 45-48 ─────────
function renderSubscriptionBillingPage(data) {
  const k = data.kpis;
  const pct = v => (v == null || isNaN(v)) ? '—' : fmtPct(v, 2);
  document.getElementById('kpiRow1').innerHTML = [
    { label: 'Subscription Book', value: fmtNum(k.book_size) },
    { label: 'FTC %', value: pct(k.ftc_pct) },
    { label: 'Month 2 %', value: pct(k.month2_pct) },
  ].map(t => `<div class="kpi-tile"><div class="kpi-label">${t.label}</div><div class="kpi-value">${t.value}</div></div>`).join('');

  if (data.monthly.length) {
    spotLine('monthlyTrend', data.monthly.map(r => fmtMonth(toDate(r.month))),
      [{ name: 'Sales', y: data.monthly.map(r => r.sales), color: PALETTE.hypermint }], 'Monthly trend of new sales');
  } else {
    document.getElementById('monthlyTrend').outerHTML = phBox('Monthly trend of new sales', 'No sales in window', 260);
  }
  if (data.daily.length) {
    spotLine('dailyTrend', data.daily.map(r => fmtDay(toDate(r.date))),
      [{ name: 'Sales', y: data.daily.map(r => r.sales), color: PALETTE.sonicBlue }], 'Daily trend of new sales');
  } else {
    document.getElementById('dailyTrend').outerHTML = phBox('Daily trend of new sales', 'No sales in last 30 days', 260);
  }

  if (data.collected.length) {
    const months = [...new Set(data.collected.map(r => r.month))].sort();
    const deals = [...new Set(data.collected.map(r => r.deal))];
    const series = deals.map((deal, i) => ({
      name: deal, color: CHART_PALETTE[i % CHART_PALETTE.length],
      y: months.map(m => (data.collected.find(r => r.month === m && r.deal === deal) || { billed: 0 }).billed),
    }));
    spotStackedBar('collectedChart', months.map(m => fmtMonth(toDate(m))), series, 'Collected book trend via card');
  } else {
    document.getElementById('collectedChart').outerHTML = phBox('Collected book trend via card', 'No billing data in window', 320);
  }

  document.getElementById('kpiRow2').innerHTML = [
    { label: 'Sales Yesterday', value: fmtNum(k.sales_yday) },
    { label: 'Sales MTD', value: fmtNum(k.sales_mtd) },
    { label: 'Sales L30 Days', value: fmtNum(k.sales_l30) },
    { label: 'L7 Day Avg', value: (k.sales_l7 / 7).toFixed(2) },
  ].map(t => `<div class="kpi-tile"><div class="kpi-label">${t.label}</div><div class="kpi-value">${t.value}</div></div>`).join('');

  document.getElementById('dealsYday').innerHTML = dealTableHtml(data.deals_yday);
  document.getElementById('dealsL30').innerHTML = dealTableHtml(data.deals_l30);
}

function phBox(title, msg, height) {
  return `<div class="placeholder-chart" style="height:${height}px;"><div class="p-title">${title}</div><div class="p-pending">${msg}</div></div>`;
}

function dealTableHtml(rows) {
  if (!rows.length) return '<p class="section-sub">No sales in this window.</p>';
  const body = rows.map(r => `<tr><td>${r.deal}</td><td class="num">${fmtNum(r.sales)}</td></tr>`).join('');
  return `<table class="league"><thead><tr><th>Product</th><th class="num">Sales</th></tr></thead><tbody>${body}</tbody></table>`;
}

// ── App subscription page — shared renderer for page 44 ─────────────────────
function renderAppSubscriptionPage(data) {
  const k = data.kpis;
  document.getElementById('kpiRow1').innerHTML = [
    { label: 'Active Registered App Users', value: fmtNum(k.active_users) },
    { label: 'Book Size', value: fmtNum(k.book_size) },
    { label: 'FTC %', value: k.ftc_pct ? fmtPct(k.ftc_pct, 2) : '—' },
  ].map(t => `<div class="kpi-tile"><div class="kpi-label">${t.label}</div><div class="kpi-value">${t.value}</div></div>`).join('');

  spotLine('monthlyTrend', data.monthly.map(r => fmtMonth(toDate(r.month))),
    [{ name: 'Sales', y: data.monthly.map(r => r.sales), color: PALETTE.hypermint }], 'Monthly trend of new sales from app');
  spotLine('dailyTrend', data.daily.map(r => fmtDay(toDate(r.date))),
    [{ name: 'Sales', y: data.daily.map(r => r.sales), color: PALETTE.sonicBlue }], 'Daily trend of new sales from app');

  if (data.deals_l30.length) {
    spotHBar('collectedChart', data.deals_l30.map(r => r.deal), data.deals_l30.map(r => r.sales),
      'Collected book trend via card', CHART_PALETTE[0]);
  } else {
    document.getElementById('collectedChart').outerHTML = phBox('Collected book trend via card', 'No data in window', 340);
  }

  document.getElementById('kpiRow2').innerHTML = [
    { label: 'Sales Yesterday', value: fmtNum(k.sales_yday) },
    { label: 'Sales MTD', value: fmtNum(k.sales_mtd) },
    { label: 'Sales L30 Days', value: fmtNum(k.sales_l30) },
    { label: 'L7 Day Avg', value: (k.sales_l7 / 7).toFixed(2) },
  ].map(t => `<div class="kpi-tile"><div class="kpi-label">${t.label}</div><div class="kpi-value">${t.value}</div></div>`).join('');

  document.getElementById('dealsYday').innerHTML = dealTableHtml(data.deals_yday);
  document.getElementById('dealsL30').innerHTML = dealTableHtml(data.deals_l30);
}

// ── Tenant scorecard — shared renderer for pages 03-10 ──────────────────────
function renderScorecard(data) {
  const monthly = data.monthly;
  const thisMonth = monthly.length ? monthly[monthly.length - 1].activations : 0;
  const lastMonth = monthly.length >= 2 ? monthly[monthly.length - 2].activations : 0;
  const q = data.quality;

  const kpis = [
    { label: 'This Month', value: fmtNum(thisMonth) },
    { label: 'Last Month', value: fmtNum(lastMonth), delta: thisMonth - lastMonth },
    { label: 'Active 1 %', value: q.active_1_pct != null ? fmtPct(q.active_1_pct) : '—' },
    { label: 'SIMs Never Used (35-60d)', value: fmtNum(q.sims_never_used || 0) },
  ];
  document.getElementById('kpiRow').innerHTML = kpis.map(t => {
    let deltaHtml = '';
    if (t.delta !== undefined) {
      const cls = t.delta >= 0 ? 'up' : 'down';
      deltaHtml = `<div class="kpi-delta ${cls}">${t.delta >= 0 ? '+' : ''}${fmtNum(t.delta)}</div>`;
    }
    return `<div class="kpi-tile"><div class="kpi-label">${t.label}</div><div class="kpi-value">${t.value}</div>${deltaHtml}</div>`;
  }).join('') +
  `<div class="placeholder-card"><div class="p-label">QOS 7-Day Avg</div><div class="p-dash">—</div><div class="p-source">Pending: <span>NEW QOS table</span></div></div>` +
  (data.ros_7day != null
    ? (() => {
        const atRisk = data.ros_7day < data.ros_threshold;
        return `<div class="kpi-tile"><div class="kpi-label">ROS 7-Day Avg</div><div class="kpi-value">${data.ros_7day.toFixed(2)}</div>
          <div class="kpi-delta ${atRisk ? 'down' : 'up'}">${atRisk ? 'Below threshold' : 'On target'}</div></div>`;
      })()
    : `<div class="placeholder-card"><div class="p-label">ROS 7-Day Avg</div><div class="p-dash">—</div><div class="p-source">Pending: <span>ROS_L7 DAYS SQL — not built for this tenant</span></div></div>`);

  if (data.wastage_rate != null) {
    const cost = (q.sims_never_used || 0) * data.wastage_rate + 6;
    document.getElementById('wastageRow').innerHTML =
      `<div class="kpi-tile" style="max-width:260px;"><div class="kpi-label">Cost of Wastage</div><div class="kpi-value">${fmtCurrency(cost)}</div></div>`;
  }

  if (data.daily.length) {
    const dates = data.daily.map(r => toDate(r.date));
    const dense = denseDateRange(data.daily.map(r => r.date));
    const byDate = {};
    data.daily.forEach(r => { byDate[r.date] = r.activations; });
    const series = dense.map(d => ({ date: d, value: byDate[dateStr(d)] || 0 }));
    const rolling = rollingAvg(series, 7);
    spotCombo('dailyChart', rolling.map(r => fmtDay(r.date)),
      { name: 'Daily Activations', y: rolling.map(r => r.value), color: PALETTE.sonicBlue },
      { name: '7-Day Avg', y: rolling.map(r => r.rolling), color: PALETTE.hypermint },
      `Daily Activations & 7-Day Rolling Avg — ${data.name} (90 Days)`);
  } else {
    document.getElementById('dailyChart').outerHTML =
      `<div class="placeholder-chart" style="height:310px;"><div class="p-title">Daily Activations — ${data.name}</div><div class="p-pending">No data yet</div></div>`;
  }

  if (monthly.length) {
    spotBar('monthlyChart', monthly.map(r => fmtMonth(toDate(r.month))), monthly.map(r => r.activations),
      `Monthly Activations — ${data.name} (13 Months)`, PALETTE.highvolt);
  }

  const storeRows = data.stores.map((r, i) => {
    const delta = r.this_month - r.last_month;
    return `<tr><td class="rank">${i + 1}</td><td>${r.tenant}</td>
      <td class="num" style="color:var(--hypermint);">${fmtNum(r.this_month)}</td>
      <td class="num" style="color:var(--sonic-blue);">${fmtNum(r.last_month)}</td>
      <td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>`;
  }).join('');
  document.getElementById('storeTable').innerHTML = data.stores.length ? `
    <table class="league">
      <thead><tr><th>#</th><th>Tenant</th><th class="num">This Month</th><th class="num">Last Month</th>
        <th class="num">QOS 7D Avg</th><th class="num">ROS 7D Avg</th><th class="num">Avg Vouchers</th></tr></thead>
      <tbody>${storeRows}</tbody>
    </table>` : '<p class="section-sub">No store data available for the current period.</p>';
}

// ── Activation/Utilisation grid — bar+line combo per tenant group, no legend ──
function renderActivationGrid(elId, groups, cols) {
  cols = cols || 2;
  const container = document.getElementById(elId);
  container.style.display = 'grid';
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  container.style.gap = '16px';
  groups.forEach((g, i) => {
    const chartId = `activation-grid-${i}`;
    const box = document.createElement('div');
    box.className = 'chart-box';
    box.style.height = '300px';
    box.id = chartId;
    container.appendChild(box);
    if (!g.daily.length) {
      box.classList.remove('chart-box');
      box.classList.add('placeholder-chart');
      box.innerHTML = `<div class="p-title">${g.label}</div><div class="p-pending">No activations in the last 30 days</div>`;
      return;
    }
    const x = g.daily.map(r => fmtDay(toDate(r.date)));
    spotActivationCombo(chartId, x, g.daily.map(r => r.activations), g.daily.map(r => r.active1_pct), g.label, false);
  });
}

// ── Placeholder page — for pages whose data source isn't available via MCP ──
function renderPlaceholderPage(config) {
  // config: {title, badge, kpis: [{label, source}], chartRows: [[{title, source, height}]], note}
  document.querySelector('.badge-pill.page-badge').textContent = config.badge;
  document.querySelector('h2.page-title').textContent = config.title;
  document.title = config.title + ' | Telco Retail';

  const body = document.getElementById('placeholderBody');
  let html = '';
  if (config.note) html += `<p class="note-banner">${config.note}</p>`;

  if (config.kpis && config.kpis.length) {
    html += `<div class="kpi-row" style="grid-template-columns:repeat(${config.kpis.length}, 1fr);">`;
    html += config.kpis.map(k => `
      <div class="placeholder-card">
        <div class="p-label">${k.label}</div>
        <div class="p-dash">—</div>
        <div class="p-source">Pending: <span>${k.source}</span></div>
      </div>`).join('');
    html += `</div>`;
  }

  (config.chartRows || []).forEach(row => {
    html += `<div class="grid-2" style="margin-bottom:16px; grid-template-columns:repeat(${row.length}, 1fr);">`;
    html += row.map(c => `
      <div class="placeholder-chart" style="height:${c.height || 300}px;">
        <div class="p-title">${c.title}</div>
        <div class="p-pending">Chart pending data access</div>
        <div class="p-source">Source: ${c.source}</div>
      </div>`).join('');
    html += `</div>`;
  });

  body.innerHTML = html;
}

// ── Tenant grouping — mirrors utils' map_tenant_group Python logic exactly ──
const DEFINED_GROUPS = [
  "Spar Retail", "Build It", "Midas", "Mica", "Fashion Fusion",
  "Progas", "Aheers", "The Unlimited", "Ladysmith Office National",
  "OnAir", "Pet Pool & Home", "Spot Mobile", "Spot Connect App & Digital",
];

function mapTenantGroup(name) {
  const nl = (name || '').toLowerCase();
  if (nl.includes('build it')) return 'Build It';
  if (nl.includes('midas') || nl.includes('kr motor spares') || nl.includes('aca auto parts') || nl.includes('aca autoparts')) return 'Midas';
  if (nl.includes('mica') || nl.includes('greenfields hardware')) return 'Mica';
  if (nl.includes('spargs') || nl.includes('savemor') || nl.includes('spar')) return 'Spar Retail';
  if (nl.includes('fashion')) return 'Fashion Fusion';
  if (nl.includes('progas')) return 'Progas';
  if (nl.includes('aheers')) return 'Aheers';
  if (nl === 'the unlimited') return 'The Unlimited';
  if (nl.includes('ladysmith office national')) return 'Ladysmith Office National';
  if (nl.includes('onair') || nl.includes('on air')) return 'OnAir';
  if (nl.includes('pet pool')) return 'Pet Pool & Home';
  if (nl === 'spot mobile') return 'Spot Mobile';
  if (nl.includes('uconnect app') || nl.includes('uconnect digital')) return 'Spot Connect App & Digital';
  return 'Other Tenants';
}
