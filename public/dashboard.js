// dashboard.js — fetches /api/data and wires everything to the DOM

const REFRESH_MS = 15 * 60 * 1000; // 15 minutes

// ── Revenue toggle state ──────────────────────────────────────────────────────
let currentRevPeriod = 30;
let lastData = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateRange(checkIn, checkOut) {
  return `${fmtDate(checkIn)} – ${fmtDate(checkOut)}`;
}

function daysUntil(iso) {
  if (!iso) return null;
  const diff = Math.round((new Date(iso + 'T00:00:00') - new Date()) / 86400000);
  return diff;
}

function set(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function show(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = '';
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ── Render stays ──────────────────────────────────────────────────────────────

function renderStay(prefix, stay, nextStay, color) {
  const statusEl = document.getElementById(`${prefix}-status`);

  if (stay) {
    const d = daysUntil(stay.check_out);
    set(`${prefix}-dates`,  fmtDateRange(stay.check_in, stay.check_out));
    set(`${prefix}-guest`,  stay.guest?.name || stay.guest?.first_name || '—');
    set(`${prefix}-nights`, `${stay.nights || '—'} nights`);
    set(`${prefix}-out`,    d === 0 ? 'Checkout today' : d === 1 ? 'Out tomorrow' : `Out in ${d} days`);
    if (statusEl) {
      statusEl.className = 'badge green';
      statusEl.textContent = '● Occupied';
    }
  } else {
    set(`${prefix}-dates`,  'No current guest');
    set(`${prefix}-guest`,  '');
    set(`${prefix}-nights`, '');
    set(`${prefix}-out`,    '');
    if (statusEl) {
      statusEl.className = 'badge gray';
      statusEl.textContent = '○ Vacant';
    }
  }

  // Next stay
  if (nextStay) {
    set(`${prefix}-next-dates`, fmtDateRange(nextStay.check_in, nextStay.check_out));
    set(`${prefix}-next-guest`, nextStay.guest?.name || nextStay.guest?.first_name || '—');
    show(`${prefix}-next-block`);
  } else {
    hide(`${prefix}-next-block`);
  }
}

// ── Render revenue ────────────────────────────────────────────────────────────

function renderRevenue(data, period) {
  const rev = data.revenue;
  const total = period === 30 ? rev.thirtyDay : period === 60 ? rev.sixtyDay : rev.ninetyDay;
  const dd    = period === 30 ? rev.delta.thirtyDay  : rev.delta.ninetyDay;
  const lg    = period === 30 ? rev.legobi.thirtyDay : rev.legobi.ninetyDay;

  set('rv',  fmt(total));
  set('rdd', fmt(dd));
  set('rlg', fmt(lg));
}

// ── Render KPIs ───────────────────────────────────────────────────────────────

function renderKPIs(kpis) {
  set('kpi-adr',     `$${kpis.adr}`);
  set('kpi-revpar',  `$${kpis.revpar}`);
  set('kpi-occ',     `${kpis.occupancyPct}%`);
  set('kpi-los',     kpis.avgLos);
  set('kpi-window',  `${kpis.bookingWindowDays}d`);
  set('kpi-families', kpis.familiesServed);
}

// ── Render booking source ─────────────────────────────────────────────────────

function renderSource(source) {
  ['direct', 'airbnb', 'vrbo'].forEach(key => {
    const pct = source[key] || 0;
    const bar = document.getElementById(`src-${key}-bar`);
    const val = document.getElementById(`src-${key}-pct`);
    if (bar) bar.style.width = pct + '%';
    if (val) val.textContent = pct + '%';
  });
}

// ── Render calendar ───────────────────────────────────────────────────────────

function renderCalendar(bookedDates) {
  // Build lookup sets
  const deltaSet  = new Set(bookedDates.filter(b => b.prop === 'delta').map(b => b.date));
  const legobiSet = new Set(bookedDates.filter(b => b.prop === 'legobi').map(b => b.date));
  const todayStr  = new Date().toISOString().split('T')[0];

  document.querySelectorAll('.cal-d[data-date]').forEach(el => {
    const date = el.dataset.date;
    const prop = el.dataset.prop;
    if (!date || !prop) return;

    const booked = prop === 'delta' ? deltaSet.has(date) : legobiSet.has(date);
    const isToday = date === todayStr;

    el.className = 'cal-d';
    if (booked) el.classList.add(prop === 'delta' ? 'booked' : 'bookedoj');
    else el.classList.add('open');
    if (isToday) el.classList.add('today');
  });
}

// ── Render tasks ──────────────────────────────────────────────────────────────

function taskPropTag(prop) {
  return `<span class="tprop ${prop}">${prop === 'delta' ? 'Delta' : 'LeGobi'}</span>`;
}

function renderTaskList(containerId, tasks, cssClass) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!tasks || tasks.length === 0) {
    el.innerHTML = `<div class="task-empty">None ✓</div>`;
    return;
  }

  el.innerHTML = tasks.slice(0, 4).map(t => `
    <div class="task ${cssClass}">
      <div class="task-title">${t.name || 'Untitled'}</div>
      <div class="task-meta">
        <span>${t.assignee?.name || 'Unassigned'}${t.due_on ? ' · ' + fmtDate(t.due_on) : ''}</span>
        ${taskPropTag(t.prop)}
      </div>
    </div>
  `).join('');
}

