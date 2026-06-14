#!/usr/bin/env node
/* ============================================================================
   update-data.mjs — Mise à jour automatique de data.json (SANS Claude)
   ----------------------------------------------------------------------------
   Récupère les matchs de la Coupe du Monde 2026 du jour (et de la veille pour
   les matchs de nuit) depuis l'API publique FotMob, les traduit au format de
   l'overlay « data.json » lu par index.html, et écrit le fichier.

   index.html relit data.json toutes les 60 s et fusionne ces matchs par-dessus
   les données intégrées : il suffit donc de garder ce fichier à jour pour que
   les scores live/terminés s'affichent, SANS republier la page.

   Ce script ne couvre QUE la phase de groupes (mapping équipe→groupe
   déterministe). La phase finale et les actus/buteurs « propres » restent
   gérées par la tâche Claude quotidienne.

   Usage : node scripts/update-data.mjs
   Variables d'env optionnelles :
     DATA_PATH   chemin du data.json à écrire (défaut: ./data.json)
     FETCH_GOALS "0" pour désactiver la récupération des buteurs (défaut: actif)
     DEBUG       "1" pour des logs détaillés
   ============================================================================ */

import { readFile, writeFile } from "node:fs/promises";

const DATA_PATH = process.env.DATA_PATH || new URL("../data.json", import.meta.url).pathname;
const FETCH_GOALS = process.env.FETCH_GOALS !== "0";
const DEBUG = process.env.DEBUG === "1";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const log = (...a) => DEBUG && console.error("[debug]", ...a);

/* ---- Équipe → lettre de groupe (clés FR = clés de FLAGS dans index.html) ---- */
const GROUP_OF = {
  "Mexique":"A","Afrique du Sud":"A","Corée du Sud":"A","Tchéquie":"A",
  "Canada":"B","Bosnie-Herzégovine":"B","Qatar":"B","Suisse":"B",
  "Brésil":"C","Maroc":"C","Haïti":"C","Écosse":"C",
  "États-Unis":"D","Paraguay":"D","Australie":"D","Türkiye":"D",
  "Allemagne":"E","Curaçao":"E","Côte d'Ivoire":"E","Équateur":"E",
  "Pays-Bas":"F","Japon":"F","Suède":"F","Tunisie":"F",
  "Belgique":"G","Égypte":"G","Iran":"G","Nouvelle-Zélande":"G",
  "Espagne":"H","Cap-Vert":"H","Arabie saoudite":"H","Uruguay":"H",
  "France":"I","Sénégal":"I","Irak":"I","Norvège":"I",
  "Argentine":"J","Algérie":"J","Autriche":"J","Jordanie":"J",
  "Portugal":"K","RD Congo":"K","Ouzbékistan":"K","Colombie":"K",
  "Angleterre":"L","Croatie":"L","Ghana":"L","Panama":"L",
};

/* ---- Alias (nom source FotMob, en anglais) → nom FR ---- */
const ALIASES = {
  "mexico":"Mexique",
  "south africa":"Afrique du Sud",
  "south korea":"Corée du Sud","korea republic":"Corée du Sud",
  "czechia":"Tchéquie","czech republic":"Tchéquie",
  "canada":"Canada",
  "bosnia & herzegovina":"Bosnie-Herzégovine","bosnia and herzegovina":"Bosnie-Herzégovine","bosnia":"Bosnie-Herzégovine",
  "qatar":"Qatar",
  "switzerland":"Suisse",
  "brazil":"Brésil",
  "morocco":"Maroc",
  "haiti":"Haïti",
  "scotland":"Écosse",
  "usa":"États-Unis","united states":"États-Unis","united states of america":"États-Unis",
  "paraguay":"Paraguay",
  "australia":"Australie",
  "turkiye":"Türkiye","turkey":"Türkiye",
  "germany":"Allemagne",
  "curacao":"Curaçao",
  "ivory coast":"Côte d'Ivoire","cote d'ivoire":"Côte d'Ivoire",
  "ecuador":"Équateur",
  "netherlands":"Pays-Bas","holland":"Pays-Bas",
  "japan":"Japon",
  "sweden":"Suède",
  "tunisia":"Tunisie",
  "belgium":"Belgique",
  "egypt":"Égypte",
  "iran":"Iran","ir iran":"Iran",
  "new zealand":"Nouvelle-Zélande",
  "spain":"Espagne",
  "cape verde":"Cap-Vert","cabo verde":"Cap-Vert",
  "saudi arabia":"Arabie saoudite",
  "uruguay":"Uruguay",
  "france":"France",
  "senegal":"Sénégal",
  "iraq":"Irak",
  "norway":"Norvège",
  "argentina":"Argentine",
  "algeria":"Algérie",
  "austria":"Autriche",
  "jordan":"Jordanie",
  "portugal":"Portugal",
  "dr congo":"RD Congo","congo dr":"RD Congo","democratic republic of congo":"RD Congo","congo democratic republic":"RD Congo",
  "uzbekistan":"Ouzbékistan",
  "colombia":"Colombie",
  "england":"Angleterre",
  "croatia":"Croatie",
  "ghana":"Ghana",
  "panama":"Panama",
};

