// Compteur d'avis J-2 / J-1 / J — lit les avis réels via SerpApi (dates ISO)
const FICHES = require('./fiches.json');

const PLACES_KEY = process.env.PLACES_API_KEY;
const SERP_KEY = process.env.SERPAPI_KEY;

function parisDate(d) {
  // renvoie 'YYYY-MM-DD' en heure de Paris
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function findPlaceId(f) {
  const q = encodeURIComponent(f.q || f.name);
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id,name,user_ratings_total&locationbias=${encodeURIComponent(f.bias)}&language=fr&key=${PLACES_KEY}`;
  const r = await fetch(url); const j = await r.json();
  const c = j.candidates && j.candidates[0];
  return c ? { pid: c.place_id, gname: c.name, total: c.user_ratings_total ?? null } : null;
}

async function countRecent(placeId, days) {
  // pagine les avis triés du plus récent, s'arrête dès qu'on sort de la fenêtre
  const buckets = {}; for (const d of days) buckets[d] = 0;
  const cutoff = days[days.length - 1];
  let token = null, pages = 0, stop = false;
  while (!stop && pages < 5) {
    let url = `https://serpapi.com/search.json?engine=google_maps_reviews&place_id=${placeId}&sort_by=newestFirst&hl=fr&api_key=${SERP_KEY}`;
    if (token) url += `&next_page_token=${encodeURIComponent(token)}&num=20`;
    const r = await fetch(url); const j = await r.json();
    if (j.error) return { error: j.error, buckets };
    const revs = j.reviews || [];
    if (!revs.length) break;
    for (const rev of revs) {
      const iso = rev.iso_date || rev.iso_date_of_last_edit;
      if (!iso) continue;
      const day = parisDate(new Date(iso));
      if (day in buckets) buckets[day]++;
      else if (day < cutoff) { stop = true; break; }
    }
    token = j.serpapi_pagination && j.serpapi_pagination.next_page_token;
    if (!token) break;
    pages++;
  }
  return { buckets, pages: pages + 1 };
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const start = parseInt(p.start || '0', 10);
  const n = parseInt(p.n || '3', 10);
  const slice = FICHES.slice(start, start + n);

  const now = new Date();
  const days = [0, 1, 2].map(k => parisDate(new Date(now.getTime() - k * 86400000))); // [J, J-1, J-2]
  const daysAsc = [days[0], days[1], days[2]];

  const out = [];
  for (const f of slice) {
    try {
      const found = await findPlaceId(f);
      if (!found) { out.push({ name: f.name, city: f.city, link: f.link, error: 'fiche introuvable' }); continue; }
      const res = await countRecent(found.pid, [days[2], days[1], days[0]].sort());
      out.push({
        name: f.name, city: f.city, link: f.link, gname: found.gname, total: found.total,
        j2: res.buckets[days[2]] || 0, j1: res.buckets[days[1]] || 0, j0: res.buckets[days[0]] || 0,
        error: res.error || null
      });
    } catch (e) {
      out.push({ name: f.name, city: f.city, link: f.link, error: String(e).slice(0, 120) });
    }
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify({ days: { j0: days[0], j1: days[1], j2: days[2] }, count: FICHES.length, results: out })
  };
};
