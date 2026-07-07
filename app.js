/* ============================================================
   QUEUE — personal TV episode tracker (starter)
   Storage: localStorage via Store adapter (swap for Firestore later)
   Data:    TMDB API (key entered in Settings, stored locally)
   ============================================================ */

"use strict";

/* ----------------------- Store (storage adapter) -----------------------
   Everything reads/writes through this object. To move to Firebase later,
   reimplement these five methods against Firestore and the rest of the
   app doesn't change. */

const Store = {
  KEY: "queue.v1",

  _blank() {
    return { settings: { tmdbKey: "" }, shows: {} };
  },

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return this._blank();
      const data = JSON.parse(raw);
      if (!data.settings) data.settings = { tmdbKey: "" };
      if (!data.shows) data.shows = {};
      return data;
    } catch (e) {
      console.error("Store.load failed", e);
      return this._blank();
    }
  },

  save(state) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Store.save failed", e);
      toast("Couldn't save — storage may be full");
    }
  },

  exportJSON(state) {
    return JSON.stringify(state, null, 2);
  },

  importJSON(text) {
    const data = JSON.parse(text); // throws if invalid
    if (!data.shows || typeof data.shows !== "object") {
      throw new Error("Not a Queue backup file");
    }
    if (!data.settings) data.settings = { tmdbKey: "" };
    return data;
  },
};

let state = Store.load();
function persist() { Store.save(state); cloudPush(); }

/* ----------------------- Firebase sync (optional) -----------------------
   Local-first: localStorage is always written immediately; Firestore gets a
   debounced copy of everything EXCEPT episode caches (bulky, regenerable).
   Signed out or unconfigured, the app is fully functional locally. */

let fbAuth = null, fbDb = null, currentUser = null;
let pushTimer = null;

function cloudEnabled() {
  return typeof firebase !== "undefined" &&
    window.FIREBASE_CONFIG &&
    window.FIREBASE_CONFIG.apiKey &&
    !window.FIREBASE_CONFIG.apiKey.startsWith("PASTE");
}

function initFirebase() {
  if (!cloudEnabled()) return;
  try {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    fbAuth.getRedirectResult().catch(() => {}); // completes iOS redirect sign-ins
    fbAuth.onAuthStateChanged(async (user) => {
      currentUser = user || null;
      if (user) {
        await cloudPullOrSeed();
        await loadSharedTmdbKey();
      }
      render();
    });
  } catch (e) {
    console.error("Firebase init failed", e);
  }
}

function stripForCloud(s) {
  const shows = {};
  for (const [id, sh] of Object.entries(s.shows)) {
    const { cache, ...rest } = sh; // caches stay local
    shows[id] = rest;
  }
  return {
    settings: { tmdbKey: s.settings.tmdbKey || "" },
    shows,
    updatedAt: Date.now(),
  };
}

async function cloudPullOrSeed() {
  try {
    const ref = fbDb.collection("users").doc(currentUser.uid);
    const snap = await ref.get();
    if (snap.exists) {
      // cloud is the source of truth; graft local episode caches back on
      const cloud = snap.data();
      const localCaches = {};
      for (const [id, sh] of Object.entries(state.shows)) {
        if (sh.cache) localCaches[id] = sh.cache;
      }
      state.shows = cloud.shows || {};
      for (const [id, c] of Object.entries(localCaches)) {
        if (state.shows[id]) state.shows[id].cache = c;
      }
      if (cloud.settings && cloud.settings.tmdbKey && !state.settings.tmdbKey) {
        state.settings.tmdbKey = cloud.settings.tmdbKey;
      }
      Store.save(state);
      toast("Library synced");
    } else if (Object.keys(state.shows).length) {
      // first sign-in on the device that has your data: seed the cloud
      await ref.set(stripForCloud(state));
      toast("Library uploaded to your account");
    }
  } catch (e) {
    console.error("cloud pull failed", e);
    toast("Cloud sync unavailable — working locally");
  }
}

async function loadSharedTmdbKey() {
  // optional shared app key at config/app { tmdbKey } — read-only to users
  try {
    const snap = await fbDb.collection("config").doc("app").get();
    if (snap.exists && snap.data().tmdbKey && !state.settings.tmdbKey.trim()) {
      state.settings.tmdbKey = snap.data().tmdbKey;
      Store.save(state);
    }
  } catch (e) { /* config doc is optional */ }
}

function cloudPush() {
  if (!currentUser || !fbDb) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    fbDb.collection("users").doc(currentUser.uid)
      .set(stripForCloud(state))
      .catch(e => console.error("cloud push failed", e));
  }, 2000);
}

async function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await fbAuth.signInWithPopup(provider);
  } catch (e) {
    // popups are unreliable in installed iOS PWAs; redirect flow as fallback
    try { await fbAuth.signInWithRedirect(provider); }
    catch (e2) { toast("Sign-in failed: " + (e2.message || "unknown error")); }
  }
}

function signOutUser() {
  if (fbAuth) fbAuth.signOut();
  toast("Signed out — this device keeps a local copy");
}

/* ----------------------- TMDB client ----------------------- */

