export const config = { runtime: 'edge' };

const HOSPITABLE = 'https://public.api.hospitable.com/v2';
const ASANA      = 'https://app.asana.com/api/1.0';
const BREVO      = 'https://api.brevo.com/v3';

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

function daysAhead(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

function sumRevenue(reservations, fromDate, propId) {
  return reservations
    .filter(r => {
      const inRange = r.check_in >= fromDate;
      const matchProp = !propId || r.property?.id === propId;
      return inRange && matchProp;
    })
    .reduce((sum, r) => sum + (Number(r.total_price) || 0), 0);
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function fetchHospitable(path, env) {
  const res = await fetch(`${HOSPITABLE}${path}`, {
    headers: { Authorization: `Bearer ${env.HOSPITABLE_API_KEY}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchAsana(projectId, env) {
  const fields = 'name,assignee.name,due_on,completed,memberships.section.name';
  const res = await fetch(
    `${ASANA}/tasks?project=${projectId}&opt_fields=${fields}&limit=100`,
    { headers: { Authorization: `Bearer ${env.ASANA_API_KEY}` } }
  );
  if (!res.ok) return { data: [] };
  return res.json();
}

async function fetchBrevo(env) {
  const [campaigns, contacts] = await Promise.allSettled([
    fetch(`${BREVO}/emailCampaigns?status=sent&limit=3&sort=desc`, {
      headers: { 'api-key': env.BREVO_API_KEY }
    }).then(r => r.ok ? r.json() : null),
    fetch(`${BREVO}/contacts?limit=1`, {
      headers: { 'api-key': env.BREVO_API_KEY }
    }).then(r => r.ok ? r.json() : null),
  ]);
  return {
    campaigns: campaigns.status === 'fulfilled' ? campaigns.value : null,
    contacts:  contacts.status  === 'fulfilled' ? contacts.value  : null,
  };
}

async function fetchHostBuddy(env) {
  try {
    const res = await fetch(env.HOSTBUDDY_ISSUES_URL);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  const env = {
    HOSPITABLE_API_KEY:       process.env.HOSPITABLE_API_KEY,
    PROPERTY_DELTA_DAWN_ID:   process.env.PROPERTY_DELTA_DAWN_ID,
    PROPERTY_LEGOBII_ID:      process.env.PROPERTY_LEGOBII_ID,
    ASANA_API_KEY:            process.env.ASANA_API_KEY,
    ASANA_PROJECT_DELTA_DAWN: process.env.ASANA_PROJECT_DELTA_DAWN,
    ASANA_PROJECT_LEGOBII:    process.env.ASANA_PROJECT_LEGOBII,
    BREVO_API_KEY:            process.env.BREVO_API_KEY,
    HOSTBUDDY_ISSUES_URL:     process.env.HOSTBUDDY_ISSUES_URL,
  };

  const today   = dateStr(new Date());
  const weekOut = daysAhead(7);

  // Run everything in parallel
  const [
    currentRes,
    calendarRes,
    revenueRes,
    deltaRaw,
    legobiRaw,
    brevoData,
    hostbuddyData,
  ] = await Promise.allSettled([
    fetchHospitable(`/reservations?status=current&limit=10`, env),
    fetchHospitable(`/reservations?from=${today}&to=${daysAhead(62)}&limit=100`, env),
    fetchHospitable(`/reservations?from=${daysAgo(90)}&to=${today}&limit=200`, env),
    fetchAsana(env.ASANA_PROJECT_DELTA_DAWN, env),
    fetchAsana(env.ASANA_PROJECT_LEGOBII, env),
    fetchBrevo(env),
    fetchHostBuddy(env),
  ]);

  const safe = (settled) => settled.status === 'fulfilled' ? settled.value : null;

  const currentReservations = safe(currentRes)?.data  || [];
  const calendarData        = safe(calendarRes)?.data || [];
  const revenueData         = safe(revenueRes)?.data  || [];
  const deltaTasksRaw       = safe(deltaRaw)?.data    || [];
  const legobiTasksRaw      = safe(legobiRaw)?.data   || [];
  const brevo               = safe(brevoData) || {};
  const actionItems         = safe(hostbuddyData) || [];

  // ── Revenue ───────────────────────────────────────────────────────────────
  const rev30  = Math.round(sumRevenue(revenueData, daysAgo(30)));
  const rev60  = Math.round(sumRevenue(revenueData, daysAgo(60)));
  const rev90  = Math.round(sumRevenue(revenueData, daysAgo(90)));
  const revDD30  = Math.round(sumRevenue(revenueData, daysAgo(30), env.PROPERTY_DELTA_DAWN_ID));
  const revDD90  = Math.round(sumRevenue(revenueData, daysAgo(90), env.PROPERTY_DELTA_DAWN_ID));
  const revLG30  = Math.round(sumRevenue(revenueData, daysAgo(30), env.PROPERTY_LEGOBII_ID));
  const revLG90  = Math.round(sumRevenue(revenueData, daysAgo(90), env.PROPERTY_LEGOBII_ID));

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const totalNights = revenueData.reduce((s, r) => s + (Number(r.nights) || 0), 0);
  const adr         = totalNights > 0 ? Math.round(rev90 / totalNights) : 0;
  const possibleNights = 2 * 90; // 2 properties × 90 days
  const occupancyPct = Math.round((totalNights / possibleNights) * 100);
  const avgLos = revenueData.length > 0
    ? +(totalNights / revenueData.length).toFixed(1)
    : 0;
  const bookingWindowDays = revenueData.length > 0
    ? Math.round(
        revenueData.reduce((s, r) => {
          if (!r.created_at || !r.check_in) return s;
          const diff = (new Date(r.check_in) - new Date(r.created_at)) / (1000 * 60 * 60 * 24);
          return s + diff;
        }, 0) / revenueData.length
      )
    : 0;

  // ── Booking source ────────────────────────────────────────────────────────
  const sourceCounts = revenueData.reduce((acc, r) => {
    const src = (r.source || 'other').toLowerCase();
    const key = src.includes('airbnb') ? 'airbnb'
              : src.includes('vrbo') || src.includes('homeaway') ? 'vrbo'
              : src.includes('direct') || src === 'hospitable' ? 'direct'
              : 'other';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const totalBookings = revenueData.length || 1;
  const source = {
    direct: Math.round(((sourceCounts.direct || 0) / totalBookings) * 100),
    airbnb: Math.round(((sourceCounts.airbnb || 0) / totalBookings) * 100),
    vrbo:   Math.round(((sourceCounts.vrbo   || 0) / totalBookings) * 100),
  };

  // ── Tasks ─────────────────────────────────────────────────────────────────
  function processTasks(tasks, propLabel) {
    const incomplete = tasks.filter(t => !t.completed);
    return {
      total:     tasks.length,
      open:      incomplete.length,
      overdue:   incomplete.filter(t => t.due_on && t.due_on < today).map(t => ({ ...t, prop: propLabel })),
      dueToday:  incomplete.filter(t => t.due_on === today).map(t => ({ ...t, prop: propLabel })),
      thisWeek:  incomplete.filter(t => t.due_on && t.due_on > today && t.due_on <= weekOut).map(t => ({ ...t, prop: propLabel })),
    };
  }

  const deltaTasks  = processTasks(deltaTasksRaw, 'delta');
  const legobiTasks = processTasks(legobiTasksRaw, 'legobi');

  // ── Brevo ─────────────────────────────────────────────────────────────────
  const lastCampaign = brevo.campaigns?.campaigns?.[0] || null;
  const brevoOut = lastCampaign ? {
    name:        lastCampaign.name,
    sentDate:    lastCampaign.sentDate,
    sent:        lastCampaign.statistics?.globalStats?.sent       || 0,
    openRate:    lastCampaign.statistics?.globalStats?.openRate   || 0,
    clickRate:   lastCampaign.statistics?.globalStats?.clickRate  || 0,
    unsubscribed: lastCampaign.statistics?.globalStats?.unsubscribed || 0,
    contacts:    brevo.contacts?.count || 0,
  } : { contacts: brevo.contacts?.count || 0 };

  // ── Calendar: build booked date sets ─────────────────────────────────────
  // Returns arrays of {date, prop} for each booked night
  const bookedDates = calendarData.flatMap(r => {
    const prop = r.property?.id === env.PROPERTY_DELTA_DAWN_ID ? 'delta'
               : r.property?.id === env.PROPERTY_LEGOBII_ID    ? 'legobi'
               : null;
    if (!prop || !r.check_in || !r.check_out) return [];
    const dates = [];
    const d = new Date(r.check_in + 'T00:00:00Z');
    const end = new Date(r.check_out + 'T00:00:00Z');
    while (d < end) {
      dates.push({ date: dateStr(d), prop });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return dates;
  });

  // ── Upcoming stays ────────────────────────────────────────────────────────
  const upcoming = calendarData
    .filter(r => r.check_in > today)
    .sort((a, b) => a.check_in.localeCompare(b.check_in));

  const nextDelta  = upcoming.find(r => r.property?.id === env.PROPERTY_DELTA_DAWN_ID);
  const nextLegobi = upcoming.find(r => r.property?.id === env.PROPERTY_LEGOBII_ID);

  // ── Current stays ─────────────────────────────────────────────────────────
  const currentDelta  = currentReservations.find(r => r.property?.id === env.PROPERTY_DELTA_DAWN_ID);
  const currentLegobi = currentReservations.find(r => r.property?.id === env.PROPERTY_LEGOBII_ID);

  // ── Response ──────────────────────────────────────────────────────────────
  return new Response(JSON.stringify({
    cachedAt: new Date().toISOString(),
    stays: {
      delta:  currentDelta  || null,
      legobi: currentLegobi || null,
      nextDelta:  nextDelta  || null,
      nextLegobi: nextLegobi || null,
    },
    bookedDates,
    revenue: {
      thirtyDay: rev30,
      sixtyDay:  rev60,
      ninetyDay: rev90,
      delta:  { thirtyDay: revDD30, ninetyDay: revDD90 },
      legobi: { thirtyDay: revLG30, ninetyDay: revLG90 },
    },
    kpis: { adr, revpar: Math.round(adr * (occupancyPct / 100)), occupancyPct, avgLos, bookingWindowDays, familiesServed: totalBookings },
    source,
    tasks: {
      delta:  { total: deltaTasks.total,  open: deltaTasks.open,  overdue: deltaTasks.overdue,  dueToday: deltaTasks.dueToday,  thisWeek: deltaTasks.thisWeek  },
      legobi: { total: legobiTasks.total, open: legobiTasks.open, overdue: legobiTasks.overdue, dueToday: legobiTasks.dueToday, thisWeek: legobiTasks.thisWeek },
    },
    brevo: brevoOut,
    actionItems,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }
  });
}
