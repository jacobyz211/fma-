// ─── Eclipse Music Addon (Cloudflare Workers) ────────────────────────────────
// Primary source:  Free Music Archive  (permanent MP3, Creative Commons)
// Stream fallback: MusicAPI            (YouTube/Spotify resolver for mainstream)
// Token-per-user URL system: /generate → /u/{token}/manifest.json
// author: jacob | version: 1.0.0

const FMA_BASE = 'https://freemusicarchive.org/api/get';
const UA       = 'Mozilla/5.0 (compatible; EclipseAddon/1.0)';

// ─── In-memory TTL cache (per isolate) ───────────────────────────────────────
const _cache = new Map();
function cGet(key) {
  const v = _cache.get(key);
  if (!v) return null;
  if (v.exp && v.exp < Date.now()) { _cache.delete(key); return null; }
  return v.val;
}
function cSet(key, val, ttlSec = 300) {
  _cache.set(key, { val, exp: Date.now() + ttlSec * 1000 });
  if (_cache.size > 3000) {
    let del = Math.floor(_cache.size * 0.2);
    for (const k of _cache.keys()) { if (del-- <= 0) break; _cache.delete(k); }
  }
}

// ─── In-flight deduplication ──────────────────────────────────────────────────
const _inflight = new Map();
async function dedupeCall(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ─── FMA helpers ──────────────────────────────────────────────────────────────
async function fmaGet(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const cacheKey = 'fma:' + endpoint + qs;
  const cached = cGet(cacheKey);
  if (cached) return cached;
  const url = `${FMA_BASE}/${endpoint}.json${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`FMA API ${r.status} on ${endpoint}`);
  const data = await r.json();
  cSet(cacheKey, data, 300);
  return data;
}

function fmaTrack(t) {
  if (!t || !t.track_id) return null;
  return {
    id:         `fma:track:${t.track_id}`,
    title:      t.track_title        || 'Unknown',
    artist:     t.artist_name        || 'Unknown',
    album:      t.album_title        || '',
    duration:   parseInt(t.track_duration) || 0,
    artworkURL: t.album_image_file   || t.artist_image_file || '',
    streamUrl:  t.track_file         || '',   // permanent MP3 — stored for direct stream use
    genre:      t.track_genres?.[0]?.genre_title || '',
    license:    t.license_title      || '',
    source:     'fma',
  };
}
function fmaAlbum(a) {
  if (!a || !a.album_id) return null;
  return {
    id: `fma:album:${a.album_id}`,
    title:      a.album_title       || 'Unknown',
    artist:     a.artist_name       || 'Unknown',
    artworkURL: a.album_image_file  || '',
    year:       (a.album_date_released || '').slice(0, 4),
    source:     'fma',
  };
}
function fmaArtist(a) {
  if (!a || !a.artist_id) return null;
  return {
    id: `fma:artist:${a.artist_id}`,
    name:       a.artist_name       || 'Unknown',
    artworkURL: a.artist_image_file || '',
    bio:        a.artist_bio        || '',
    source:     'fma',
  };
}

// ─── MusicAPI helpers ─────────────────────────────────────────────────────────
// Track IDs for MusicAPI results encode title+artist as base64url so we can
// resolve them back to a stream URL without storing state.
function encodeMapiId(title, artist) {
  const raw = JSON.stringify({ title, artist });
  const bytes = new TextEncoder().encode(raw);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeMapiId(id) {
  try {
    const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

async function mapiSearch(q, env) {
  const base = env?.MUSICAPI_BASE || 'https://musicapi.onrender.com';
  const cacheKey = 'mapi:search:' + q.toLowerCase();
  const cached = cGet(cacheKey);
  if (cached) return cached;
  const r = await fetch(`${base}/search?${new URLSearchParams({ q, limit: 20 })}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return [];
  const data = await r.json();
  const items = Array.isArray(data) ? data : (data.tracks || data.results || []);
  cSet(cacheKey, items, 300);
  return items;
}

async function mapiStreamUrl(title, artist, env) {
  const base = env?.MUSICAPI_BASE || 'https://musicapi.onrender.com';
  const cacheKey = `mapi:stream:${title}:${artist}`;
  const cached = cGet(cacheKey);
  if (cached) return cached;
  return dedupeCall(cacheKey, async () => {
    const q = artist ? `${artist} ${title}` : title;
    const r = await fetch(`${base}/stream?${new URLSearchParams({ q })}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data?.url) cSet(cacheKey, data, 1800);
    return data?.url ? data : null;
  });
}

function mapiTrack(item) {
  if (!item) return null;
  const title  = item.title  || item.name        || 'Unknown';
  const artist = item.artist || item.artist_name || '';
  return {
    id:         'mapi:' + encodeMapiId(title, artist),
    title,
    artist,
    album:      item.album     || '',
    duration:   item.duration  || 0,
    artworkURL: item.thumbnail || item.artwork || item.image || '',
    source:     'musicapi',
  };
}

// ─── Search ───────────────────────────────────────────────────────────────────
// Strategy:
//   1. Search FMA first (track_title, artist_name, album_title in parallel).
//   2. If FMA returns < 3 tracks, also search MusicAPI and merge results.
//      MusicAPI results are appended AFTER FMA results so FMA stays primary.
async function handleSearch(q, type = 'track', env) {
  if (!q) return { tracks: [], albums: [], artists: [] };

  if (type === 'album') {
    const d = await fmaGet('albums', { limit: 25, page: 1, album_title: q });
    return { tracks: [], albums: (d.dataset || []).map(fmaAlbum).filter(Boolean), artists: [] };
  }
  if (type === 'artist') {
    const d = await fmaGet('artists', { limit: 25, page: 1, artist_name: q });
    return { tracks: [], albums: [], artists: (d.dataset || []).map(fmaArtist).filter(Boolean) };
  }

  // Track search — FMA primary, MusicAPI fallback if FMA thin
  const [fmaByTitle, fmaByArtist] = await Promise.allSettled([
    fmaGet('tracks', { limit: 20, page: 1, track_title:  q }),
    fmaGet('tracks', { limit: 10, page: 1, artist_name:  q }),
  ]);

  const seenIds = new Set();
  const tracks  = [];
  const addFma  = t => { if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); } };

  if (fmaByTitle.status  === 'fulfilled') (fmaByTitle.value.dataset  || []).forEach(t => addFma(fmaTrack(t)));
  if (fmaByArtist.status === 'fulfilled') (fmaByArtist.value.dataset || []).forEach(t => addFma(fmaTrack(t)));

  // If FMA returned fewer than 3 tracks, supplement with MusicAPI results
  if (tracks.length < 3) {
    try {
      const mapiItems = await mapiSearch(q, env);
      for (const item of mapiItems.slice(0, 20)) {
        const t = mapiTrack(item);
        if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); }
      }
    } catch (e) { console.warn('[Search] MusicAPI fallback failed:', e.message); }
  }

  return { tracks: tracks.slice(0, 30), albums: [], artists: [] };
}

// ─── Stream ───────────────────────────────────────────────────────────────────
// FMA tracks: permanent MP3 URL stored in track metadata.
//   - If the track_file URL is known (came from a search), return it directly.
//   - Otherwise re-fetch from FMA API.
// MusicAPI tracks: call MusicAPI /stream endpoint.
// Unknown prefix: try FMA first, fall back to MusicAPI.
async function handleStream(rawId, env) {
  // ── FMA track ──
  if (rawId.startsWith('fma:track:')) {
    const id = rawId.replace('fma:track:', '');
    const cacheKey = 'fma:trackfile:' + id;
    const cached = cGet(cacheKey);
    if (cached) return cached;
    const d = await fmaGet('tracks', { track_id: id });
    const t = (d.dataset || [])[0];
    if (!t || !t.track_file) throw new Error(`FMA: no stream URL for track ${id}`);
    const result = { url: t.track_file, format: 'mp3', quality: '128kbps', source: 'fma', permanent: true };
    cSet(cacheKey, result, 86400); // permanent — cache 24h
    return result;
  }

  // ── MusicAPI track ──
  if (rawId.startsWith('mapi:')) {
    const encoded = rawId.replace(/^mapi:/, '');
    const meta = decodeMapiId(encoded);
    if (!meta) throw new Error(`Invalid MusicAPI track ID: ${rawId}`);
    const data = await mapiStreamUrl(meta.title, meta.artist, env);
    if (!data?.url) throw new Error(`MusicAPI: no stream for "${meta.title}" by "${meta.artist}"`);
    return { url: data.url, format: data.format || 'aac', quality: data.quality || 'high', source: 'musicapi', expiresAt: Math.floor(Date.now() / 1000) + 1800 };
  }

  // ── Unknown ID — try FMA then MusicAPI ──
  try {
    const d = await fmaGet('tracks', { track_id: rawId });
    const t = (d.dataset || [])[0];
    if (t?.track_file) return { url: t.track_file, format: 'mp3', quality: '128kbps', source: 'fma', permanent: true };
  } catch {}

  throw new Error(`Stream not found for ID: ${rawId}`);
}

// ─── Album / Artist / Genres ──────────────────────────────────────────────────
async function handleAlbum(rawId) {
  const id = rawId.replace('fma:album:', '');
  const [albumD, tracksD] = await Promise.all([
    fmaGet('albums', { album_id: id }),
    fmaGet('tracks', { album_id: id, limit: 50 }),
  ]);
  const album  = fmaAlbum((albumD.dataset  || [])[0]) || { id: rawId, title: 'Album', artist: '' };
  const tracks = (tracksD.dataset || []).map(fmaTrack).filter(Boolean);
  return { ...album, trackCount: tracks.length, tracks };
}

async function handleArtist(rawId) {
  const id = rawId.replace('fma:artist:', '');
  const [artistD, tracksD, albumsD] = await Promise.all([
    fmaGet('artists', { artist_id: id }),
    fmaGet('tracks',  { artist_id: id, limit: 20 }),
    fmaGet('albums',  { artist_id: id, limit: 10 }),
  ]);
  const artist = fmaArtist((artistD.dataset || [])[0]) || { id: rawId, name: 'Artist' };
  return { ...artist, topTracks: (tracksD.dataset || []).map(fmaTrack).filter(Boolean), albums: (albumsD.dataset || []).map(fmaAlbum).filter(Boolean) };
}

async function handleGenres() {
  const d = await fmaGet('genres', { limit: 100 });
  return (d.dataset || []).map(g => ({ id: `fma:genre:${g.genre_id}`, title: g.genre_title, parent: g.genre_parent_id }));
}

async function handleGenre(rawId, page = 1) {
  const id = rawId.replace('fma:genre:', '');
  const d  = await fmaGet('tracks', { genre_id: id, limit: 25, page });
  return { tracks: (d.dataset || []).map(fmaTrack).filter(Boolean), page, total: d.total || 0 };
}

// ─── Token helpers ────────────────────────────────────────────────────────────
function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
function isValidToken(t) { return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t); }
function parseTokenPath(p) {
  const m = p.match(/^\/u\/([a-f0-9]{28})(\/.*)?$/);
  return m ? { token: m[1], rest: m[2] || '/' } : null;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
function buildManifest() {
  return {
    id:          'com.jacob.eclipse-music',
    name:        'Eclipse Music',
    version:     '1.0.0',
    description: 'Free Music Archive (primary) + MusicAPI fallback. FMA streams are permanent MP3s. MusicAPI resolves mainstream tracks FMA does not carry.',
    icon:        'https://freemusicarchive.org/img/fma-favicon.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist'],
    contentType: 'music',
  };
}

// ─── Route dispatcher ─────────────────────────────────────────────────────────
async function handleRoute(rest, url, env) {
  const q    = url.searchParams.get('q') || '';
  const type = url.searchParams.get('type') || 'track';
  const page = parseInt(url.searchParams.get('page')) || 1;
  if (rest === '/manifest.json' || rest === '/manifest') return buildManifest();
  if (rest === '/search')           return handleSearch(q, type, env);
  if (rest === '/genres')           return handleGenres();
  if (rest.startsWith('/stream/'))  return handleStream(rest.replace('/stream/', ''), env);
  if (rest.startsWith('/album/'))   return handleAlbum(rest.replace('/album/', ''));
  if (rest.startsWith('/artist/'))  return handleArtist(rest.replace('/artist/', ''));
  if (rest.startsWith('/genre/'))   return handleGenre(rest.replace('/genre/', ''), page);
  return null;
}

// ─── Response helpers ─────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control':                'no-store',
};
function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}
function htmlRes(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function buildPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eclipse Music Addon</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}
.card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}
h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}
h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}
p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}
.tip{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}
.tip b{color:#ccc}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#181818;color:#aaa;border:1px solid #2a2a2a}
.pill.gr{background:#0a1a0a;color:#4eba4e;border-color:#1a3a1a}
.pill.or{background:#1a0e00;color:#ff9422;border-color:#3a2200}
.pill.bl{background:#0d1520;color:#4a9eff;border-color:#1a3050}
.pill.pu{background:#12091a;color:#b97eff;border-color:#2e1a50}
.sources{display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
.src{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px}
.src-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.src-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px}
.src-badge.primary{background:#1a0e00;color:#ff9422;border:1px solid #3a2200}
.src-badge.fallback{background:#0d1520;color:#4a9eff;border:1px solid #1a3050}
.src-name{font-size:13px;font-weight:600;color:#ccc}
.src-desc{font-size:12px;color:#555;line-height:1.6}
input{width:100%;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;color:#e0e0e0;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}
input:focus{border-color:#fff}input::placeholder{color:#2e2e2e}
.hint{font-size:12px;color:#3a3a3a;margin-bottom:12px;line-height:1.7}
button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:6px;transition:background .15s}
.bw{background:#fff;color:#000}.bw:hover{background:#e0e0e0}.bw:disabled{background:#1e1e1e;color:#333;cursor:not-allowed}
.bg{background:#141414;color:#e0e0e0;border:1px solid #2a2a2a}.bg:hover{background:#1e1e1e}.bg:disabled{background:#0f0f0f;color:#333;cursor:not-allowed}
.bd{background:#0f0f0f;color:#777;border:1px solid #1a1a1a;font-size:13px;padding:10px}.bd:hover{background:#1a1a1a;color:#fff}
.box{display:none;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:18px;margin-bottom:10px}
.blbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.burl{font-size:12px;color:#fff;word-break:break-all;font-family:'SF Mono','Fira Code',monospace;margin-bottom:14px;line-height:1.5}
hr{border:none;border-top:1px solid #161616;margin:24px 0}
.steps{display:flex;flex-direction:column;gap:12px}
.step{display:flex;gap:12px;align-items:flex-start}
.sn{background:#161616;border:1px solid #222;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}
.st{font-size:13px;color:#555;line-height:1.6}.st b{color:#999}
.warn{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#555;line-height:1.7}
footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}
</style>
</head>
<body>
<div class="card">
  <svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px" aria-label="Eclipse Music">
    <circle cx="26" cy="26" r="26" fill="#111"/>
    <circle cx="26" cy="26" r="18" stroke="#ff9422" stroke-width="2" fill="none"/>
    <circle cx="26" cy="26" r="8" fill="#ff9422" opacity="0.15"/>
    <path d="M20 22 L20 30 L28 26 Z" fill="#ff9422"/>
    <circle cx="34" cy="18" r="5" fill="#4a9eff" opacity="0.7"/>
    <path d="M32 18 L34 16 L36 18" stroke="#4a9eff" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  </svg>
  <h1>Eclipse Music Addon</h1>
  <p class="sub">One addon, two sources. FMA for free &amp; licensed music, MusicAPI as fallback for mainstream tracks.</p>
  <div class="tip"><b>Save your URL.</b> Paste it below any time to copy it again without reinstalling.</div>

  <div class="sources">
    <div class="src">
      <div class="src-head">
        <span class="src-badge primary">Primary</span>
        <span class="src-name">Free Music Archive</span>
      </div>
      <div class="src-desc">Thousands of free, Creative Commons licensed tracks with permanent MP3 URLs that never expire.</div>
    </div>
    <div class="src">
      <div class="src-head">
        <span class="src-badge fallback">Fallback</span>
        <span class="src-name">MusicAPI</span>
      </div>
      <div class="src-desc">Resolves mainstream tracks via YouTube &amp; Spotify when FMA has fewer than 3 results for a search.</div>
    </div>
  </div>

  <div class="pills">
    <span class="pill">Tracks &middot; Albums &middot; Artists</span>
    <span class="pill or">Permanent MP3</span>
    <span class="pill gr">Creative Commons</span>
    <span class="pill bl">YT + Spotify Resolver</span>
    <span class="pill">Genre Browse</span>
  </div>

  <button class="bw" id="genBtn" onclick="generate()">Generate My Addon URL</button>
  <div class="box" id="genBox">
    <div class="blbl">Your addon URL — paste into Eclipse</div>
    <div class="burl" id="genUrl"></div>
    <button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button>
  </div>
  <hr>
  <h2>Refresh existing URL</h2>
  <input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">
  <div class="hint">Keeps the same token — nothing to reinstall in Eclipse.</div>
  <button class="bg" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>
  <div class="box" id="refBox">
    <div class="blbl">Refreshed — same URL still works in Eclipse</div>
    <div class="burl" id="refUrl"></div>
    <button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button>
  </div>
  <hr>
  <div class="steps">
    <div class="step"><div class="sn">1</div><div class="st">Click <b>Generate My Addon URL</b> above</div></div>
    <div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>
    <div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>
    <div class="step"><div class="sn">4</div><div class="st">FMA results appear first. MusicAPI fills in mainstream tracks when FMA comes up short.</div></div>
  </div>
  <div class="warn">Endpoints: <code>search</code> · <code>stream/:id</code> · <code>album/:id</code> · <code>artist/:id</code> · <code>genres</code> · <code>genre/:id</code><br>FMA stream URLs are permanent. MusicAPI URLs cached 30 min. Set <code>MUSICAPI_BASE</code> var to use a self-hosted instance.</div>
</div>
<footer>Eclipse Music Addon v1.0.0 · by jacob · Cloudflare Workers</footer>
<script>
var gu=null,ru=null;
function generate(){
  var btn=document.getElementById('genBtn');btn.disabled=true;btn.textContent='Generating...';
  fetch('/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    .then(function(r){return r.json()}).then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Generate My Addon URL';return;}
      gu=d.manifestUrl;document.getElementById('genUrl').textContent=gu;
      document.getElementById('genBox').style.display='block';
      btn.disabled=false;btn.textContent='Generate New URL';
    }).catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Generate My Addon URL'});
}
function copyGen(){if(gu)copyText(gu,document.getElementById('copyGenBtn'));}
function doRefresh(){
  var eu=document.getElementById('existingUrl').value.trim();
  if(!eu){alert('Paste your existing addon URL first.');return;}
  var btn=document.getElementById('refBtn');btn.disabled=true;btn.textContent='Refreshing...';
  fetch('/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({existingUrl:eu})})
    .then(function(r){return r.json()}).then(function(d){
      if(d.error){alert(d.error);btn.disabled=false;btn.textContent='Refresh Existing URL';return;}
      ru=d.manifestUrl;document.getElementById('refUrl').textContent=ru;
      document.getElementById('refBox').style.display='block';
      btn.disabled=false;btn.textContent='Refresh Again';
    }).catch(function(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent='Refresh Existing URL'});
}
function copyRef(){if(ru)copyText(ru,document.getElementById('copyRefBtn'));}
function copyText(text,btn){
  var o=btn.textContent;
  if(navigator.clipboard){navigator.clipboard.writeText(text).then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent=o},1500)});}
  else{var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;opacity:0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);btn.textContent='Copied!';setTimeout(function(){btn.textContent=o},1500);}
}
</script>
</body>
</html>`;
}

// ─── Worker entry ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (pathname === '/') return htmlRes(buildPage());

      if (pathname === '/generate' && request.method === 'POST') {
        const token = generateToken();
        return jsonRes({ token, manifestUrl: `${url.origin}/u/${token}/manifest.json` });
      }

      if (pathname === '/refresh' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch {}
        const m = String(body?.existingUrl || '').match(/[a-f0-9]{28}/);
        if (!m) return jsonRes({ error: 'Paste your full addon URL — must contain a valid token' }, 400);
        return jsonRes({ token: m[0], manifestUrl: `${url.origin}/u/${m[0]}/manifest.json`, refreshed: true });
      }

      if (pathname === '/health') {
        return jsonRes({ status: 'ok', version: '1.0.0', ts: new Date().toISOString() });
      }

      // Token-scoped routes
      const tp = parseTokenPath(pathname);
      if (tp) {
        if (!isValidToken(tp.token)) return jsonRes({ error: 'Invalid token.' }, 400);
        const data = await handleRoute(tp.rest, url, env);
        return data ? jsonRes(data) : jsonRes({ error: 'Not found', path: tp.rest }, 404);
      }

      // Bare routes (for testing / curl)
      const data = await handleRoute(pathname, url, env);
      return data ? jsonRes(data) : jsonRes({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('[EclipseMusic]', err);
      return jsonRes({ error: err.message || 'Internal error' }, 500);
    }
  },
};