const TMDB = {
  base: "https://api.themoviedb.org/3",
  img: (path, size) => path ? `https://image.tmdb.org/t/p/${size || "w342"}${path}` : null,

  hasKey() { return !!(state.settings.tmdbKey && state.settings.tmdbKey.trim()); },

  async get(path, params) {
    const key = (state.settings.tmdbKey || "").trim();
    if (!key) throw new Error("NO_KEY");

    const url = new URL(this.base + path);
    const headers = { Accept: "application/json" };

    // v4 Read Access Tokens are long JWTs starting with "eyJ"; v3 keys are short hex
    if (key.startsWith("eyJ")) {
      headers.Authorization = "Bearer " + key;
    } else {
      url.searchParams.set("api_key", key);
    }
    for (const [k, v] of Object.entries(params || {})) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url, { headers });
    if (res.status === 401) throw new Error("BAD_KEY");
    if (!res.ok) throw new Error("TMDB error " + res.status);
    return res.json();
  },

  searchTV(query) {
    return this.get("/search/tv", { query, include_adult: "false" });
  },

  showDetail(id) {
    return this.get(`/tv/${id}`);
  },

  season(id, n) {
    return this.get(`/tv/${id}/season/${n}`);
  },
};

/* ----------------------- Episode data / cache -----------------------
   Per show we cache a flat, ordered episode list (specials excluded):
   [{ s, e, name, air }] — refreshed when >24h old and online. */

const CACHE_TTL = 24 * 60 * 60 * 1000;

function epKey(s, e) { return `s${s}e${e}`; }

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function hasAired(ep) {
  return !!ep.air && ep.air <= todayISO();
}

async function fetchEpisodeList(tmdbId) {
  const detail = await TMDB.showDetail(tmdbId);
  const seasonNums = (detail.seasons || [])
    .filter(s => s.season_number > 0)
    .map(s => s.season_number)
    .sort((a, b) => a - b);

  const episodes = [];
  for (const n of seasonNums) {
    const season = await TMDB.season(tmdbId, n);
    for (const ep of (season.episodes || [])) {
      episodes.push({
        s: ep.season_number,
        e: ep.episode_number,
        name: ep.name || `Episode ${ep.episode_number}`,
        air: ep.air_date || null,
      });
    }
  }
  return {
    episodes,
    status: detail.status || "",
    nextAir: detail.next_episode_to_air ? detail.next_episode_to_air.air_date : null,
  };
}

async function ensureEpisodes(show, force) {
  const fresh = show.cache && (Date.now() - show.cache.fetchedAt < CACHE_TTL);
  if (fresh && !force) return show.cache;
  try {
    const data = await fetchEpisodeList(show.id);
    show.cache = { fetchedAt: Date.now(), ...data };
    autoStatus(show); // e.g. caught-up show just got marked Ended by TMDB -> Finished
    persist();
  } catch (e) {
    if (!show.cache) throw e; // nothing cached and fetch failed
    // otherwise fall back silently to stale cache
  }
  return show.cache;
}

async function ensureAll(shows, force) {
  // fetch episode caches with limited concurrency (kind to TMDB after a big import)
  const queue = [...shows];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      await ensureEpisodes(s, force).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

/* ----------------------- Progress helpers ----------------------- */

function airedEpisodes(show) {
  if (!show.cache) return [];
  return show.cache.episodes.filter(hasAired);
}

function watchedCount(show) {
  return Object.keys(show.watched || {}).length;
}

function nextUnwatched(show) {
  if (!show.cache) return null;
  for (const ep of show.cache.episodes) {
    if (!show.watched[epKey(ep.s, ep.e)]) return ep;
  }
  return null;
}

function remainingAired(show) {
  return airedEpisodes(show).filter(ep => !show.watched[epKey(ep.s, ep.e)]).length;
}

const STALE_DAYS = 30;

function lastWatchedAt(show) {
  const times = Object.values(show.watched || {});
  return times.length ? Math.max(...times) : (show.addedAt || 0);
}

function isStale(show) {
  return Date.now() - lastWatchedAt(show) > STALE_DAYS * 24 * 60 * 60 * 1000;
}

function timeAgo(ts) {
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return days + "d ago";
  if (days < 365) return Math.floor(days / 30) + "mo ago";
  const y = Math.floor(days / 365);
  return y + (y === 1 ? " yr ago" : " yrs ago");
}

/* ----------------------- Actions ----------------------- */

function addShow(result, status) {
  const id = String(result.id);
  if (state.shows[id]) { toast("Already in your shows"); return; }
  state.shows[id] = {
    id: result.id,
    name: result.name,
    poster: result.poster_path || null,
    year: (result.first_air_date || "").slice(0, 4),
    status: status || "watching",   // watching | plan | done | stopped
    watched: {},
    addedAt: Date.now(),
    cache: null,
  };
  persist();
  toast(status === "plan" ? `${result.name} saved for later` : `Added ${result.name}`);
  // warm the cache in the background
  ensureEpisodes(state.shows[id]).then(() => {
    if (currentRoute.startsWith("upnext")) render();
  }).catch(() => {});
}

function removeShow(id) {
  const name = state.shows[id] ? state.shows[id].name : "show";
  delete state.shows[id];
  persist();
  toast(`Removed ${name}`);
  navigate("shows");
}

function toggleEpisode(show, s, e) {
  const k = epKey(s, e);
  if (show.watched[k]) delete show.watched[k];
  else show.watched[k] = Date.now();
  autoStatus(show);
  persist();
}

function markThrough(show, s, e) {
  // mark this episode and everything before it (aired only)
  for (const ep of show.cache.episodes) {
    if (ep.s < s || (ep.s === s && ep.e <= e)) {
      if (hasAired(ep)) show.watched[epKey(ep.s, ep.e)] = show.watched[epKey(ep.s, ep.e)] || Date.now();
    }
  }
  autoStatus(show);
  persist();
}

function markSeason(show, s, on) {
  for (const ep of show.cache.episodes) {
    if (ep.s === s && hasAired(ep)) {
      if (on) show.watched[epKey(ep.s, ep.e)] = show.watched[epKey(ep.s, ep.e)] || Date.now();
      else delete show.watched[epKey(ep.s, ep.e)];
    }
  }
  autoStatus(show);
  persist();
}

function autoStatus(show) {
  // If every aired episode is watched and the series has ended, mark done.
  if (!show.cache) return;
  const aired = airedEpisodes(show);
  const allWatched = aired.length > 0 && aired.every(ep => show.watched[epKey(ep.s, ep.e)]);
  const ended = ["Ended", "Canceled"].includes(show.cache.status);
  if (allWatched && ended) {              // finished is finished, even if archived/stopped
    if (show.status !== "done") show.status = "done";
    return;
  }
  if (show.status === "stopped") return;  // abandoned partway — user's call, don't touch
  if (!allWatched && show.status === "done") show.status = "watching";
}

/* ----------------------- Rendering utilities ----------------------- */

const $view = document.getElementById("view");
const $brand = document.getElementById("brandTitle");

function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content;
}

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ----------------------- Views ----------------------- */

