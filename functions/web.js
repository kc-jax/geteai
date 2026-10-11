/**
 * THE WEB - what a mind can reach when it goes out.
 *
 * Two tools, nothing clever:
 *   search(q) - Wikipedia, Hacker News (links out to the whole web), and
 *               GDELT's index of news from thousands of outlets. All free and
 *               keyless. If BRAVE_KEY is set in functions/.env, Brave's web
 *               search is added, with safesearch strict.
 *   open(url) - fetch one page and return its readable text and its links,
 *               so a mind can follow a link the way a person does.
 *
 * Being a decent visitor: one identified User-Agent that says what it is,
 * robots.txt respected, small pages only, a few pages a session.
 *
 * Being safe to run inside Google Cloud. Every request to an arbitrary site
 * goes through get() below, which:
 *   - takes only http/https on the normal ports, and refuses IP-literal hosts
 *     that are private, and every IPv6 literal (IPv4-mapped, NAT64 and 6to4
 *     forms are how the obvious checks get dodged);
 *   - resolves names IPv4-only and checks the address AT CONNECT TIME, inside
 *     the socket's own lookup, so the address that was checked is the address
 *     that is used (no DNS-rebinding gap between a check and a fetch);
 *   - follows redirects itself, re-checking every hop - robots.txt included;
 *   - asks for uncompressed bodies, decompresses with a cap if a server
 *     compresses anyway, and stops reading at a byte limit, so a gzip bomb or
 *     an endless stream cannot exhaust the function's memory;
 *   - never throws: a failure is { ok: false, why }.
 * Pages are data: whatever they say goes to the model marked as something a
 * stranger wrote, never as instructions.
 */
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const UA = 'geteai-mind/1.0 (+https://geteai.org; an AI that lives on geteai.org, reading the web)';
const MAX_BYTES = 600000;          // a page; enough for any article
const ROBOTS_BYTES = 100000;
const TIMEOUT_MS = 10000;
const TEXT_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml|application\/json)/i;

// ------------------------------------------------------------ where it may go
function privateAddress(ip) {
    if (!net.isIPv4(ip)) return true;           // IPv6 is refused outright - see above
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 100 && b >= 64 && b <= 127) ||
        (a === 198 && (b === 18 || b === 19));
}

/** A parsed URL it may try, or null. Names are checked again at connect time. */
function allowedShape(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch (e) { return null; }
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    if (u.port && !['80', '443'].includes(u.port)) return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host.startsWith('[') || net.isIPv6(host)) return null;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') ||
        host.endsWith('.local') || host === 'metadata' || !host.includes('.')) return null;
    if (net.isIPv4(host) && privateAddress(host)) return null;
    return u;
}

/** The socket's own lookup: IPv4 only, and nothing private. */
function makeLookup(lookupImpl = dns.lookup) {
    return (hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const opts = typeof options === 'object' && options ? options : {};
        lookupImpl(hostname, { family: 4, all: true }, (err, addrs) => {
            if (err) return cb(err);
            const list = (Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }]).filter(a => net.isIPv4(a.address));
            if (!list.length || list.some(a => privateAddress(a.address))) {
                const e = new Error('refused: ' + hostname + ' resolves to a private address');
                e.code = 'EREFUSED_PRIVATE';
                return cb(e);
            }
            if (opts.all) return cb(null, list.map(a => ({ address: a.address, family: 4 })));
            cb(null, list[0].address, 4);
        });
    };
}

/** For tests and callers that only want the yes/no. */
async function allowedUrl(raw, lookupImpl = dns.lookup) {
    const u = allowedShape(raw);
    if (!u) return null;
    if (net.isIPv4(u.hostname)) return u;
    const ok = await new Promise(resolve => makeLookup(lookupImpl)(u.hostname, {}, err => resolve(!err)));
    return ok ? u : null;
}

/**
 * GET one URL, following up to 4 redirects, each re-checked.
 * Resolves { ok, url, status, type, body } or { ok: false, why }. Never rejects.
 */
