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
import { Pool } from "pg";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Accounts — lets a watchlist follow you across devices via a generated code.
// Render wipes this server's own filesystem on every deploy, so the watchlist
// itself can't live here — it lives in a separate managed Postgres database
// (set DATABASE_URL in Render's environment variables once that's attached).
// Everything else in this file works exactly the same with or without it —
// only /api/account/* depends on the database being configured.
// ---------------------------------------------------------------------------
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initAccountSchema() {
  if (!pool) {
    console.log("[accounts] DATABASE_URL not set — account sync is disabled, everything else works normally.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      code TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("[accounts] schema ready.");
}
function generateAccountCode() {
  // 15 random bytes -> ~20 base64url characters, 120 bits of entropy — long
  // enough to be practically unguessable, which matters once this is shared
  // among friends rather than just one person's own devices.
  return crypto.randomBytes(15).toString("base64url");
}

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
// ---- heat band: compares a window's OPS to season OPS, per-window thresholds ----
// Shorter windows are naturally noisier (a week's OPS swings ~100+ points from
// pure randomness), so the bands widen as the window shortens — "Hot" should
// mean a genuinely notable move at any window, not just common variance.
const HEAT_THRESHOLDS = {
  d7:  { steady: 0.075, band: 0.150, minGames: 4 },
  d15: { steady: 0.060, band: 0.120, minGames: 6 },
  d30: { steady: 0.050, band: 0.100, minGames: 10 },
};
function heatBand(windowKey, windowOps, windowGames, seasonOps) {
  const t = HEAT_THRESHOLDS[windowKey];
  if (!t) return null;
  if (windowOps == null || seasonOps == null || isNaN(windowOps) || isNaN(seasonOps)) return null;
  if ((windowGames || 0) < t.minGames) return null; // sample too small to trust
  const delta = windowOps - seasonOps;
  let key, label;
  if (delta >= t.band) { key = "hot"; label = "Hot"; }
  else if (delta >= t.steady) { key = "heating"; label = "Heating Up"; }
  else if (delta <= -t.band) { key = "cold"; label = "Cold"; }
  else if (delta <= -t.steady) { key = "cooling"; label = "Cooling"; }
  else { key = "steady"; label = "Steady"; }
  return { key, label, delta, edge: t.band };
}

// Season Heat Meter Score — two blended dimensions rather than one:
//   MOMENTUM: a cascade comparing each window to the one just above it
//     (7-vs-15, 15-vs-30, 30-vs-season), recency-weighted 0.5/0.3/0.2, so a
//     genuinely accelerating or fading trend moves the score even when the
//     player's overall level hasn't obviously changed yet.
//   CONSISTENCY: how far ABOVE or below season each window sits, averaged —
//     so a player who's been steadily elevated (or steadily cold) the whole
//     stretch scores accordingly even with zero momentum, rather than a
//     purely trend-based score flattening a real, sustained level to neutral.
// Each half is scaled onto a -5..+5 range (divide by .120, clamp) before
// blending 50/50 around a neutral base of 5, then the whole thing clamps to
// 0-10. Missing windows drop out of momentum's cascade (with the remaining
// terms' weights renormalized) and out of consistency's average, rather than
// forcing a guess from data that isn't there.
//
// CONFIDENCE SHRINKAGE — a thin sample can still produce an extreme raw
// score (one hot game inside an otherwise cold stretch), even though there
// isn't really enough evidence behind it to trust that strongly. Rather than
// a hard cutoff (window shows or it doesn't), each window's sample depth is
// compared against the real MLB batting-title qualification rate — 3.1 plate
// appearances per scheduled game (Rule 9.22) — and the final score is pulled
// toward neutral (5) in proportion to how far short of that the data falls.
// A window at or above the real qualifying rate is trusted at full strength;
// a thinner one gets progressively more weight taken off the final read.
const PA_PER_GAME_QUALIFYING = 3.1; // official MLB rate, Rule 9.22
const FULL_PA = { d7: PA_PER_GAME_QUALIFYING * 7, d15: PA_PER_GAME_QUALIFYING * 15, d30: PA_PER_GAME_QUALIFYING * 30 };
function paOf(w) {
  if (!w) return null;
  return (w.ab || 0) + (w.bb || 0) + (w.hbp || 0) + (w.sf || 0);
}
function seasonHeatScore(d7Ops, d15Ops, d30Ops, seasonOps, d7Win, d15Win, d30Win) {
  if (seasonOps == null) return null;
  const scale = (x) => Math.max(-5, Math.min(5, 5 * (x / 0.120)));

  const cascadeTerms = [];
  if (d7Ops != null && d15Ops != null) cascadeTerms.push([0.5, scale(d7Ops - d15Ops)]);
  if (d15Ops != null && d30Ops != null) cascadeTerms.push([0.3, scale(d15Ops - d30Ops)]);
  if (d30Ops != null) cascadeTerms.push([0.2, scale(d30Ops - seasonOps)]);
  let momentum = 0;
  if (cascadeTerms.length) {
    const totalWeight = cascadeTerms.reduce((s, [w]) => s + w, 0);
    momentum = cascadeTerms.reduce((s, [w, v]) => s + w * v, 0) / totalWeight;
  }

  const diffs = [d7Ops, d15Ops, d30Ops].filter((v) => v != null).map((v) => v - seasonOps);
  if (!diffs.length) return null; // no window data at all — nothing to score
  const consistency = scale(diffs.reduce((a, b) => a + b, 0) / diffs.length);

  const raw = Math.max(0, Math.min(10, 5 + 0.5 * momentum + 0.5 * consistency));

  const confidences = [];
  const pa7 = paOf(d7Win), pa15 = paOf(d15Win), pa30 = paOf(d30Win);
  if (pa7 != null) confidences.push(Math.min(1, pa7 / FULL_PA.d7));
  if (pa15 != null) confidences.push(Math.min(1, pa15 / FULL_PA.d15));
  if (pa30 != null) confidences.push(Math.min(1, pa30 / FULL_PA.d30));
  const confidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 1;

  const shrunk = 5 + confidence * (raw - 5);
  return Math.round(shrunk * 10) / 10;
}

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
    hbp: t.hbp, sf: t.sf,
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
    const j = await fetchJson(`${MLB}/v1/people/${id}?hydrate=currentTeam`);
    const p = j.people?.[0];
    if (!p) return res.status(404).json({ error: "not found" });
    res.json({
      id: p.id, name: p.fullName,
      team: p.currentTeam?.name || "", pos: p.primaryPosition?.abbreviation || "",
      teamId: p.currentTeam?.id || null, // for the team logo — mlbstatic.com/team-logos/{teamId}.svg
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
      hbp: +s.hitByPitch || 0, sf: +s.sacFlies || 0,
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
    // heat band per window — compares that window's OPS to season OPS.
    // Only meaningful once we know the season OPS to compare against.
    if (season) {
      splits.d7.heat = heatBand("d7", splits.d7.ops, splits.d7.games, season.ops);
      splits.d15.heat = heatBand("d15", splits.d15.ops, splits.d15.games, season.ops);
      splits.d30.heat = heatBand("d30", splits.d30.ops, splits.d30.games, season.ops);
    }

    // Heat Meter Score — see seasonHeatScore() above for the full model.
    // Uses window OPS directly (not the banded heat.delta), since momentum
    // needs the actual gap between windows, not just each one's gap to season.
    let heatScore = null;
    if (season) {
      const d7ok = splits.d7?.games >= HEAT_THRESHOLDS.d7.minGames;
      const d15ok = splits.d15?.games >= HEAT_THRESHOLDS.d15.minGames;
      const d30ok = splits.d30?.games >= HEAT_THRESHOLDS.d30.minGames;
      heatScore = seasonHeatScore(
        d7ok ? splits.d7.ops : null,
        d15ok ? splits.d15.ops : null,
        d30ok ? splits.d30.ops : null,
        season.ops,
        d7ok ? splits.d7 : null,
        d15ok ? splits.d15 : null,
        d30ok ? splits.d30 : null
      );
    }


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
      // Final score of that specific game — an extra fetch (unlike the live
      // score, which reuses data already being pulled), so it only fires for
      // players actually in the PREV state, not on every request.
      if (lg.game?.gamePk) {
        try {
          const feed = await fetchJson(`${MLB}/v1.1/game/${lg.game.gamePk}/feed/live`);
          const ls = feed.liveData?.linescore;
          if (ls) {
            lastGame.score = {
              away: ls.teams?.away?.runs ?? 0, home: ls.teams?.home?.runs ?? 0,
              awayAbbr: feed.gameData?.teams?.away?.abbreviation || "",
              homeAbbr: feed.gameData?.teams?.home?.abbreviation || "",
            };
          }
        } catch { /* score just won't show — everything else on the card still works */ }
      }
    }

    const payload = { id, season, splits, lastGame, il, level: level.label, heatScore };
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
          // Team score — already sitting in the same linescore object fetched
          // above for the inning display, just wasn't being read until now.
          const score = ls ? {
            away: ls.teams?.away?.runs ?? 0, home: ls.teams?.home?.runs ?? 0,
            awayAbbr, homeAbbr,
          } : null;
          for (const side of ["home", "away"]) {
            const pl = boxTeams[side]?.players || {};
            for (const key of Object.keys(pl)) {
              const person = pl[key];
              const pid = person.person?.id;
              if (idSet.has(pid)) {
                const bs = person.stats?.batting || {};
                out[pid] = {
                  state, inning, score,
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
        const teamByPlayer = {}; // reused in step 4 below — avoids a duplicate fetch
        if (missing.length) {
          await Promise.all(missing.map(async (id) => {
            try {
              const pj = await fetchJson(`${MLB}/v1/people/${id}?hydrate=currentTeam`);
              const teamId = pj.people?.[0]?.currentTeam?.id;
              if (teamId) {
                teamByPlayer[id] = teamId;
                if (previewByTeam[teamId]) out[id] = previewByTeam[teamId];
              }
            } catch { /* skip */ }
          }));
        }

        // 4) Still no game today: look ahead up to a week for their NEXT
        // scheduled game instead of falling back to their last one. One
        // wider date-range fetch covers every team at this level — same
        // "one call, match everyone against it" shape as today's schedule
        // above, not a separate request per player or per team.
        const stillMissing = groupIds.filter((id) => !out[id] && teamByPlayer[id]);
        if (stillMissing.length) {
          console.log(`[live] sportId=${sportId} still missing after today's check: ids ${stillMissing.join(",")}; teams ${stillMissing.map(id=>teamByPlayer[id]).join(",")}`);
          const start = new Date(); start.setDate(start.getDate() + 1);
          const end = new Date(); end.setDate(end.getDate() + 7);
          const fmt = (d) => d.toISOString().slice(0, 10);
          try {
            const future = await fetchJson(
              `${MLB}/v1/schedule?sportId=${sportId}&startDate=${fmt(start)}&endDate=${fmt(end)}&hydrate=team`
            );
            const totalGames = (future.dates || []).reduce((s, d) => s + (d.games?.length || 0), 0);
            console.log(`[live] sportId=${sportId} future lookahead ${fmt(start)}..${fmt(end)} — ${(future.dates||[]).length} dates, ${totalGames} games total`);
            const nextByTeam = {}; // teamId -> earliest upcoming {date, matchup}
            for (const dateEntry of future.dates || []) {
              for (const g of dateEntry.games || []) {
                const away = g.teams?.away?.team, home = g.teams?.home?.team;
                const awayAbbr = away?.abbreviation || away?.teamName || "AWY";
                const homeAbbr = home?.abbreviation || home?.teamName || "HOM";
                const info = { state: "Next", date: dateEntry.date, matchup: `${awayAbbr} @ ${homeAbbr}` };
                if (away?.id && !nextByTeam[away.id]) nextByTeam[away.id] = info;
                if (home?.id && !nextByTeam[home.id]) nextByTeam[home.id] = info;
              }
            }
            console.log(`[live] sportId=${sportId} teams found in lookahead: ${Object.keys(nextByTeam).join(",")}`);
            for (const id of stillMissing) {
              const teamId = teamByPlayer[id];
              const info = nextByTeam[teamId];
              if (info) {
                out[id] = info;
                console.log(`[live] id=${id} team=${teamId} -> matched next game ${info.date} ${info.matchup}`);
              } else {
                console.log(`[live] id=${id} team=${teamId} -> NO match in lookahead (their team has no game in this window, or team id mismatch)`);
              }
            }
          } catch (e) {
            console.log(`[live] next-game lookup failed for sportId=${sportId}:`, e.message);
          }
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

// ---- accounts: create / load / save a synced watchlist -------------------
app.use(express.json({ limit: "2mb" })); // only the account save endpoint needs a body

function requireDb(res) {
  if (!pool) {
    res.status(503).json({ error: "Account sync isn't set up on this server yet (no database attached)." });
    return false;
  }
  return true;
}

// Create a new account — generates a code, returns it once. There's no
// password recovery, so the frontend needs to make clear this code is the
// only way back in.
app.post("/api/account", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    let code;
    for (let tries = 0; tries < 5; tries++) {
      code = generateAccountCode();
      const existing = await pool.query("SELECT 1 FROM accounts WHERE code=$1", [code]);
      if (existing.rowCount === 0) break; // practically never collides at this entropy, but check anyway
    }
    await pool.query("INSERT INTO accounts (code, data) VALUES ($1, $2)", [code, "{}"]);
    res.json({ code });
  } catch (e) {
    res.status(502).json({ error: "account creation failed", detail: e.message });
  }
});

// Load a watchlist by code — this is what "logging in on another device" does.
app.get("/api/account/:code", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const result = await pool.query("SELECT data FROM accounts WHERE code=$1", [req.params.code]);
    if (result.rowCount === 0) return res.status(404).json({ error: "no account with that code" });
    res.json(result.rows[0].data);
  } catch (e) {
    res.status(502).json({ error: "account load failed", detail: e.message });
  }
});

// Save the current watchlist under a code — called by the frontend a short
// moment after anything changes, not on every single keystroke/drag tick.
app.put("/api/account/:code", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const result = await pool.query(
      "UPDATE accounts SET data=$2, updated_at=now() WHERE code=$1",
      [req.params.code, JSON.stringify(req.body || {})]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "no account with that code" });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "account save failed", detail: e.message });
  }
});

// ---- serve the frontend ---------------------------------------------------
app.use(express.static(join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

initAccountSchema().finally(() => {
  app.listen(PORT, () => {
    console.log(`SLY Watchlist running on http://localhost:${PORT}`);
  });
});