/* ---- UP NEXT ---- */

async function viewUpNext() {
  $brand.innerHTML = 'UP <span class="accent">NEXT</span>';

  const shows = Object.values(state.shows);
  if (!shows.length) {
    $view.replaceChildren(h(`
      <div class="empty">
        <div class="big">Nothing queued</div>
        Add a show from the Search tab and your next episode will land here.
        <div><button class="btn btn-check" data-go="search">Find a show</button></div>
      </div>`));
    return;
  }
  if (!TMDB.hasKey()) {
    $view.replaceChildren(h(`
      <div class="empty">
        <div class="big">One setup step</div>
        Paste your free TMDB API key in Settings to load episode data.
        <div><button class="btn btn-check" data-go="settings">Open Settings</button></div>
      </div>`));
    return;
  }

  $view.replaceChildren(h(`<div class="empty">Loading your queue&hellip;</div>`));

  // make sure caches exist (fetch any missing, tolerate stale)
  const active = shows.filter(s => s.status !== "plan" && s.status !== "stopped");
  await ensureAll(active);

  const cards = [];
  for (const show of active) {
    if (!show.cache) continue;
    const next = nextUnwatched(show);
    if (!next) continue;
    cards.push({ show, next, behind: remainingAired(show) });
  }
  // shows you're furthest behind on... actually: most recently added / most behind first, aired first
  cards.sort((a, b) => {
    const aAired = hasAired(a.next) ? 0 : 1;
    const bAired = hasAired(b.next) ? 0 : 1;
    if (aAired !== bAired) return aAired - bAired;
    return b.behind - a.behind;
  });

  if (!cards.length) {
    $view.replaceChildren(h(`
      <div class="empty">
        <div class="big">All caught up</div>
        No unwatched episodes right now. Nicely done.
      </div>`));
    return;
  }

  const frag = document.createDocumentFragment();
  const ready = cards.filter(c => hasAired(c.next));
  const continueSection = ready.filter(c => !isStale(c.show));
  const staleSection = ready.filter(c => isStale(c.show));
  const upcomingSection = cards.filter(c => !hasAired(c.next));

  // sort by most recently watched, in every section;
  // "Coming up" by soonest air date since nothing's watchable yet
  continueSection.sort((a, b) => lastWatchedAt(b.show) - lastWatchedAt(a.show));
  staleSection.sort((a, b) => lastWatchedAt(b.show) - lastWatchedAt(a.show));
  upcomingSection.sort((a, b) => (a.next.air || "9999").localeCompare(b.next.air || "9999"));

  if (continueSection.length) {
    frag.append(h(`<div class="section-label">Continue watching</div>`));
    continueSection.forEach(c => frag.append(nextCard(c)));
  }
  if (staleSection.length) {
    frag.append(h(`<div class="section-label">Pick it back up</div>`));
    staleSection.forEach(c => frag.append(nextCard(c)));
  }
  if (upcomingSection.length) {
    frag.append(h(`<div class="section-label">Coming up</div>`));
    upcomingSection.forEach(c => frag.append(nextCard(c)));
  }
  $view.replaceChildren(frag);
}