function renderTasks(tasks) {
  const overdue  = [...tasks.delta.overdue,  ...tasks.legobi.overdue];
  const dueToday = [...tasks.delta.dueToday, ...tasks.legobi.dueToday];
  const thisWeek = [...tasks.delta.thisWeek, ...tasks.legobi.thisWeek];

  renderTaskList('tasks-overdue', overdue,  'overdue');
  renderTaskList('tasks-today',   dueToday, 'today');
  renderTaskList('tasks-week',    thisWeek, 'week');

  // Badges
  set('badge-overdue', overdue.length  || '0');
  set('badge-today',   dueToday.length || '0');
  set('badge-week',    thisWeek.length || '0');

  // Alert in header
  if (overdue.length > 0) {
    const alertEl = document.getElementById('header-alert');
    if (alertEl) {
      alertEl.style.display = 'flex';
      alertEl.querySelector('.alert-text').textContent =
        `${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}`;
    }
  } else {
    const alertEl = document.getElementById('header-alert');
    if (alertEl) alertEl.style.display = 'none';
  }

  // Summary line
  set('tasks-delta-summary',  `Delta: ${tasks.delta.open} open / ${tasks.delta.total} total`);
  set('tasks-legobi-summary', `LeGobi: ${tasks.legobi.open} open / ${tasks.legobi.total} total`);
}

// ── Render Brevo ──────────────────────────────────────────────────────────────

function renderBrevo(brevo) {
  if (brevo.name) {
    set('brevo-campaign', brevo.name);
    set('brevo-sent',     brevo.sent?.toLocaleString() || '—');
    set('brevo-open',     brevo.openRate  ? brevo.openRate.toFixed(1)  + '%' : '—');
    set('brevo-click',    brevo.clickRate ? brevo.clickRate.toFixed(1) + '%' : '—');
    set('brevo-unsub',    brevo.unsubscribed ?? '—');
    set('brevo-contacts', brevo.contacts?.toLocaleString() || '—');
    hide('brevo-no-api');
    show('brevo-stats');
  } else {
    set('brevo-contacts', brevo.contacts?.toLocaleString() || '—');
    hide('brevo-stats');
    show('brevo-no-api');
  }
}

// ── Render Action Items ───────────────────────────────────────────────────────

function renderActionItems(items) {
  const el = document.getElementById('action-items-list');
  if (!el) return;

  const list = Array.isArray(items) ? items : (items?.issues || []);
  if (list.length === 0) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-3);text-align:center;padding:14px 0">No open action items</div>`;
    return;
  }

  const icons = { MAINTENANCE: '🔧', SUPPLY: '📦', CLEANLINESS: '🧹', 'GUEST REQUESTS': '💬', OTHER: '📋' };

  el.innerHTML = list.slice(0, 5).map(item => {
    const isOpen = item.status === 'incomplete';
    const icon = icons[item.category?.toUpperCase()] || '📋';
    const prop = (item.property_name || '').includes('legob') ? 'legobi' : 'delta';
    const propLabel = prop === 'delta' ? 'Delta' : 'LeGobi';

    return `
      <div class="aitem">
        <div class="aitem-icon">${icon}</div>
        <div class="aitem-body">
          <div class="aitem-title">${item.item || 'Action item'}</div>
          <div class="aitem-meta">
            <span class="tprop ${prop}">${propLabel}</span>
            <span>${item.guest_name || ''}${item.created_at_utc ? ' · ' + fmtDate(item.created_at_utc.split('T')[0]) : ''}</span>
          </div>
        </div>
        <span class="badge ${isOpen ? 'amber' : 'green'}">${isOpen ? 'Open' : 'Resolved'}</span>
      </div>
    `;
  }).join('');
}

// ── Freshness indicator ───────────────────────────────────────────────────────

function updateFreshness() {
  const el = document.getElementById('last-updated');
  if (el) {
    el.textContent = `Updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
}

// ── Revenue toggle ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const tabsEl = document.getElementById('rev-tabs');
  if (tabsEl) {
    tabsEl.addEventListener('click', e => {
      e.stopPropagation();
      const tab = e.target.closest('.toggle');
      if (!tab) return;
      tabsEl.querySelectorAll('.toggle').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentRevPeriod = parseInt(tab.dataset.p);
      if (lastData) renderRevenue(lastData, currentRevPeriod);
    });
  }
});

// ── Main load ─────────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const res = await fetch('/api/data');
    if (res.status === 401 || res.status === 302) {
      window.location.href = '/login.html';
      return;
    }
    if (!res.ok) throw new Error(`API error ${res.status}`);

    const data = await res.json();
    lastData = data;

    renderStay('delta',  data.stays.delta,  data.stays.nextDelta,  'blue');
    renderStay('legobi', data.stays.legobi, data.stays.nextLegobi, 'orange');
    renderRevenue(data, currentRevPeriod);
    renderKPIs(data.kpis);
    renderSource(data.source);
    renderCalendar(data.bookedDates);
    renderTasks(data.tasks);
    renderBrevo(data.brevo);
    renderActionItems(data.actionItems);
    updateFreshness();

  } catch (err) {
    console.error('Dashboard data error:', err);
    // Leave existing content in place — don't blank out on error
  }
}

// Kick off on load, then refresh every 15 min
loadData();
setInterval(loadData, REFRESH_MS);
