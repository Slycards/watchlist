// ---------------------------------------------------------------------------
// SLY Watchlist — live server.
//
// Why this exists: browsers (and sandboxed artifact frames) can't reliably
// fetch the MLB API + Baseball Savant directly. A server has no such limits.
// This process fetches upstream, caches what should be cached, computes the
// rolling 7/15/30-day splits, and hands the frontend clean JSON.
//
// Endpoints it exposes to the frontend:
//   GET /api/search?q=NAME            -> [{id,name,team,pos}]
//   GET /api/player/:id               -> {season, splits:{d7,d15,d30}, statcast}
//   GET /api/live?ids=1,2,3           -> {id: {state,inning,opp,summary,line}}
//
// Node 18+ has global fetch built in — no node-fetch needed.
// ---------------------------------------------------------------------------

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const MLB = "https://statsapi.mlb.com/api";
const SAVANT = "https://baseballsavant.mlb.com";
const SEASON = new Date().getFullYear();

// ---- tiny in-memory cache -------------------------------------------------
const cache = new Map(); // key -> {value, expires}
function getCached(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  return null;
}
function setCached(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "sly-watchlist/1.0" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---- date helpers ---------------------------------------------------------
const todayStr = () => new Date().toISOString().slice(0, 10);
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---- Statcast: fetch the expected-stats leaderboard once/day, index by id --
// Savant returns JSON keyed by player_id (MLBAM), the same ids MLB uses.
async function getStatcastMap() {
  const key = `statcast:${todayStr()}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = `${SAVANT}/leaderboard/expected_statistics?type=batter&year=${SEASON}&position=&team=&filterType=bip&min=1&csv=false`;
  let map = {};
  try {
    const rows = await fetchJson(url);
    for (const row of rows) {
      const id = Number(row.player_id);
      if (!id) continue;
      map[id] = {
        xwoba: num(row.est_woba),
        xba: num(row.est_ba),
        xslg: num(row.est_slg),
        woba: num(row.woba),          // actual wOBA — powers the over/under delta
        barrel: num(row.brl_percent),
        hardhit: num(row.hard_hit_percent),
        ev: num(row.avg_hit_speed),
        k: num(row.k_percent),
        bb: num(row.bb_percent),
      };
    }
  } catch (e) {
    console.warn("Statcast fetch failed:", e.message);
  }
  // cache until end of day (or 6h, whichever is sooner) so a bad fetch retries
  setCached(key, map, 6 * 60 * 60 * 1000);
  return map;
}
const num = (v) => (v === "" || v == null ? null : Number(v));

// ---- rolling-split aggregation from game logs ------------------------------
function aggregate(logs) {
  const t = { ab: 0, h: 0, hr: 0, rbi: 0, r: 0, bb: 0, k: 0, hbp: 0, sf: 0, doubles: 0, triples: 0, sb: 0 };
  for (const g of logs) {
    const s = g.stat || {};
    t.ab += +s.atBats || 0; t.h += +s.hits || 0; t.hr += +s.homeRuns || 0;
    t.rbi += +s.rbi || 0; t.r += +s.runs || 0; t.bb += +s.baseOnBalls || 0;
    t.k += +s.strikeOuts || 0; t.hbp += +s.hitByPitch || 0; t.sf += +s.sacFlies || 0;
    t.doubles += +s.doubles || 0; t.triples += +s.triples || 0; t.sb += +s.stolenBases || 0;
  }
  const singles = t.h - t.doubles - t.triples - t.hr;
  const tb = singles + 2 * t.doubles + 3 * t.triples + 4 * t.hr;
  const obpDen = t.ab + t.bb + t.hbp + t.sf;
  const obp = obpDen ? (t.h + t.bb + t.hbp) / obpDen : 0;
  const slg = t.ab ? tb / t.ab : 0;
  return {
    games: logs.length,
    ab: t.ab, h: t.h, hr: t.hr, rbi: t.rbi, r: t.r, bb: t.bb, k: t.k, sb: t.sb,
    avg: t.ab ? t.h / t.ab : 0, obp, slg, ops: obp + slg,
  };
}

// ===========================================================================
// API ROUTES
// ===========================================================================

// Search — direct MLB name lookup. Reliable server-side.
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const j = await fetchJson(`${MLB}/v1/people/search?names=${encodeURIComponent(q)}`);
    const people = (j.people || []).map((p) => ({
      id: p.id,
      name: p.fullName,
      team: p.currentTeam?.name || "",
      pos: p.primaryPosition?.abbreviation || "",
      active: p.active,
    }));
    res.json(people);
  } catch (e) {
    res.status(502).json({ error: "search failed", detail: e.message });
  }
});

// Profile — minimal header (name/team/pos) for a single id. Used to restore
// a saved watchlist on load, where we have ids but not names.
app.get("/api/profile/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "bad id" });
  try {
    const j = await fetchJson(`${MLB}/v1/people/${id}`);
    const p = j.people?.[0];
    if (!p) return res.status(404).json({ error: "not found" });
    res.json({
      id: p.id, name: p.fullName,
      team: p.currentTeam?.name || "", pos: p.primaryPosition?.abbreviation || "",
    });
  } catch (e) {
    res.status(502).json({ error: "profile fetch failed", detail: e.message });
  }
});

// Player — season line, rolling splits, and Statcast row.
app.get("/api/player/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "bad id" });
  const key = `player:${id}:${todayStr()}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);

  try {
    const [seasonJ, logJ, scMap] = await Promise.all([
      fetchJson(`${MLB}/v1/people/${id}/stats?stats=season&group=hitting&season=${SEASON}`),
      fetchJson(`${MLB}/v1/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`),
      getStatcastMap(),
    ]);

    const s = seasonJ.stats?.[0]?.splits?.[0]?.stat;
    const season = s ? {
      games: +s.gamesPlayed || 0, ab: +s.atBats || 0,
      avg: +s.avg, obp: +s.obp, slg: +s.slg, ops: +s.ops,
      hr: +s.homeRuns, rbi: +s.rbi, r: +s.runs, h: +s.hits,
      bb: +s.baseOnBalls, k: +s.strikeOuts, sb: +s.stolenBases,
    } : null;

    const logs = logJ.stats?.[0]?.splits || [];
    const splits = {
      d7: aggregate(logs.filter((g) => g.date >= daysAgo(7))),
      d15: aggregate(logs.filter((g) => g.date >= daysAgo(15))),
      d30: aggregate(logs.filter((g) => g.date >= daysAgo(30))),
    };

    const payload = { id, season, splits, statcast: scMap[id] || null };
    setCached(key, payload, 15 * 60 * 1000); // 15 min — game logs update post-game
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: "player fetch failed", detail: e.message });
  }
});