function nextCard({ show, next, behind }) {
  const aired = airedEpisodes(show);
  const total = aired.length;
  const MAXTICKS = 60;
  let ticks = "";
  if (total <= MAXTICKS) {
    ticks = aired.map(ep => {
      const k = epKey(ep.s, ep.e);
      const cls = show.watched[k] ? "done" : (ep.s === next.s && ep.e === next.e ? "next" : "");
      return `<span class="tick ${cls}"></span>`;
    }).join("");
  } else {
    // compress: show season-level ticks for long series
    const seasons = [...new Set(aired.map(ep => ep.s))];
    ticks = seasons.map(sn => {
      const eps = aired.filter(ep => ep.s === sn);
      const done = eps.every(ep => show.watched[epKey(ep.s, ep.e)]);
      const isNext = sn === next.s;
      return `<span class="tick ${done ? "done" : isNext ? "next" : ""}" style="width:14px"></span>`;
    }).join("");
  }

  const posterUrl = TMDB.img(show.poster, "w185");
  const airedFlag = hasAired(next);
  const hasHistory = Object.keys(show.watched || {}).length > 0;
  const ago = hasHistory ? ` &middot; watched ${timeAgo(lastWatchedAt(show))}` : "";
  const meta = airedFlag
    ? `${behind} unwatched${ago}`
    : (next.air ? `Airs ${fmtDate(next.air)}` : "Air date TBA");

  const el = h(`
    <article class="next-card" data-id="${show.id}">
      ${posterUrl
        ? `<img class="next-poster" src="${posterUrl}" alt="" loading="lazy">`
        : `<div class="next-poster noart">${esc(show.name)}</div>`}
      <div class="next-body">
        <div class="next-show">${esc(show.name)}</div>
        <div class="next-code">S${next.s}<span class="dot">&middot;</span>E${next.e}</div>
        <div class="next-eptitle">${esc(next.name)}</div>
        <div class="next-meta">${meta}</div>
        <div class="tickstrip">${ticks}</div>
        <div class="next-actions">
          ${airedFlag ? `<button class="btn btn-check" data-watch>Watched &#10003;</button>` : ""}
          <button class="btn btn-quiet" data-open>Details</button>
        </div>
      </div>
    </article>`);

  const card = el.querySelector(".next-card");
  const watchBtn = card.querySelector("[data-watch]");
  if (watchBtn) {
    watchBtn.addEventListener("click", () => {
      toggleEpisode(show, next.s, next.e);
      toast(`S${next.s}E${next.e} marked watched`);
      render();
    });
  }
  card.querySelector("[data-open]").addEventListener("click", () => navigate("show/" + show.id));
  return el;
}

/* ---- MY SHOWS ---- */

let showsFilter = "watching";

function viewShows() {
  $brand.innerHTML = 'MY <span class="accent">SHOWS</span>';

  const shows = Object.values(state.shows)
    .sort((a, b) => a.name.localeCompare(b.name));

  const counts = {
    watching: shows.filter(s => s.status === "watching").length,
    plan: shows.filter(s => s.status === "plan").length,
    done: shows.filter(s => s.status === "done").length,
    stopped: shows.filter(s => s.status === "stopped").length,
    all: shows.length,
  };

  const filtered = showsFilter === "all" ? shows : shows.filter(s => s.status === showsFilter);

  const chips = [
    ["watching", "Watching"],
    ["plan", "Plan to watch"],
    ["done", "Finished"],
    ["stopped", "Stopped"],
    ["all", "All"],
  ].map(([key, label]) =>
    `<button class="chip ${showsFilter === key ? "active" : ""}" data-filter="${key}">${label} ${counts[key] ? "&middot; " + counts[key] : ""}</button>`
  ).join("");

  let body;
  if (!shows.length) {
    body = `<div class="empty"><div class="big">No shows yet</div>Head to Search and add what you're watching.</div>`;
  } else if (!filtered.length) {
    body = `<div class="empty">Nothing in this list.</div>`;
  } else if (showsFilter === "watching") {
    const byRecency = [...filtered].sort((a, b) => lastWatchedAt(b) - lastWatchedAt(a));
    const rotation = byRecency.filter(s => !isStale(s));
    const shelved = byRecency.filter(s => isStale(s));
    body = "";
    if (rotation.length) {
      body += `<div class="section-label">In rotation</div><div class="poster-grid">${rotation.map(posterCell).join("")}</div>`;
    }
    if (shelved.length) {
      body += `<div class="section-label">It's been a while</div><div class="poster-grid">${shelved.map(posterCell).join("")}</div>`;
    }
  } else {
    body = `<div class="poster-grid">${filtered.map(posterCell).join("")}</div>`;
  }

  $view.replaceChildren(h(`<div class="filters">${chips}</div>${body}`));

  $view.querySelectorAll("[data-filter]").forEach(el =>
    el.addEventListener("click", () => { showsFilter = el.dataset.filter; viewShows(); }));
  $view.querySelectorAll(".poster-cell").forEach(el => {
    const go = () => navigate("show/" + el.dataset.id);
    el.addEventListener("click", go);
    el.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });
}

function posterCell(show) {
  const posterUrl = TMDB.img(show.poster, "w342");
  const remain = show.cache ? remainingAired(show) : null;
  const badge = show.status === "done"
    ? `<span class="badge done">&#10003;</span>`
    : (remain ? `<span class="badge">${remain}</span>` : "");
  const caption = (show.status === "watching" && isStale(show) && Object.keys(show.watched || {}).length)
    ? `${esc(show.name)} &middot; ${timeAgo(lastWatchedAt(show))}`
    : esc(show.name);
  return `
    <div class="poster-cell" data-id="${show.id}" role="button" tabindex="0">
      ${posterUrl ? `<img src="${posterUrl}" alt="${esc(show.name)}" loading="lazy">`
                  : `<div class="noart">${esc(show.name)}</div>`}
      ${badge}
      <div class="poster-title">${caption}</div>
    </div>`;
}

/* ---- SEARCH ---- */

let lastResults = [];

