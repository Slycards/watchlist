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

// Common informal-first-name -> formal/legal-name expansions. MLB registers
// players under their full legal first name, but young prospects are almost
// always covered publicly by an informal version — this is a real, permanent
// characteristic of the data (confirmed with JoJo Parker -> "Joseph Parker"
// and Josh Hammond -> "Joshua ... Hammond"), not something a smarter query
// alone can work around. Not exhaustive, but covers the common English pairs.
const NICKNAME_EXPANSIONS = {
  jojo: "joseph", jo: "joseph", joey: "joseph", joe: "joseph",
  josh: "joshua",
  alex: "alexander", nick: "nicholas", mike: "michael", mikey: "michael",
  will: "william", billy: "william", bill: "william",
  matt: "matthew", chris: "christopher", tony: "anthony",
  rob: "robert", bobby: "robert", bob: "robert",
  dan: "daniel", danny: "daniel",
  andy: "andrew", drew: "andrew",
  tom: "thomas", tommy: "thomas",
  sam: "samuel", sammy: "samuel",
  ben: "benjamin", benny: "benjamin",
  jim: "james", jimmy: "james",
  ricky: "richard", rick: "richard",
  ted: "edward", eddie: "edward", ed: "edward",
  frank: "francis", frankie: "francis",
  gabe: "gabriel",
  zack: "zachary", zach: "zachary",
  jake: "jacob",
  nate: "nathaniel", nat: "nathaniel",
  tim: "timothy", timmy: "timothy",
  greg: "gregory",
  ken: "kenneth", kenny: "kenneth",
  steve: "steven",
  dave: "david",
  ray: "raymond",
  pat: "patrick",
};

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
// "Today" is anchored to Pacific time — the user's timezone — so the schedule
// matches the day THEY'RE experiencing. (UTC rolled over too early; Eastern
// rolled over too late for a Pacific user at night, showing tomorrow's games.)
const TZ = "America/Los_Angeles";
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
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
    const searchOnce = async (query) => {
      const j = await fetchJson(`${MLB}/v1/people/search?names=${encodeURIComponent(query)}&hydrate=currentTeam`);
      return j.people || [];
    };

    let raw = await searchOnce(q);

    // MLB's search endpoint reliably matches a SINGLE word (first name OR last
    // name fragment) but often returns 0 for a combined "First Last" query,
    // even for players who definitely exist — confirmed via logs: "Jojo" alone
    // found him, "Jojo Parker" found nothing. If the full query is empty and
    // has multiple words, try two fallbacks in order of precision:
    if (!raw.length) {
      const words = q.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        // 1) Nickname expansion — many young prospects go by an informal first
        // name publicly while MLB's system has them under their full legal
        // name (confirmed twice tonight: "JoJo Parker" -> registered "Joseph
        // Parker"; "Josh Hammond" -> registered "Joshua ... Hammond"). If the
        // first word is a known nickname, retry the FULL name with it expanded
        // — this is more precise than a bare-surname search (1 hit vs dozens).
        const firstWord = words[0].toLowerCase();
        const formal = NICKNAME_EXPANSIONS[firstWord];
        if (formal) {
          const formalCapitalized = formal.charAt(0).toUpperCase() + formal.slice(1);
          const expandedQuery = [formalCapitalized, ...words.slice(1)].join(" ");
          console.log(`[search] q="${q}" got 0 results, trying nickname expansion "${expandedQuery}"`);
          raw = await searchOnce(expandedQuery);
        }
        // 2) If that didn't help either, fall back to the broader last-word
        // (usually the surname) search — less precise, but reliably finds
        // *something* to scroll through even without a dictionary hit.
        if (!raw.length) {
          const lastWord = words[words.length - 1];
          console.log(`[search] q="${q}" still 0, retrying with last word "${lastWord}"`);
          raw = await searchOnce(lastWord);
          console.log(`[search] "${lastWord}" raw names:`, raw.map(p => p.fullName).join(" | "));

          // A common surname can return dozens of unrelated people. Rather
          // than leave the right one buried wherever MLB's default order puts
          // them, sort so anyone whose first name starts with the SAME letter
          // as what was typed comes first. This generalizes beyond our
          // nickname dictionary — "Josh" and "Joshua" share a first letter
          // even if "Josh" were never explicitly listed, so this still
          // surfaces him near the top for any nickname we haven't thought of.
          const typedFirstLetter = words[0][0]?.toLowerCase();
          if (typedFirstLetter && raw.length > 1) {
            raw = [...raw].sort((a, b) => {
              const aMatch = (a.fullName || "").trim()[0]?.toLowerCase() === typedFirstLetter ? 0 : 1;
              const bMatch = (b.fullName || "").trim()[0]?.toLowerCase() === typedFirstLetter ? 0 : 1;
              return aMatch - bMatch;
            });
            console.log(`[search] sorted "${lastWord}" results — first-letter "${typedFirstLetter}" matches prioritized`);
            console.log(`[search] top 10 after sort:`, raw.slice(0,10).map(p => p.fullName).join(" | "));
          }
        }
      }
    }

    let people = raw.map((p) => ({
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

// ---- level detection for minor leaguers ------------------------------------
// MLB Advanced Media assigns one person ID across every level (complex ball
// up through MLB), and the same stats/schedule/live-feed endpoints work at
// every level via &sportId=N. We check MLB first using the EXACT call already
// used for established players (no sportId param — unchanged from before),
// and only probe the minors as a fallback. This adds zero risk to players who
// already worked, since their request is byte-for-byte identical to before.
const LEVELS = [
  { sportId: null, label: "MLB" },   // null = omit sportId (existing behavior)
  { sportId: 11, label: "Triple-A" },
  { sportId: 12, label: "Double-A" },
  { sportId: 13, label: "High-A" },
  { sportId: 14, label: "Single-A" },
  { sportId: 16, label: "Rookie" },
];

async function getPlayerLevel(id) {
  const key = `level:${id}:${todayStr()}`;
  const cached = getCached(key);
  if (cached) return cached;

  for (const lvl of LEVELS) {
    try {
      const sportParam = lvl.sportId ? `&sportId=${lvl.sportId}` : "";
      const j = await fetchJson(`${MLB}/v1/people/${id}/stats?stats=season&group=hitting&season=${SEASON}${sportParam}`);
      const games = +(j.stats?.[0]?.splits?.[0]?.stat?.gamesPlayed || 0);
      if (games > 0) {
        console.log(`[level] player ${id} -> ${lvl.label} (${games} games)`);
        setCached(key, lvl, 6 * 60 * 60 * 1000);
        return lvl;
      }
    } catch (e) { /* try next level */ }
  }
  // No games at any level (e.g. signed but not yet debuted) — default to MLB
  // so the rest of the app degrades exactly like it always has ("no data").
  console.log(`[level] player ${id} -> no games at any level, defaulting to MLB`);
  const fallback = LEVELS[0];
  setCached(key, fallback, 60 * 60 * 1000); // shorter TTL — recheck sooner
  return fallback;
}

// Player — season line and rolling splits.
app.get("/api/player/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "bad id" });
  const key = `player:${id}:${todayStr()}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);

  try {
    const level = await getPlayerLevel(id);
    const sportParam = level.sportId ? `&sportId=${level.sportId}` : "";

    const [seasonJ, logJ, statusJ] = await Promise.all([
      fetchJson(`${MLB}/v1/people/${id}/stats?stats=season&group=hitting&season=${SEASON}${sportParam}`),
      fetchJson(`${MLB}/v1/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}${sportParam}`),
      fetchJson(`${MLB}/v1/people/${id}?hydrate=currentTeam`).catch(() => null),
    ]);

    // ---- injured-list status (MLB only — minor-league roster status works
    // differently, so we skip it for prospects rather than show something wrong) ----
    let il = null;
    if (level.sportId === null) {
    try {
      const teamId = statusJ?.people?.[0]?.currentTeam?.id;
      if (teamId) {
        const rosterKey = `roster:${teamId}`;
        let roster = getCached(rosterKey);
        if (!roster) {
          const rj = await fetchJson(`${MLB}/v1/teams/${teamId}/roster?rosterType=fullRoster`);
          roster = rj.roster || [];
          setCached(rosterKey, roster, 60 * 60 * 1000);
        }
        const entry = roster.find((r) => r.person?.id === id);
        const code = (entry?.status?.code || "").toUpperCase();
        const desc = entry?.status?.description || "";
        const onIL = code.startsWith("D") || /injured|(\bIL\b)|disabled/i.test(desc);
        if (onIL) {
          const m = desc.match(/(\d+)\s*-?\s*day/i);
          const codeNum = code.match(/D(\d+)/);
          const days = m ? m[1] : (codeNum ? codeNum[1] : "");
          il = { label: days ? `IL-${days}` : "IL" };
        }
      }
    } catch { /* il stays null — badge just won't show */ }
    }

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

    const payload = { id, season, splits, lastGame, il, level: level.label };
    setCached(key, payload, 15 * 60 * 1000); // 15 min — game logs update post-game
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: "player fetch failed", detail: e.message });
  }
});

// Live — today's games, matched to the requested player ids. Players are
// grouped by their detected level (see getPlayerLevel) so each level's
// schedule is fetched only once — an MLB-only watchlist costs exactly what
// it did before; a mixed watchlist costs one extra schedule call per level.
app.get("/api/live", async (req, res) => {
  const ids = [...new Set((req.query.ids || "").split(",").map(Number).filter(Boolean))];
  if (!ids.length) return res.json({});
  try {
    const levelById = {};
    await Promise.all(ids.map(async (id) => { levelById[id] = await getPlayerLevel(id); }));
    const groups = new Map(); // group key ("mlb" or sportId) -> [ids]
    for (const id of ids) {
      const lvl = levelById[id];
      const gkey = lvl.sportId ?? "mlb";
      if (!groups.has(gkey)) groups.set(gkey, []);
      groups.get(gkey).push(id);
    }

    const out = {};
    const ptTime = (iso) => {
      try {
        return new Date(iso).toLocaleTimeString("en-US", {
          timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
        }) + " PT";
      } catch { return ""; }
    };

    for (const [gkey, groupIds] of groups) {
      const sportId = gkey === "mlb" ? 1 : gkey;
      const idSet = new Set(groupIds);
      try {
        const sched = await fetchJson(`${MLB}/v1/schedule?sportId=${sportId}&date=${todayStr()}&hydrate=team,linescore`);
        const allGames = sched.dates?.[0]?.games || [];
        console.log(`[live] sportId=${sportId} ${todayStr()} — ${allGames.length} games; ids ${groupIds.join(",")}`);

        // 1) SCHEDULED games: tag the matchup by team id.
        const previewByTeam = {};
        for (const g of allGames) {
          if (g.status?.abstractGameState !== "Preview") continue;
          const away = g.teams?.away?.team, home = g.teams?.home?.team;
          const awayAbbr = away?.abbreviation || away?.teamName || "AWY";
          const homeAbbr = home?.abbreviation || home?.teamName || "HOM";
          const info = { state: "Preview", time: ptTime(g.gameDate), matchup: `${awayAbbr} @ ${homeAbbr}` };
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
              if (idSet.has(pid)) {
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

        // 3) Any requested player not already matched: check if their team
        // has a scheduled game today.
        const missing = groupIds.filter((id) => !out[id]);
        if (missing.length && Object.keys(previewByTeam).length) {
          await Promise.all(missing.map(async (id) => {
            try {
              const pj = await fetchJson(`${MLB}/v1/people/${id}?hydrate=currentTeam`);
              const teamId = pj.people?.[0]?.currentTeam?.id;
              if (teamId && previewByTeam[teamId]) out[id] = previewByTeam[teamId];
            } catch { /* skip */ }
          }));
        }
      } catch (e) {
        console.log(`[live] sportId=${sportId} fetch failed:`, e.message);
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