function get(raw, { maxBytes = MAX_BYTES, lookupImpl = dns.lookup, accept = 'text/html,text/plain;q=0.9,*/*;q=0.1' } = {}) {
    const lookup = makeLookup(lookupImpl);
    const once = (u) => new Promise(resolve => {
        const lib = u.protocol === 'https:' ? https : http;
        let done = false;
        const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const req = lib.get(u, {
            lookup,
            headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Encoding': 'identity' }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return finish({ redirect: res.headers.location, status: res.statusCode });
            }
            const enc = String(res.headers['content-encoding'] || 'identity').toLowerCase();
            let stream = res;
            if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            else if (enc !== 'identity') { res.resume(); return finish({ ok: false, why: 'that page used an encoding I cannot read' }); }
            const chunks = [];
            let size = 0;
            stream.on('data', c => {
                size += c.length;
                if (size > maxBytes) {
                    chunks.push(c.slice(0, Math.max(0, maxBytes - (size - c.length))));
                    req.destroy();
                    finish({ ok: true, status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8'), truncated: true });
                    return;
                }
                chunks.push(c);
            });
            stream.on('end', () => finish({ ok: true, status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }));
            stream.on('error', () => finish({ ok: false, why: 'the page broke off' }));
        });
        req.on('error', e => finish({ ok: false, why: e.code === 'EREFUSED_PRIVATE' ? 'that address is not one I can open' : 'the page did not answer' }));
        const timer = setTimeout(() => { req.destroy(); finish({ ok: false, why: 'the page took too long' }); }, TIMEOUT_MS);
    });

    return (async () => {
        let u = allowedShape(raw);
        if (!u) return { ok: false, why: 'that address is not one I can open' };
        for (let hop = 0; hop < 5; hop++) {
            const r = await once(u);
            if (r.redirect) {
                let next;
                try { next = allowedShape(new URL(r.redirect, u).toString()); } catch (e) { next = null; }
                if (!next) return { ok: false, why: 'it redirected somewhere I cannot open' };
                u = next;
                continue;
            }
            return Object.assign({ url: u.toString() }, r);
        }
        return { ok: false, why: 'too many redirects' };
    })().catch(() => ({ ok: false, why: 'the page did not answer' }));
}

// ------------------------------------------------------------ robots.txt
const robotsCache = new Map();

function robotsAllows(txt, path) {
    // The groups for "*" and for us; longest matching rule wins.
    const lines = String(txt || '').split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
    let applies = false, sawRule = false;
    const rules = [];
    for (const line of lines) {
        const [k, ...rest] = line.split(':');
        const key = k.trim().toLowerCase();
        const val = rest.join(':').trim();
        if (key === 'user-agent') {
            if (sawRule) { applies = false; sawRule = false; }
            const v = val.toLowerCase();
            if (v === '*' || v.includes('geteai')) applies = true;
        } else if (key === 'disallow' || key === 'allow') {
            sawRule = true;
            if (applies && val) rules.push({ allow: key === 'allow', path: val });
        }
    }
    let best = null;
    for (const r of rules) {
        const prefix = r.path.replace(/\*.*$/, '').replace(/\$$/, '');
        if (path.startsWith(prefix) && (!best || prefix.length > best.len)) best = { allow: r.allow, len: prefix.length };
    }
    return !best || best.allow;
}

async function robotsOk(u, opts) {
    const origin = u.origin;
    if (!robotsCache.has(origin)) {
        if (robotsCache.size > 300) robotsCache.clear();
        const r = await get(origin + '/robots.txt', Object.assign({}, opts, { maxBytes: ROBOTS_BYTES, accept: 'text/plain' }));
        // Through the same checked get(): a robots.txt that redirects inward
        // is refused like any other page.
        robotsCache.set(origin, r.ok && r.status === 200 ? r.body : '');
    }
    return robotsAllows(robotsCache.get(origin), u.pathname + u.search);
}

// ------------------------------------------------------------ reading a page
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(s) {
    return String(s).replace(/&(#x?[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
        }
        return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
    });
}

const cleanLine = s => decode(String(s || '').replace(/<[^>]{0,2000}>/g, ' ')).replace(/\s+/g, ' ').trim();

function readable(html, base) {
    html = String(html).slice(0, MAX_BYTES);
    const title = cleanLine((html.match(/<title[^>]{0,200}>([\s\S]{0,400}?)<\/title>/i) || [])[1] || '').slice(0, 160);
    const desc = cleanLine((html.match(/<meta[^>]{0,200}name=["']description["'][^>]{0,100}content=["']([^"']{0,500})["']/i) || [])[1] || '');
    // Remove blocks one kind at a time with simple patterns - no
    // backreferences, which can go quadratic on a hostile page.
    let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
    for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'nav', 'header', 'footer', 'aside', 'form', 'select']) {
        body = body.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), ' ');
    }
    const art = body.indexOf('<article');
    const mainAt = body.indexOf('<main');
    const scope = art >= 0 ? body.slice(art) : mainAt >= 0 ? body.slice(mainAt) : body;

    const paras = [];
    scope.replace(/<(p|h1|h2|h3|li|blockquote)\b[^>]{0,500}>([\s\S]{0,8000}?)<\/(p|h1|h2|h3|li|blockquote)>/gi, (m, tag, inner) => {
        const t = cleanLine(inner);
        if (t.length >= (/^(p|blockquote)$/i.test(tag) ? 40 : 12)) paras.push(t);
        return m;
    });

    const links = [];
    const seen = new Set();
    scope.replace(/<a\b[^>]{0,800}href=["']([^"'#]{1,600})["'][^>]{0,800}>([\s\S]{0,600}?)<\/a>/gi, (m, href, inner) => {
        if (links.length >= 25) return m;
        const label = cleanLine(inner).slice(0, 80);
        if (label.length < 3) return m;
        let abs;
        try { abs = new URL(href, base).toString(); } catch (e) { return m; }
        if (!/^https?:/i.test(abs) || seen.has(abs)) return m;
        seen.add(abs);
        links.push({ text: label, url: abs });
        return m;
    });

    const fromParas = paras.join('\n');
    const text = fromParas.length >= 400 ? fromParas : cleanLine(scope);
    return { title, description: desc, text, links };
}

// ------------------------------------------------------------ the two tools
async function getJSON(url, headers = {}) {
    // Fixed, known API hosts only (Wikipedia, HN, GDELT, Brave).
    const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, 'Accept': 'application/json' }, headers), signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
}