function viewSearch() {
  $brand.innerHTML = '<span class="accent">SEARCH</span>';

  $view.replaceChildren(h(`
    <div class="searchbox">
      <input id="q" type="search" placeholder="Show name&hellip;" autocomplete="off" enterkeyhint="search">
    </div>
    <div id="results"></div>`));

  const input = $view.querySelector("#q");
  const resultsEl = $view.querySelector("#results");

  if (!TMDB.hasKey()) {
    resultsEl.replaceChildren(h(`
      <div class="empty">Add your TMDB API key in Settings first — takes about two minutes and it's free.</div>`));
  } else if (lastResults.length) {
    renderResults(resultsEl, lastResults);
  }

  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { resultsEl.replaceChildren(); return; }
    timer = setTimeout(async () => {
      try {
        const data = await TMDB.searchTV(q);
        lastResults = (data.results || []).slice(0, 20);
        renderResults(resultsEl, lastResults);
      } catch (e) {
        resultsEl.replaceChildren(h(`<div class="empty">${e.message === "NO_KEY"
          ? "Add your TMDB key in Settings first."
          : e.message === "BAD_KEY"
            ? "TMDB rejected that key — double-check it in Settings."
            : "Search failed. Check your connection and try again."}</div>`));
      }
    }, 350);
  });
  input.focus();
}

function renderResults(container, results) {
  if (!results.length) {
    container.replaceChildren(h(`<div class="empty">No matches.</div>`));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of results) {
    const have = !!state.shows[String(r.id)];
    const posterUrl = TMDB.img(r.poster_path, "w154");
    const year = (r.first_air_date || "").slice(0, 4);
    const el = h(`
      <div class="result-row">
        ${posterUrl ? `<img src="${posterUrl}" alt="" loading="lazy">` : `<div class="noart-sm">No art</div>`}
        <div>
          <div class="result-name">${esc(r.name)}</div>
          <div class="result-sub">${year || "&mdash;"}${r.origin_country && r.origin_country.length ? " &middot; " + esc(r.origin_country[0]) : ""}</div>
        </div>
        <div class="add-pair">
          ${have
            ? `<button class="addbtn" disabled>Added &#10003;</button>`
            : `<button class="addbtn" data-add="watching">+ Watching</button>
               <button class="addbtn plan" data-add="plan">+ Later</button>`}
        </div>
      </div>`);
    if (!have) {
      const pair = el.querySelector(".add-pair");
      pair.querySelectorAll("[data-add]").forEach(btn =>
        btn.addEventListener("click", () => {
          addShow(r, btn.dataset.add);
          pair.innerHTML = `<button class="addbtn" disabled>Added &#10003;</button>`;
        }));
    }
    frag.append(el);
  }
  container.replaceChildren(frag);
}

/* ---- SHOW DETAIL ---- */

const openSeasons = {}; // remember which accordions are open per show

