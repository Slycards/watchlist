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
// Savant's JSON leaderboard endpoints return an HTML page with data embedded,
// which is why direct JSON parsing failed ("unexpected character at position 23").
// The stable, documented way (used by pybaseball/baseballr) is the CSV download.
// We fetch CSV, parse by HEADER NAME so we don't depend on column order, and
// merge expected-stats with exit-velocity/barrels by player_id.
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  // simple CSV split that tolerates quoted fields
  const splitRow = (line) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { q = !q; }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.replace(/^"|"$/g, "").trim());
  };
  const headers = splitRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx]; });
    rows.push(obj);
  }
  return rows;
}

async function fetchCsv(url) {
  const r = await fetch(url, { headers: { "User-Agent": "sly-watchlist/1.0" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return parseCsv(await r.text());
}

async function getStatcastMap() {
  const key = `statcast:${todayStr()}`;
  const cached = getCached(key);
  if (cached) return cached;

  const pick = (row, keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && row[k] !== "") return num(row[k]);
    }
    return null;
  };
  const idOf = (row) => Number(row.player_id || row.playerId || row.id);

  let map = {};

  // 1) Expected statistics (xwOBA, xBA, xSLG, actual wOBA, K%, BB%)
  try {
    const url = `${SAVANT}/leaderboard/expected_statistics?type=batter&year=${SEASON}&position=&team=&min=q&csv=true`;
    const rows = await fetchCsv(url);
    for (const row of rows) {
      const id = idOf(row);
      if (!id) continue;
      map[id] = {
        xwoba: pick(row, ["est_woba", "xwoba"]),
        xba:   pick(row, ["est_ba", "xba"]),
        xslg:  pick(row, ["est_slg", "xslg"]),
        woba:  pick(row, ["woba"]),
        k:     pick(row, ["k_percent", "strikeout_percent"]),
        bb:    pick(row, ["bb_percent", "walk_percent"]),
        barrel: null, hardhit: null, ev: null,
      };
    }
  } catch (e) {
    console.warn("Statcast expected_statistics fetch failed:", e.message);
  }

  // 2) Exit velocity & barrels (barrel%, hard-hit%, avg EV) — CSV lives at /statcast
  try {
    const url = `${SAVANT}/leaderboard/statcast?type=batter&year=${SEASON}&position=&team=&min=q&csv=true`;
    const rows = await fetchCsv(url);
    for (const row of rows) {
      const id = idOf(row);
      if (!id) continue;
      if (!map[id]) map[id] = { xwoba:null,xba:null,xslg:null,woba:null,k:null,bb:null };
      map[id].barrel  = pick(row, ["brl_percent", "barrels_per_bbe_percent", "barrel_batted_rate"]);
      map[id].hardhit = pick(row, ["ev95percent", "hard_hit_percent"]);
      map[id].ev      = pick(row, ["avg_hit_speed", "avg_hit_speed_mph"]);
    }
  } catch (e) {
    console.warn("Statcast exit_velocity fetch failed:", e.message);
  }

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
    // hydrate=team so the schedule includes team abbreviations for previews
    const sched = await fetchJson(`${MLB}/v1/schedule?sportId=1&date=${todayStr()}&hydrate=team,linescore`);
    const allGames = sched.dates?.[0]?.games || [];
    const out = {};
    console.log(`[live] ${todayStr()} — ${allGames.length} games; states:`,
      allGames.map(g => g.status?.abstractGameState).join(","));
    console.log(`[live] requested ids:`, [...ids].join(","));

    // Helper: format a game's UTC start time in Pacific, e.g. "4:05 PM PT"
    const ptTime = (iso) => {
      try {
        return new Date(iso).toLocaleTimeString("en-US", {
          timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
        }) + " PT";
      } catch { return ""; }
    };

    // 1) SCHEDULED games (not started): record a "Preview" entry per rostered player.
    // We can't know a player's roster from the schedule alone, so we tag BOTH teams'
    // matchup onto every id the client asked about IF that id's team is playing.
    // Simpler: for preview we attach matchup by team id, resolved when we see the
    // player's team in live/final games. For scheduled games we include the matchup
    // keyed by the two team ids, and the client matches via the player's team id.
    const previewByTeam = {}; // teamId -> {state:"Preview", time, matchup}
    for (const g of allGames) {
      const st = g.status?.abstractGameState;
      if (st !== "Preview") continue;
      const away = g.teams?.away?.team, home = g.teams?.home?.team;
      const awayAbbr = away?.abbreviation || away?.teamName || "AWY";
      const homeAbbr = home?.abbreviation || home?.teamName || "HOM";
      const matchup = `${awayAbbr} @ ${homeAbbr}`;
      const time = ptTime(g.gameDate);
      const info = { state: "Preview", time, matchup };
      if (away?.id) previewByTeam[away.id] = info;
      if (home?.id) previewByTeam[home.id] = info;
    }

    // 2) LIVE / FINAL games: pull the feed and attach per-player box lines.
    const activeGames = allGames.filter(
      (g) => g.status?.abstractGameState === "Live" || g.status?.abstractGameState === "Final"
    );
    for (const g of activeGames) {
      let feed;
      try { feed = await fetchJson(`${MLB}/v1.1/game/${g.gamePk}/feed/live`); }
      catch { continue; }
      const boxTeams = feed.liveData?.boxscore?.teams || {};
      const state = feed.gameData?.status?.abstractGameState;
      const ls = feed.liveData?.linescore;
      const inning = ls ? `${ls.inningState || ""} ${ls.currentInningOrdinal || ""}`.trim() : "";
      const awayAbbr = feed.gameData?.teams?.away?.abbreviation || "";
      const homeAbbr = feed.gameData?.teams?.home?.abbreviation || "";
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
              matchup: `${awayAbbr} @ ${homeAbbr}`,
              opp: side === "home" ? `vs ${awayAbbr}` : `@ ${homeAbbr}`,
              line: {
                ab: bs.atBats ?? 0, h: bs.hits ?? 0, hr: bs.homeRuns ?? 0,
                rbi: bs.rbi ?? 0, r: bs.runs ?? 0, bb: bs.baseOnBalls ?? 0, k: bs.strikeOuts ?? 0,
              },
            };
          }
        }
      }
    }

    // 3) For any requested player NOT already in a live/final game, see if their
    // team has a scheduled game today. We need the player's team id, so look it up.
    const missing = [...ids].filter((id) => !out[id]);
    console.log(`[live] preview teams:`, Object.keys(previewByTeam).join(",") || "none",
      "| missing after live/final:", missing.join(",") || "none");
    if (missing.length && Object.keys(previewByTeam).length) {
      await Promise.all(missing.map(async (id) => {
        try {
          const pj = await fetchJson(`${MLB}/v1/people/${id}`);
          const teamId = pj.people?.[0]?.currentTeam?.id;
          console.log(`[live] player ${id} teamId=${teamId} previewMatch=${!!previewByTeam[teamId]}`);
          if (teamId && previewByTeam[teamId]) out[id] = previewByTeam[teamId];
        } catch (e) { console.log(`[live] player ${id} lookup failed:`, e.message); }
      }));
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
