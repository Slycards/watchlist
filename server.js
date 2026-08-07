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
//   GET /api/player/:id               -> {season, splits:{d7,d15,d30}}
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
// MLB defines a "game day" on the US East Coast, and Render's servers run on
// UTC — so using UTC midnight rolls the date over too early (a late-evening
// Pacific game would pull TOMORROW's schedule). Anchor "today" to US Eastern.
function todayStr() {
  // en-CA gives YYYY-MM-DD formatting; timeZone pins it to Eastern.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}



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
    // hydrate=currentTeam so results include the player's team (otherwise blank → "FA")
    const j = await fetchJson(`${MLB}/v1/people/search?names=${encodeURIComponent(q)}&hydrate=currentTeam`);
    let people = (j.people || []).map((p) => ({
      id: p.id,
      name: p.fullName,
      team: p.currentTeam?.abbreviation || p.currentTeam?.name || "",
      pos: p.primaryPosition?.abbreviation || "",
      active: p.active,
    }));
    // Fallback: /people/search often omits teams even with hydrate. For results
    // still missing a team, fetch it directly (limited to the top few to stay fast).
    const needTeam = people.slice(0, 8).filter((p) => !p.team);
    console.log(`[search] q="${q}" results=${people.length} missingTeam=${needTeam.length}`);
    if (needTeam.length) {
      await Promise.all(needTeam.map(async (p) => {
        try {
          const pj = await fetchJson(`${MLB}/v1/people/${p.id}?hydrate=currentTeam`);
          const person = pj.people?.[0];
          const ct = person?.currentTeam;
          console.log(`[search] ${p.name} (${p.id}) currentTeam=${JSON.stringify(ct)}`);
          if (ct) p.team = ct.abbreviation || ct.name || "";
        } catch (e) { console.log(`[search] ${p.name} lookup failed:`, e.message); }
      }));
    }
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

// Player — season line and rolling splits.
app.get("/api/player/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "bad id" });
  const key = `player:${id}:${todayStr()}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);

  try {
    const [seasonJ, logJ] = await Promise.all([
      fetchJson(`${MLB}/v1/people/${id}/stats?stats=season&group=hitting&season=${SEASON}`),
      fetchJson(`${MLB}/v1/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`),
    ]);

    const s = seasonJ.stats?.[0]?.splits?.[0]?.stat;
    const season = s ? {
      games: +s.gamesPlayed || 0, ab: +s.atBats || 0,
      avg: +s.avg, obp: +s.obp, slg: +s.slg, ops: +s.ops,
      hr: +s.homeRuns, rbi: +s.rbi, r: +s.runs, h: +s.hits,
      bb: +s.baseOnBalls, k: +s.strikeOuts, sb: +s.stolenBases,
    } : null;

    const logs = logJ.stats?.[0]?.splits || [];
    // Sort oldest→newest by date, then take the last N GAMES (not days) so the
    // 7/15/30 splits mirror MLB.com's "Last 7/15/30 Games" splits.
    const ordered = [...logs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const lastN = (n) => ordered.slice(Math.max(0, ordered.length - n));
    const splits = {
      d7: aggregate(lastN(7)),
      d15: aggregate(lastN(15)),
      d30: aggregate(lastN(30)),
    };

    // Most recent completed game — used by the Today tab as a fallback when the
    // player has no game today (fills the gap between yesterday's game and the
    // next one, and covers late-night Pacific timezone edges).
    const lg = ordered[ordered.length - 1];
    let lastGame = null;
    if (lg) {
      const st = lg.stat || {};
      lastGame = {
        date: lg.date || "",
        opp: lg.opponent?.name || lg.team?.name || "",
        line: {
          ab: +st.atBats || 0, h: +st.hits || 0, hr: +st.homeRuns || 0,
          rbi: +st.rbi || 0, r: +st.runs || 0, sb: +st.stolenBases || 0,
        },
      };
    }

    const payload = { id, season, splits, lastGame };
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
                rbi: bs.rbi ?? 0, r: bs.runs ?? 0, sb: bs.stolenBases ?? 0,
                bb: bs.baseOnBalls ?? 0, k: bs.strikeOuts ?? 0,
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
          // hydrate=currentTeam forces the team object to populate; plain
          // /people/{id} often omits it (that was the "teamId=undefined" bug).
          const pj = await fetchJson(`${MLB}/v1/people/${id}?hydrate=currentTeam`);
          let teamId = pj.people?.[0]?.currentTeam?.id;
          // fallback: derive team from this season's hitting stats
          if (!teamId) {
            try {
              const sj = await fetchJson(`${MLB}/v1/people/${id}/stats?stats=season&group=hitting&season=${SEASON}`);
              teamId = sj.stats?.[0]?.splits?.[0]?.team?.id;
            } catch { /* ignore */ }
          }
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