async function viewShowDetail(id) {
  const show = state.shows[id];
  if (!show) { navigate("shows"); return; }

  $brand.innerHTML = '<span class="accent">SHOW</span>';
  $view.replaceChildren(h(`<div class="empty">Loading episodes&hellip;</div>`));

  try {
    await ensureEpisodes(show);
  } catch (e) {
    $view.replaceChildren(h(`
      <a class="backlink" data-go="shows">&larr; My Shows</a>
      <div class="empty">${e.message === "NO_KEY"
        ? "Add your TMDB key in Settings to load episodes."
        : "Couldn't load episode data. Check your connection."}</div>`));
    wireGoLinks();
    return;
  }

  const eps = show.cache.episodes;
  const seasons = [...new Set(eps.map(ep => ep.s))].sort((a, b) => a - b);
  const posterUrl = TMDB.img(show.poster, "w342");
  const aired = airedEpisodes(show);
  const watched = aired.filter(ep => show.watched[epKey(ep.s, ep.e)]).length;

  if (!(id in openSeasons)) {
    // default open: the season containing the next unwatched episode
    const nx = nextUnwatched(show);
    openSeasons[id] = nx ? nx.s : (seasons[seasons.length - 1] || 1);
  }

  const statusChips = [
    ["watching", "Watching"],
    ["plan", "Plan to watch"],
    ["done", "Finished"],
    ["stopped", "Stopped"],
  ].map(([key, label]) =>
    `<button class="chip ${show.status === key ? "active" : ""}" data-status="${key}">${label}</button>`
  ).join("");

  const seasonBlocks = seasons.map(sn => {
    const sEps = eps.filter(ep => ep.s === sn);
    const sAired = sEps.filter(hasAired);
    const sDone = sAired.filter(ep => show.watched[epKey(ep.s, ep.e)]).length;
    const open = openSeasons[id] === sn;

    const rows = !open ? "" : sEps.map(ep => {
      const k = epKey(ep.s, ep.e);
      const isWatched = !!show.watched[k];
      const future = !hasAired(ep);
      return `
        <div class="ep-row ${isWatched ? "watched" : ""} ${future ? "future" : ""}" data-s="${ep.s}" data-e="${ep.e}">
          <div class="ep-num">E${ep.e}</div>
          <div class="ep-name">
            <span class="t">${esc(ep.name)}</span>
            <span class="d">${future ? "Airs " : ""}${fmtDate(ep.air) || "TBA"}</span>
          </div>
          <button class="checkbox" aria-label="Toggle watched">&#10003;</button>
        </div>`;
    }).join("");

    return `
      <div class="season">
        <button class="season-head" data-season="${sn}">
          <span class="season-name">Season ${sn}</span>
          <span class="season-count"><span class="done-count">${sDone}</span> / ${sAired.length}${sEps.length > sAired.length ? " aired" : ""}</span>
        </button>
        ${open ? `
          <div class="season-body">${rows}</div>
          <div class="season-actions">
            <button class="minibtn" data-mark-season="${sn}">Mark season watched</button>
            <button class="minibtn" data-clear-season="${sn}">Clear</button>
          </div>` : ""}
      </div>`;
  }).join("");

  $view.replaceChildren(h(`
    <a class="backlink" data-go="shows">&larr; My Shows</a>
    <div class="detail-hero">
      ${posterUrl ? `<img src="${posterUrl}" alt="">` : `<div class="noart">${esc(show.name)}</div>`}
      <div>
        <div class="detail-title">${esc(show.name)}</div>
        <div class="detail-sub">
          ${show.year || ""}${show.cache.status ? " &middot; " + esc(show.cache.status) : ""}<br>
          <span style="color:var(--green)">${watched}</span> of ${aired.length} aired episodes watched
          ${show.cache.nextAir ? `<br>Next episode ${fmtDate(show.cache.nextAir)}` : ""}
        </div>
      </div>
    </div>
    <div class="status-row">${statusChips}</div>
    <div class="detail-actions">
      <button class="minibtn" data-caughtup>I'm caught up &mdash; mark all aired</button>
      <button class="minibtn danger" data-remove>Remove show</button>
    </div>
    ${seasonBlocks}`));

  wireGoLinks();

  $view.querySelectorAll("[data-status]").forEach(el =>
    el.addEventListener("click", () => {
      show.status = el.dataset.status;
      persist();
      viewShowDetail(id);
    }));

  $view.querySelectorAll("[data-season]").forEach(el =>
    el.addEventListener("click", () => {
      const sn = Number(el.dataset.season);
      openSeasons[id] = openSeasons[id] === sn ? null : sn;
      viewShowDetail(id);
    }));

  $view.querySelectorAll(".ep-row .checkbox").forEach(btn =>
    btn.addEventListener("click", () => {
      const row = btn.closest(".ep-row");
      toggleEpisode(show, Number(row.dataset.s), Number(row.dataset.e));
      viewShowDetail(id);
    }));

  $view.querySelectorAll("[data-mark-season]").forEach(el =>
    el.addEventListener("click", () => {
      markSeason(show, Number(el.dataset.markSeason), true);
      viewShowDetail(id);
    }));
  $view.querySelectorAll("[data-clear-season]").forEach(el =>
    el.addEventListener("click", () => {
      markSeason(show, Number(el.dataset.clearSeason), false);
      viewShowDetail(id);
    }));

  $view.querySelector("[data-caughtup]").addEventListener("click", () => {
    const last = airedEpisodes(show).slice(-1)[0];
    if (last) {
      markThrough(show, last.s, last.e);
      toast("Marked all aired episodes watched");
      viewShowDetail(id);
    }
  });

  $view.querySelector("[data-remove]").addEventListener("click", () => {
    if (confirm(`Remove ${show.name} and its watch history?`)) removeShow(id);
  });
}

/* ----------------------- TV Time import -----------------------
   Reads the TV Time GDPR/export CSV (tracking records). Two row types:
   - "user-series-…"   one per show: TVDB s_id, name, archived/for-later flags
   - "watch-episode-…" one per watched episode: s_id, s_no, ep_no, created_at
   TVTime uses TVDB IDs; we translate via TMDB's /find endpoint,
   falling back to a name search. */

function parseDelimited(text) {
  const firstNL = text.indexOf("\n");
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  const delim = (firstLine.match(/\t/g) || []).length >= (firstLine.match(/,/g) || []).length ? "\t" : ",";

  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseTVTimeDate(str) {
  // "8/5/2018 15:43" (M/D/YYYY H:mm)
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0)).getTime();
}

function parseTVTimeExport(text) {
  const rows = parseDelimited(text);
  if (rows.length < 2) throw new Error("Empty file");
  const header = rows[0].map(x => String(x).trim().toLowerCase());
  const col = n => header.indexOf(n);

  const iKey = col("key"), iCreated = col("created_at"), iSid = col("s_id"),
        iSno = col("s_no"), iEpno = col("ep_no"),
        iArch = col("is_archived"), iLater = col("is_for_later"),
        iName = col("series_name"),
        iSeason2 = col("season_number"), iEp2 = col("episode_number");
  if (iKey === -1 || iSid === -1) throw new Error("This doesn't look like a TV Time export");

  const bySid = new Map(); // TVDB id -> { tvdbId, name, status, watched: {sXeY: ts} }
  const getEntry = (sid) => {
    if (!bySid.has(sid)) bySid.set(sid, { tvdbId: sid, name: "", status: "watching", watched: {} });
    return bySid.get(sid);
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 3) continue;
    const key = String(row[iKey] || "");
    const sid = String(row[iSid] || "").trim();
    if (!sid) continue;

    if (key.startsWith("user-series-")) {
      const entry = getEntry(sid);
      entry.name = String(row[iName] || "").trim() || entry.name;
      const truthy = v => String(v).trim().toUpperCase() === "TRUE";
      if (iLater !== -1 && truthy(row[iLater])) entry.status = "plan";
      else if (iArch !== -1 && truthy(row[iArch])) entry.status = "stopped";
      else entry.status = "watching";
    } else if (key.startsWith("watch-episode-")) {
      const s = Number(row[iSno]) || (iSeason2 !== -1 ? Number(row[iSeason2]) : 0);
      const e = Number(row[iEpno]) || (iEp2 !== -1 ? Number(row[iEp2]) : 0);
      if (!s || !e) continue; // skips specials (season 0) and malformed rows
      const entry = getEntry(sid);
      entry.name = String(row[iName] || "").trim() || entry.name;
      const ts = parseTVTimeDate(iCreated !== -1 ? row[iCreated] : "") || Date.now();
      const k = epKey(s, e);
      if (!entry.watched[k] || ts < entry.watched[k]) entry.watched[k] = ts;
    }
  }
  return [...bySid.values()];
}