// Live — today's games, matched to the requested player ids.
app.get("/api/live", async (req, res) => {
  const ids = new Set((req.query.ids || "").split(",").map(Number).filter(Boolean));
  if (!ids.size) return res.json({});
  try {
    const sched = await fetchJson(`${MLB}/v1/schedule?sportId=1&date=${todayStr()}`);
    const games = (sched.dates?.[0]?.games || []).filter(
      (g) => g.status?.abstractGameState === "Live" || g.status?.abstractGameState === "Final"
    );
    const out = {};
    for (const g of games) {
      let feed;
      try { feed = await fetchJson(`${MLB}/v1.1/game/${g.gamePk}/feed/live`); }
      catch { continue; }
      const boxTeams = feed.liveData?.boxscore?.teams || {};
      const state = feed.gameData?.status?.abstractGameState;
      const ls = feed.liveData?.linescore;
      const inning = ls ? `${ls.inningState || ""} ${ls.currentInningOrdinal || ""}`.trim() : "";
      for (const side of ["home", "away"]) {
        const pl = boxTeams[side]?.players || {};
        for (const key of Object.keys(pl)) {
          const person = pl[key];
          const pid = person.person?.id;
          if (ids.has(pid)) {
            const bs = person.stats?.batting || {};
            out[pid] = {
              state, inning,
              summary: bs.summary || "",
              opp: side === "home"
                ? `vs ${feed.gameData?.teams?.away?.abbreviation || ""}`
                : `@ ${feed.gameData?.teams?.home?.abbreviation || ""}`,
              line: {
                ab: bs.atBats ?? 0, h: bs.hits ?? 0, hr: bs.homeRuns ?? 0,
                rbi: bs.rbi ?? 0, r: bs.runs ?? 0, bb: bs.baseOnBalls ?? 0, k: bs.strikeOuts ?? 0,
              },
            };
          }
        }
      }
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "live fetch failed", detail: e.message });
  }
});

// ---- serve the frontend ---------------------------------------------------
app.use(express.static(join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`SLY Watchlist running on http://localhost:${PORT}`);
});