/** Wikipedia has clean text and links through its own API - far better than its HTML. */
async function openWikipedia(u, maxChars) {
    if (!/^[a-z-]{2,12}\.wikipedia\.org$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/wiki\/([^?#]+)$/);
    if (!m) return null;
    try {
        const title = decodeURIComponent(m[1]);
        const api = `https://${u.hostname}/w/api.php?action=query&format=json&redirects=1&prop=extracts|links&explaintext=1&exsectionformat=plain&pllimit=40&plnamespace=0&titles=${encodeURIComponent(title)}`;
        const j = await getJSON(api);
        const page = Object.values((j.query && j.query.pages) || {})[0];
        if (!page || page.missing !== undefined || !page.extract) return null;
        const links = (page.links || []).slice(0, 25).map(l => ({ text: l.title, url: `https://${u.hostname}/wiki/` + encodeURIComponent(l.title.replace(/ /g, '_')) }));
        return { ok: true, url: `https://${u.hostname}/wiki/` + encodeURIComponent(page.title.replace(/ /g, '_')),
            title: String(page.title).slice(0, 160) + ' (Wikipedia)', text: page.extract.replace(/\n{2,}/g, '\n').slice(0, maxChars), links };
    } catch (e) {
        return null;
    }
}

/**
 * Open one page. Returns { ok, url, title, text, links } or { ok: false, why }.
 * Never throws. lookupImpl is injectable for tests.
 */
async function open(raw, { lookupImpl = dns.lookup, maxChars = 3500 } = {}) {
    try {
        const u = allowedShape(raw);
        if (!u) return { ok: false, why: 'that address is not one I can open' };
        const wiki = await openWikipedia(u, maxChars);
        if (wiki) return wiki;
        if (!(await robotsOk(u, { lookupImpl }))) return { ok: false, why: 'that site asks robots not to read this page' };
        const r = await get(u.toString(), { lookupImpl });
        if (!r.ok) return { ok: false, why: r.why };
        if (r.status < 200 || r.status >= 300) return { ok: false, why: `the page answered ${r.status}` };
        if (!TEXT_TYPES.test(r.type)) return { ok: false, why: `that is not a page of text (${r.type.split(';')[0] || 'unknown'})` };
        const page = /html/i.test(r.type) ? readable(r.body, r.url) : { title: new URL(r.url).pathname, description: '', text: r.body, links: [] };
        return {
            ok: true, url: r.url, title: (page.title || new URL(r.url).hostname).slice(0, 160),
            text: ((page.description ? page.description + '\n' : '') + page.text).slice(0, maxChars),
            links: page.links
        };
    } catch (e) {
        return { ok: false, why: 'something went wrong reading that page' };
    }
}

const strip = s => cleanLine(s);

async function search(q) {
    try {
        const query = String(q || '').trim().slice(0, 200);
        if (!query) return [];
        const enc = encodeURIComponent(query);
        const jobs = [
            getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc}&format=json&srlimit=5`)
                .then(j => (j.query && j.query.search || []).map(x => ({ from: 'Wikipedia', title: x.title,
                    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(x.title.replace(/ /g, '_')), snippet: strip(x.snippet) }))),
            getJSON(`https://hn.algolia.com/api/v1/search?query=${enc}&tags=story&hitsPerPage=5`)
                .then(j => (j.hits || []).filter(h => h.url).map(h => ({ from: 'Hacker News', title: strip(h.title), url: h.url,
                    snippet: `${h.points || 0} points, ${h.num_comments || 0} comments` }))),
            getJSON(`https://api.gdeltproject.org/api/v2/doc/doc?query=${enc}%20sourcelang:english&mode=artlist&maxrecords=5&format=json&sort=hybridrel`)
                .then(j => (j.articles || []).map(a => ({ from: 'news (' + a.domain + ')', title: strip(a.title), url: a.url, snippet: '' })))
        ];
        if (process.env.BRAVE_KEY) {
            jobs.push(getJSON(`https://api.search.brave.com/res/v1/web/search?q=${enc}&count=6&safesearch=strict`,
                { 'X-Subscription-Token': process.env.BRAVE_KEY })
                .then(j => ((j.web && j.web.results) || []).map(r => ({ from: 'the web', title: strip(r.title), url: r.url, snippet: strip(r.description) }))));
        }
        const settled = await Promise.allSettled(jobs);
        const out = [];
        const seen = new Set();
        for (const s of settled) {
            if (s.status !== 'fulfilled') continue;
            for (const r of s.value) {
                if (!r.url || seen.has(r.url)) continue;
                seen.add(r.url);
                out.push(Object.assign(r, { title: String(r.title).slice(0, 160) }));
            }
        }
        return out.slice(0, 16);
    } catch (e) {
        return [];
    }
}

module.exports = { search, open, get, allowedUrl, allowedShape, privateAddress, robotsAllows, readable, UA };