async function matchTVTimeShow(item) {
  // 1) exact translation via TVDB id
  if (item.tvdbId && /^\d+$/.test(item.tvdbId)) {
    try {
      const found = await TMDB.get(`/find/${item.tvdbId}`, { external_source: "tvdb_id" });
      if (found.tv_results && found.tv_results.length) return found.tv_results[0];
    } catch (e) { /* fall through to name search */ }
  }
  // 2) name search fallback (strip TVTime's "(US)" style suffixes on retry)
  if (item.name) {
    let data = await TMDB.searchTV(item.name);
    if (data.results && data.results.length) return data.results[0];
    const cleaned = item.name.replace(/\s*\((US|UK|\d{4})\)\s*$/i, "").trim();
    if (cleaned && cleaned !== item.name) {
      data = await TMDB.searchTV(cleaned);
      if (data.results && data.results.length) return data.results[0];
    }
  }
  return null;
}

async function runTVTimeImport(items, onProgress) {
  const summary = { shows: 0, episodes: 0, unmatched: [] };
  let done = 0;
  const queue = [...items];

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const tv = await matchTVTimeShow(item);
        if (!tv) {
          summary.unmatched.push(item.name || ("TVDB #" + item.tvdbId));
        } else {
          const id = String(tv.id);
          if (!state.shows[id]) {
            state.shows[id] = {
              id: tv.id,
              name: tv.name,
              poster: tv.poster_path || null,
              year: (tv.first_air_date || "").slice(0, 4),
              status: item.status,
              watched: {},
              addedAt: Date.now(),
              cache: null,
            };
          }
          const show = state.shows[id];
          let added = 0;
          for (const [k, ts] of Object.entries(item.watched)) {
            if (!show.watched[k]) { show.watched[k] = ts; added++; }
          }
          summary.shows++;
          summary.episodes += added;
        }
      } catch (e) {
        summary.unmatched.push(item.name || ("TVDB #" + item.tvdbId));
      }
      done++;
      onProgress(done, items.length, item.name);
      if (done % 10 === 0) persist(); // checkpoint so a mid-import close loses little
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));
  persist();
  return summary;
}

/* ---- SETTINGS ---- */

