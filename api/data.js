export const config = { runtime: 'edge' };

const HOSPITABLE = 'https://public.api.hospitable.com/v2';
const ASANA      = 'https://app.asana.com/api/1.0';
const BREVO      = 'https://api.brevo.com/v3';

// ── Auth check ────────────────────────────────────────────────────────────────
function isAuthed(req) {
  const cookies = req.headers.get('cookie') || '';
  const auth = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('dwellia_auth='));
  if (!auth) return false;
  return auth.split('=')[1] === process.env.COOKIE_SECRET;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function dateStr(d) { return d.toISOString().split('T')[0]; }
function daysAgo(n)   { const d = new Date(); d.setDate(d.getDate() - n); return dateStr(d); }
function daysAhead(n) { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); }

function sumRevenue(reservations, fromDate, propId) {
  return reservations
    .filter(r => {
      const inRange = r.check_in >= fromDate;
      const matchProp = !propId || String(r.property?.id) === String(propId);
      return inRange && matchProp;
    })
    .reduce((sum, r) => sum + (Number(r.total_price) || 0), 0);
}

// ── Fetchers ──────────────────────────────────────────────────────────────────
async function fetchHospitable(path, apiKey) {
  try {
    const res = await fetch(`${HOSPITABLE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      console.error(`Hospitable ${path} → ${res.status}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error('Hospitable fetch error:', e);
    return null;
  }
}

async function fetchAsana(projectId, apiKey) {
  try {
    const fields = 'name,assignee.name,due_on,completed';
    const res = await fetch(
      `${ASANA}/tasks?project=${projectId}&opt_fields=${fields}&limit=100`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) { console.error(`Asana ${projectId} → ${res.status}`); return { data: [] }; }
    return res.json();
  } catch (e) {
    console.error('Asana fetch error:', e);
    return { data: [] };
  }
}

async function fetchBrevo(apiKey) {
  try {
    const [campaigns, contacts] = await Promise.allSettled([
      fetch(`${BREVO}/emailCampaigns?status=sent&limit=3&sort=desc`, {
        headers: { 'api-key': apiKey }
      }).then(r => r.ok ? r.json() : null),
      fetch(`${BREVO}/contacts?limit=1`, {
        headers: { 'api-key': apiKey }
      }).then(r => r.ok ? r.json() : null),
    ]);
    return {
      campaigns: campaigns.status === 'fulfilled' ? campaigns.value : null,
      contacts:  contacts.status  === 'fulfilled' ? contacts.value  : null,
    };
  } catch (e) {
    return { campaigns: null, contacts: null };
  }
}

async function fetchHostBuddy(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (!isAuthed(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const HOSPITABLE_KEY  = process.env.HOSPITABLE_API_KEY;
  const DELTA_ID        = process.env.PROPERTY_DELTA_DAWN_ID;
  const LEGOBII_ID      = process.env.PROPERTY_LEGOBII_ID;
  const ASANA_KEY       = process.env.ASANA_API_KEY;
  const DELTA_PROJECT   = process.env.ASANA_PROJECT_DELTA_DAWN;
  const LEGOBII_PROJECT = process.env.ASANA_PROJECT_LEGOBII;
  const BREVO_KEY       = process.env.BREVO_API_KEY;
  const HB_URL          = process.env.HOSTBUDDY_ISSUES_URL;

  const today   = dateStr(new Date());
  const weekOut = daysAhead(7);

  // Fetch everything in parallel
  const [
    currentRes,
    calRes,
    revRes,
    deltaTasksRes,
    legobiTasksRes,
    brevoRes,
    hbRes,
  ] = await Promise.allSettled([
    fetchHospitable(`/reservations?status=current&limit=10`, HOSPITABLE_KEY),
    fetchHospitable(`/reservations?from=${today}&to=${daysAhead(62)}&limit=100`, HOSPITABLE_KEY),
    fetchHospitable(`/reservations?from=${daysAgo(90)}&to=${today}&limit=200`, HOSPITABLE_KEY),
    fetchAsana(DELTA_PROJECT, ASANA_KEY),
    fetchAsana(LEGOBII_PROJECT, ASANA_KEY),
    BREVO_KEY ? fetchBrevo(BREVO_KEY) : Promise.resolve(null),
    HB_URL ? fetchHostBuddy(HB_URL) : Promise.resolve([]),
  ]);

  const safe = s => s.status === 'fulfilled' ? s.value : null;

  const currentData  = safe(currentRes)?.data    || [];
  const calData      = safe(calRes)?.data         || [];
  const revData      = safe(revRes)?.data         || [];
  const deltaTasks   = safe(deltaTasksRes)?.data  || [];
  const legobiTasks  = safe(legobiTasksRes)?.data || [];
  const brevo        = safe(brevoRes) || {};
  const actionItems  = safe(hbRes) || [];

  // Debug: log what we got
  console.log(`[data] current: ${currentData.length}, cal: ${calData.length}, rev: ${revData.length}`);
  console.log(`[data] delta tasks: ${deltaTasks.length}, legobi tasks: ${legobiTasks.length}`);

  // ── Stays ─────────────────────────────────────────────────────────────────
  const currentDelta  = currentData.find(r => String(r.property?.id) === String(DELTA_ID));
  const currentLegobi = currentData.find(r => String(r.property?.id) === String(LEGOBII_ID));

  const upcoming    = calData.filter(r => r.check_in > today).sort((a,b) => a.check_in.localeCompare(b.check_in));
  const nextDelta   = upcoming.find(r => String(r.property?.id) === String(DELTA_ID));
  const nextLegobi  = upcoming.find(r => String(r.property?.id) === String(LEGOBII_ID));

  // ── Revenue ───────────────────────────────────────────────────────────────
  const rev30 = Math.round(sumRevenue(revData, daysAgo(30)));
  const rev60 = Math.round(sumRevenue(revData, daysAgo(60)));
  const rev90 = Math.round(sumRevenue(revData, daysAgo(90)));
  const revDD30 = Math.round(sumRevenue(revData, daysAgo(30), DELTA_ID));
  const revDD90 = Math.round(sumRevenue(revData, daysAgo(90), DELTA_ID));
  const revLG30 = Math.round(sumRevenue(revData, daysAgo(30), LEGOBII_ID));
  const revLG90 = Math.round(sumRevenue(revData, daysAgo(90), LEGOBII_ID));

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalNights    = revData.reduce((s, r) => s + (Number(r.nights) || 0), 0);
  const adr            = totalNights > 0 ? Math.round(rev90 / totalNights) : 0;
  const occupancyPct   = Math.round((totalNights / 180) * 100); // 2 props × 90 days
  const avgLos         = revData.length > 0 ? +(totalNights / revData.length).toFixed(1) : 0;
  const bookingWinDays = revData.length > 0
    ? Math.round(revData.reduce((s, r) => {
        if (!r.created_at || !r.check_in) return s;
        return s + (new Date(r.check_in) - new Date(r.created_at)) / 86400000;
      }, 0) / revData.length)
    : 0;

  // ── Source ────────────────────────────────────────────────────────────────
  const srcCounts = revData.reduce((acc, r) => {
    const src = (r.source || '').toLowerCase();
    const key = src.includes('airbnb') ? 'airbnb'
              : src.includes('vrbo') || src.includes('homeaway') ? 'vrbo'
              : 'direct';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const tb = revData.length || 1;
  const source = {
    direct: Math.round(((srcCounts.direct || 0) / tb) * 100),
    airbnb: Math.round(((srcCounts.airbnb || 0) / tb) * 100),
    vrbo:   Math.round(((srcCounts.vrbo   || 0) / tb) * 100),
  };

  // ── Tasks ─────────────────────────────────────────────────────────────────
  function processTasks(tasks, prop) {
    const incomplete = tasks.filter(t => !t.completed);
    return {
      total:    tasks.length,
      open:     incomplete.length,
      overdue:  incomplete.filter(t => t.due_on && t.due_on < today).map(t => ({ ...t, prop })),
      dueToday: incomplete.filter(t => t.due_on === today).map(t => ({ ...t, prop })),
      thisWeek: incomplete.filter(t => t.due_on > today && t.due_on <= weekOut).map(t => ({ ...t, prop })),
    };
  }
  const dt = processTasks(deltaTasks,  'delta');
  const lt = processTasks(legobiTasks, 'legobi');

  // ── Brevo ─────────────────────────────────────────────────────────────────
  const lastCamp = brevo.campaigns?.campaigns?.[0] || null;
  const brevoOut = {
    name:       lastCamp?.name || null,
    sentDate:   lastCamp?.sentDate || null,
    sent:       lastCamp?.statistics?.globalStats?.sent || 0,
    openRate:   lastCamp?.statistics?.globalStats?.openRate || 0,
    clickRate:  lastCamp?.statistics?.globalStats?.clickRate || 0,
    contacts:   brevo.contacts?.count || 0,
  };

  // ── Calendar booked dates ─────────────────────────────────────────────────
  const bookedDates = calData.flatMap(r => {
    const propId = String(r.property?.id);
    const prop   = propId === String(DELTA_ID) ? 'delta'
                 : propId === String(LEGOBII_ID) ? 'legobi' : null;
    if (!prop || !r.check_in || !r.check_out) return [];
    const dates = [];
    const d   = new Date(r.check_in + 'T00:00:00Z');
    const end = new Date(r.check_out + 'T00:00:00Z');
    while (d < end) {
      dates.push({ date: dateStr(d), prop });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return dates;
  });

  // ── Also include current stays in booked dates ────────────────────────────
  currentData.forEach(r => {
    const propId = String(r.property?.id);
    const prop   = propId === String(DELTA_ID) ? 'delta'
                 : propId === String(LEGOBII_ID) ? 'legobi' : null;
    if (!prop || !r.check_in || !r.check_out) return;
    const d   = new Date(r.check_in + 'T00:00:00Z');
    const end = new Date(r.check_out + 'T00:00:00Z');
    while (d < end) {
      const dateS = dateStr(d);
      if (!bookedDates.find(b => b.date === dateS && b.prop === prop)) {
        bookedDates.push({ date: dateS, prop });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  });

  return new Response(JSON.stringify({
    cachedAt: new Date().toISOString(),
    debug: {
      currentCount: currentData.length,
      calCount: calData.length,
      revCount: revData.length,
      deltaId: DELTA_ID,
      legobiId: LEGOBII_ID,
    },
    stays: { delta: currentDelta || null, legobi: currentLegobi || null, nextDelta: nextDelta || null, nextLegobi: nextLegobi || null },
    bookedDates,
    revenue: {
      thirtyDay: rev30, sixtyDay: rev60, ninetyDay: rev90,
      delta:  { thirtyDay: revDD30, ninetyDay: revDD90 },
      legobi: { thirtyDay: revLG30, ninetyDay: revLG90 },
    },
    kpis: { adr, revpar: Math.round(adr * (occupancyPct / 100)), occupancyPct, avgLos, bookingWindowDays: bookingWinDays, familiesServed: revData.length },
    source,
    tasks: {
      delta:  { total: dt.total,  open: dt.open,  overdue: dt.overdue,  dueToday: dt.dueToday,  thisWeek: dt.thisWeek  },
      legobi: { total: lt.total, open: lt.open, overdue: lt.overdue, dueToday: lt.dueToday, thisWeek: lt.thisWeek },
    },
    brevo: brevoOut,
    actionItems,
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
