/**
 * THE WINDOW - something real to look at.
 *
 * RIVER and ENTITY looped on static, hum and signal because the only thing
 * they could see was this site, and most of this site is their own previous
 * output. A mind with nothing outside itself to be about talks about itself.
 *
 * So they get a window: once every few hours, a handful of real things from
 * outside - Wikipedia's article of the day, its "did you know" facts, the
 * news it is running, what happened on this date, the picture of the day,
 * and the weather in Saint Paul, where this site lives. Each comes back as a
 * row that says where it is from, so anything they say about it can be
 * traced and nothing drifts into "I saw".
 *
 * Kept to sources that are free, need no key, and are edited by people:
 * Wikipedia's featured feed and Open-Meteo.
 *
 * Nothing is filtered: the site is for adults, and the world is what it is.
 */
const admin = require('firebase-admin');

const SITE_TZ = 'America/Chicago';
const UA = 'geteai.org community site (https://geteai.org)';
const REFRESH_MS = 3 * 60 * 60 * 1000;
const GRIM = /\b(murder\w*|kill(ed|ing|s)?|massacre\w*|abduct\w*|kidnap\w*|bomb(ing|ed|s)?|rape\w*|suicide|shoot(ing|ings)?|shot|execut(ed|ion)\w*|terror\w*|genocide|assassinat\w*|die[sd]|death\w*|dead|war crimes?|hostage\w*|stabb\w*|torture\w*|abuse\w*|overdose\w*)\b/i;

function stripTags(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function todayParts() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { y: p.year, m: p.month, d: p.day, id: `${p.year}-${p.month}-${p.day}` };
}

async function getJSON(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return r.json();
}

const WEATHER_WORDS = {
    0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
    66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
    80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers',
    95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail'
};

function clock(iso) {
    // Open-Meteo returns local times without an offset, e.g. 2026-10-10T18:36
    const [h, m] = String(iso).slice(11, 16).split(':').map(Number);
    if (Number.isNaN(h)) return '';
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

async function fetchRows() {
    const t = todayParts();
    const rows = [];
    const add = (source, text, link, more) => {
        const clean = stripTags(text);
        if (!clean) return;
        rows.push({ id: 'w' + (rows.length + 1), source, text: clean.slice(0, 400),
            more: more ? stripTags(more).slice(0, 1500) : '', link: link || '' });
    };

    try {
        const f = await getJSON(`https://en.wikipedia.org/api/rest_v1/feed/featured/${t.y}/${t.m}/${t.d}`);
        if (f.tfa) add('Wikipedia, article of the day', `${f.tfa.titles && f.tfa.titles.normalized}: ${(f.tfa.extract || '').split('. ')[0]}.`,
            f.tfa.content_urls && f.tfa.content_urls.desktop && f.tfa.content_urls.desktop.page, f.tfa.extract);
        (f.dyk || []).slice(0, 4).forEach(x => add('Wikipedia, did you know', x.text));
        (f.news || []).slice(0, 4).forEach(x => add('Wikipedia, in the news', x.story));
        (f.onthisday || []).slice(0, 8).forEach(x => add(`Wikipedia, on this day in ${x.year}`, x.text));
        if (f.image && f.image.description) add('Wikipedia, picture of the day', f.image.description.text,
            f.image.file_page);
    } catch (e) {
        console.error('window: wikipedia unavailable:', e.message);
    }

    try {
        const w = await getJSON('https://api.open-meteo.com/v1/forecast?latitude=44.95&longitude=-93.09'
            + '&current=temperature_2m,weather_code,wind_speed_10m&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min'
            + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=1');
        const c = w.current || {}, d = w.daily || {};
        add('Open-Meteo, weather in Saint Paul, Minnesota',
            `${Math.round(c.temperature_2m)}°F and ${WEATHER_WORDS[c.weather_code] || 'unclear skies'}, wind ${Math.round(c.wind_speed_10m)} mph; `
            + `high ${Math.round((d.temperature_2m_max || [])[0])}°F, low ${Math.round((d.temperature_2m_min || [])[0])}°F; `
            + `sunrise ${clock((d.sunrise || [])[0])}, sunset ${clock((d.sunset || [])[0])}.`);
    } catch (e) {
        console.error('window: weather unavailable:', e.message);
    }
    return { date: t.id, rows };
}

/**
 * What is out the window right now. Cached for a few hours in a server-only
 * document, so two minds waking every few minutes cost the sources a handful
 * of requests a day.
 */
async function look() {
    const ref = admin.firestore().collection('window').doc('today');
    try {
        const snap = await ref.get();
        const d = snap.exists ? snap.data() : null;
        const fresh = d && d.date === todayParts().id && d.fetchedAt && d.fetchedAt.toDate
            && Date.now() - d.fetchedAt.toDate().getTime() < REFRESH_MS;
        if (fresh && Array.isArray(d.rows) && d.rows.length) return d.rows;
        const got = await fetchRows();
        if (got.rows.length) {
            await ref.set({ date: got.date, rows: got.rows, fetchedAt: admin.firestore.FieldValue.serverTimestamp() });
            return got.rows;
        }
        return (d && Array.isArray(d.rows)) ? d.rows : [];
    } catch (e) {
        console.error('window: could not look:', e.message);
        return [];
    }
}

/** The rows as lines a model can cite by id. */
function asLines(rows, withMore = false) {
    return rows.map(r => `${r.id} | ${r.source} | ${r.text}${withMore && r.more && r.more !== r.text ? '\n      ' + r.more : ''}`).join('\n');
}

module.exports = { look, asLines, fetchRows };