function viewSettings() {
  $brand.innerHTML = '<span class="accent">SETTINGS</span>';

  const shows = Object.values(state.shows);
  const totalWatched = shows.reduce((n, s) => n + watchedCount(s), 0);

  const accountCard = !cloudEnabled()
    ? `<div class="card">
        <h3>Account &amp; sync</h3>
        <p>Cloud sync is off. Paste your Firebase web config into <code>firebase-config.js</code> to enable Google sign-in and cross-device sync. Everything works locally in the meantime.</p>
      </div>`
    : currentUser
      ? `<div class="card">
          <h3>Account &amp; sync</h3>
          <p>Signed in as <strong>${esc(currentUser.email || currentUser.displayName || "Google account")}</strong>. Your library syncs to this account — changes here appear on any device you sign into.</p>
          <button class="btn btn-quiet" id="signOutBtn">Sign out</button>
        </div>`
      : `<div class="card">
          <h3>Account &amp; sync</h3>
          <p>Sign in to sync your library across devices. First sign-in from this device uploads what's here.</p>
          <button class="btn btn-check" id="signInBtn">Sign in with Google</button>
        </div>`;

  $view.replaceChildren(h(`
    ${accountCard}
    <div class="card">
      <h3>TMDB API key</h3>
      <p>Episode data comes from <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">The Movie Database</a>.
      Create a free account, request an API key (personal use), and paste either the short v3 key or the long Read Access Token here. It's stored only on this device.</p>
      <input class="field" id="tmdbKey" type="text" placeholder="Paste key" value="${esc(state.settings.tmdbKey)}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div style="display:flex; gap:8px">
        <button class="btn btn-check" id="saveKey">Save key</button>
        <button class="btn btn-quiet" id="testKey">Test</button>
      </div>
    </div>

    <div class="card">
      <h3>Your numbers</h3>
      <div class="stat-row"><span>Shows tracked</span><span class="v">${shows.length}</span></div>
      <div class="stat-row"><span>Currently watching</span><span class="v">${shows.filter(s => s.status === "watching").length}</span></div>
      <div class="stat-row"><span>Episodes watched</span><span class="v">${totalWatched}</span></div>
    </div>

    <div class="card">
      <h3>Import from TV Time</h3>
      <p>Have a TV Time data export? Upload the tracking CSV and your full watch history rebuilds here — shows are matched to TMDB automatically, watch dates preserved. Safe to re-run; already-imported episodes are skipped.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <button class="btn btn-check" id="tvtBtn">Choose CSV file</button>
        <input type="file" id="tvtFile" accept=".csv,text/csv,text/plain,.tsv" style="display:none">
      </div>
      <p id="tvtStatus" style="margin:10px 0 0; min-height:1em"></p>
    </div>

    <div class="card">
      <h3>Backup</h3>
      <p>Everything lives in this browser. Export a backup before clearing Safari data, or to move to another device.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap">
        <button class="btn btn-quiet" id="exportBtn">Export JSON</button>
        <button class="btn btn-quiet" id="importBtn">Import</button>
        <input type="file" id="importFile" accept="application/json" style="display:none">
      </div>
    </div>`));

  const signInBtn = $view.querySelector("#signInBtn");
  if (signInBtn) signInBtn.addEventListener("click", signIn);
  const signOutBtn = $view.querySelector("#signOutBtn");
  if (signOutBtn) signOutBtn.addEventListener("click", () => { signOutUser(); viewSettings(); });

  $view.querySelector("#saveKey").addEventListener("click", () => {
    state.settings.tmdbKey = $view.querySelector("#tmdbKey").value.trim();
    persist();
    toast("Key saved");
  });

  $view.querySelector("#testKey").addEventListener("click", async () => {
    state.settings.tmdbKey = $view.querySelector("#tmdbKey").value.trim();
    persist();
    try {
      await TMDB.get("/configuration");
      toast("Key works \u2713");
    } catch (e) {
      toast(e.message === "NO_KEY" ? "Paste a key first" : "TMDB rejected that key");
    }
  });

  const tvtStatus = $view.querySelector("#tvtStatus");
  $view.querySelector("#tvtBtn").addEventListener("click", () =>
    $view.querySelector("#tvtFile").click());

  $view.querySelector("#tvtFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    if (!TMDB.hasKey()) {
      tvtStatus.textContent = "Save your TMDB key above first — it's needed to match your shows.";
      return;
    }

    let items;
    try {
      items = parseTVTimeExport(await file.text());
    } catch (err) {
      tvtStatus.textContent = "Couldn't read that file: " + err.message;
      return;
    }
    const epTotal = items.reduce((n, it) => n + Object.keys(it.watched).length, 0);
    if (!items.length) {
      tvtStatus.textContent = "No shows found in that file.";
      return;
    }
    if (!confirm(`Found ${items.length} shows and ${epTotal.toLocaleString()} watched episodes. Import now? (Takes a minute or two.)`)) {
      tvtStatus.textContent = "Import cancelled.";
      return;
    }

    const btn = $view.querySelector("#tvtBtn");
    btn.disabled = true;
    try {
      const summary = await runTVTimeImport(items, (done, total, name) => {
        tvtStatus.textContent = `Matching ${done} of ${total}: ${name || "…"}`;
      });
      let msg = `Done — imported ${summary.shows} shows, ${summary.episodes.toLocaleString()} episodes.`;
      if (summary.unmatched.length) {
        msg += ` Couldn't match ${summary.unmatched.length}: ${summary.unmatched.slice(0, 8).join(", ")}${summary.unmatched.length > 8 ? "…" : ""} — add those via Search.`;
      }
      tvtStatus.textContent = msg;
      toast("TV Time history imported");
    } catch (err) {
      tvtStatus.textContent = "Import stopped: " + err.message + " — progress so far was saved; re-run to finish.";
    }
    btn.disabled = false;
  });

  $view.querySelector("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([Store.exportJSON(state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "queue-backup-" + todayISO() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $view.querySelector("#importBtn").addEventListener("click", () =>
    $view.querySelector("#importFile").click());

  $view.querySelector("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      state = Store.importJSON(text);
      persist();
      toast("Backup imported");
      viewSettings();
    } catch {
      toast("That file didn't look like a Queue backup");
    }
  });
}

/* ----------------------- Router ----------------------- */

let currentRoute = "upnext";

function navigate(route) {
  location.hash = "#/" + route;
}

function render() {
  const route = currentRoute;
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", route.split("/")[0] === t.dataset.route ||
      (route.startsWith("show/") && t.dataset.route === "shows")));

  window.scrollTo(0, 0);
  if (route === "upnext") viewUpNext();
  else if (route === "shows") viewShows();
  else if (route === "search") viewSearch();
  else if (route === "settings") viewSettings();
  else if (route.startsWith("show/")) viewShowDetail(route.slice(5));
  else viewUpNext();
}

function onHashChange() {
  currentRoute = (location.hash || "#/upnext").replace(/^#\//, "");
  render();
}

function wireGoLinks() {
  $view.querySelectorAll("[data-go]").forEach(el =>
    el.addEventListener("click", () => navigate(el.dataset.go)));
}

/* generic delegate for empty-state buttons rendered before wireGoLinks */
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go && !go.dataset.wired) navigate(go.dataset.go);
});

document.querySelectorAll(".tab").forEach(t =>
  t.addEventListener("click", () => navigate(t.dataset.route)));

document.getElementById("refreshBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!TMDB.hasKey()) { toast("Add your TMDB key in Settings first"); return; }
  btn.classList.add("spin");
  await ensureAll(Object.values(state.shows), true);
  btn.classList.remove("spin");
  toast("Episode data refreshed");
  render();
});

window.addEventListener("hashchange", onHashChange);

/* ----------------------- Service worker ----------------------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* go */
initFirebase();
onHashChange();