const norm = s => (s || "")
  .toString().trim().toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, ""); // retire les accents

// Les valeurs FR normalisées pointent aussi vers elles-mêmes (si la source est déjà en FR)
const FR_BY_NORM = {};
for (const fr of Object.keys(GROUP_OF)) FR_BY_NORM[norm(fr)] = fr;
for (const [en, fr] of Object.entries(ALIASES)) FR_BY_NORM[norm(en)] = fr;

const toFr = name => FR_BY_NORM[norm(name)] || null;

/* ---- HTTP JSON avec timeout ---- */
async function getJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "application/json" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

const yyyymmdd = d =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

const isWorldCup = lg => {
  const n = norm(lg?.name);
  return n.includes("world cup") && !n.includes("women") && !n.includes("qualif");
};

/* ---- Statut overlay : "live" | "done" | null (ignoré si pas commencé) ---- */
function statusOf(match) {
  const st = match.status || {};
  if (st.finished || st.reason?.short === "FT" || st.scoreStr && st.finished) return "done";
  if (st.cancelled) return null;
  if (st.started && !st.finished) return "live";
  return null; // à venir → on ne pousse rien (l'HTML porte déjà la fiche)
}

function scoreOf(match) {
  const h = match.home?.score, a = match.away?.score;
  if (h == null || a == null) return null;
  return `${h}-${a}`;
}

/* ---- Buteurs (best-effort) via matchDetails ---- */
async function goalsOf(matchId, homeFr, awayFr) {
  if (!FETCH_GOALS) return null;
  try {
    const d = await getJSON(`https://www.fotmob.com/api/matchDetails?matchId=${matchId}`, 12000);
    const ev = d?.content?.matchFacts?.events?.events
            || d?.content?.matchFacts?.events
            || [];
    const goals = [];
    for (const e of ev) {
      if (norm(e.type) !== "goal" && !e.isGoal) continue;
      const team = e.isHome ? homeFr : awayFr;
      const min = (e.time != null ? String(e.time) : "") + (e.overloadTime ? "+" + e.overloadTime : "");
      const name = e.player?.name || e.nameStr || e.fullName || "";
      if (!name || !min) continue;
      const g = { p: name.split(" ").slice(-1).join(" "), t: team, m: min };
      const desc = norm(e.goalDescription || e.type || "");
      if (e.ownGoal || desc.includes("own")) { g.og = true; g.t = e.isHome ? awayFr : homeFr; }
      if (desc.includes("penalty")) g.pen = true;
      goals.push(g);
    }
    return goals.length ? goals : null;
  } catch (err) {
    log("goalsOf échec", matchId, err.message);
    return null;
  }
}

async function collectForDate(dateStr) {
  let payload;
  try {
    payload = await getJSON(`https://www.fotmob.com/api/matches?date=${dateStr}&timezone=UTC`);
  } catch (err) {
    log("matches?date échec", dateStr, err.message);
    return [];
  }
  const leagues = (payload?.leagues || []).filter(isWorldCup);
  const out = [];
  for (const lg of leagues) {
    for (const m of (lg.matches || [])) {
      const st = statusOf(m);
      if (!st) continue;
      const home = toFr(m.home?.name || m.home?.longName);
      const away = toFr(m.away?.name || m.away?.longName);
      if (!home || !away) { log("équipe non mappée", m.home?.name, m.away?.name); continue; }
      const g = GROUP_OF[home];
      if (!g || GROUP_OF[away] !== g) { log("hors phase de groupes / groupes incohérents", home, away); continue; }
      const s = scoreOf(m);
      const row = { g, home, away, st };
      if (s) row.s = s;
      const goals = await goalsOf(m.id, home, away);
      if (goals) row.goals = goals;
      out.push(row);
    }
  }
  return out;
}

async function main() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600e3);

  // Matchs d'aujourd'hui + ceux d'hier (les matchs de nuit débordent sur la veille UTC)
  const dates = [yyyymmdd(yesterday), yyyymmdd(now)];
  const seen = new Set();
  const matches = [];
  for (const d of dates) {
    for (const row of await collectForDate(d)) {
      const k = row.g + "|" + row.home + "|" + row.away;
      if (seen.has(k)) continue;
      seen.add(k);
      matches.push(row);
    }
  }

  const lastUpdate = yyyymmdd(now).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  const data = { lastUpdate, matches };

  // N'écrire que si le contenu a changé (évite les commits vides)
  let prev = "";
  try { prev = await readFile(DATA_PATH, "utf8"); } catch {}
  const next = JSON.stringify(data, null, 2) + "\n";
  if (norm(prev) === norm(next)) {
    console.log(`Aucun changement (${matches.length} match(s) live/terminé(s)).`);
    return;
  }
  await writeFile(DATA_PATH, next, "utf8");
  console.log(`data.json mis à jour : ${matches.length} match(s) live/terminé(s) — lastUpdate ${lastUpdate}.`);
}

main().catch(err => { console.error("Erreur fatale :", err); process.exit(1); });
