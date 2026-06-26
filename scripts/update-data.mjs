#!/usr/bin/env node
/* ============================================================================
   update-data.mjs — Mise à jour automatique de data.json (SANS Claude)
   ----------------------------------------------------------------------------
   Récupère les matchs de la Coupe du Monde 2026 du jour (et de la veille pour
   les matchs de nuit) depuis l'API publique ESPN, les traduit au format de
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

/* ---- Alias (nom source ESPN, en anglais) → nom FR ---- */
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

/* ---- Collecte des matchs de groupe (live/terminés) via ESPN ----
   Remplace FotMob (dont l'endpoint /api/matches renvoyait 404). ESPN porte le
   score ET les buteurs (competitions[0].details), donc plus besoin d'un 2e appel. */
async function collectForDate(dateStr) {
  let sb;
  try {
    sb = await getJSON(`${ESPN}/scoreboard?dates=${dateStr}`);
  } catch (err) {
    log("ESPN scoreboard échec", dateStr, err.message);
    return [];
  }
  const out = [];
  for (const ev of (sb?.events || [])) {
    const comp = ev?.competitions?.[0];
    const cs = comp?.competitors || [];
    const h = cs.find(c => c.homeAway === "home");
    const a = cs.find(c => c.homeAway === "away");
    if (!h || !a) continue;
    const home = toFr(h.team?.displayName || h.team?.name);
    const away = toFr(a.team?.displayName || a.team?.name);
    if (!home || !away) { log("équipe non mappée", h.team?.displayName, a.team?.displayName); continue; }
    const g = GROUP_OF[home];
    if (!g || GROUP_OF[away] !== g) { log("hors phase de groupes", home, away); continue; }
    const state = comp.status?.type?.state || ev.status?.type?.state || "pre";
    const st = state === "in" ? "live" : state === "post" ? "done" : null;
    if (!st) continue; // à venir → rien (l'HTML porte déjà la fiche)
    const row = { g, home, away, st };
    const hs = h.score, as = a.score;
    if (hs != null && hs !== "" && as != null && as !== "") row.s = `${hs}-${as}`;
    if (FETCH_GOALS) {
      const idTeam = {};
      cs.forEach(c => { if (c.team) idTeam[String(c.team.id)] = (c.homeAway === "home") ? home : away; });
      const goals = [];
      for (const d of (comp.details || [])) {
        if (d.scoringPlay !== true) continue;
        const scored = idTeam[String(d.team?.id)] || home;
        const min = ((d.clock?.displayValue) || (d.type?.displayValue) || "").replace(/'/g, "");
        const full = d.athletesInvolved?.[0]?.displayName || "";
        if (!full || !min) continue;
        const goal = { p: full.split(" ").slice(-1).join(" "), t: scored, m: min };
        if (d.ownGoal) { goal.og = true; goal.t = (scored === home) ? away : home; }
        if (d.penaltyKick) goal.pen = true;
        goals.push(goal);
      }
      if (goals.length) row.goals = goals;
    }
    out.push(row);
  }
  return out;
}

/* ---- Composition de départ de la Côte d'Ivoire (overlay civLineup) ----
   Source : API publique ESPN summary (le scoreboard ci-dessus ne porte pas les compos).
   Renvoie l'objet attendu par renderLineup() dans index.html, ou null si le onze
   officiel n'est pas encore publié (~1h avant le coup d'envoi). */
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";

function roleIndex(pos) {
  const p = (pos || "").toUpperCase();
  if (p === "G" || p.startsWith("GK")) return 0;        // Gardien
  if (p.includes("M")) return 2;                         // Milieux (DM/CM/AM/LM/RM)
  if (p.includes("B") || p.includes("D")) return 1;     // Défenseurs (RB/LB/CB/CD/WB)
  return 3;                                              // Attaquants (F/ST/CF/W)
}

async function civLineupESPN() {
  const now = new Date();
  const yest = new Date(now.getTime() - 24 * 3600e3);
  let eventId = null, oppName = null, kickoff = null;
  for (const d of [yyyymmdd(now), yyyymmdd(yest)]) {
    let sb;
    try { sb = await getJSON(`${ESPN}/scoreboard?dates=${d}`); }
    catch (e) { log("ESPN scoreboard échec", d, e.message); continue; }
    for (const ev of (sb?.events || [])) {
      const comp = ev?.competitions?.[0];
      const cs = comp?.competitors || [];
      const civ = cs.find(c => (c.team?.displayName || c.team?.name) === "Ivory Coast");
      if (civ) {
        eventId = String(ev.id);
        kickoff = ev.date || null;
        const other = cs.find(c => c !== civ);
        oppName = other?.team?.displayName || other?.team?.name || null;
        break;
      }
    }
    if (eventId) break;
  }
  if (!eventId) { log("Aucun match CIV trouvé sur ESPN (today/yesterday)"); return null; }

  // Fenêtre : ne publier la compo qu'à partir de ~90 min avant le coup d'envoi
  // (ESPN peut exposer un XI « probable » bien plus tôt — on évite de le figer).
  const kickMs = kickoff ? Date.parse(kickoff) : 0;
  if (kickMs && Date.now() < kickMs - 90 * 60000) { log("Compo trop tôt avant le coup d'envoi — ignorée"); return null; }

  let sum;
  try { sum = await getJSON(`${ESPN}/summary?event=${eventId}`); }
  catch (e) { log("ESPN summary échec", eventId, e.message); return null; }

  const civR = (sum?.rosters || []).find(t => (t.team?.displayName || t.team?.name) === "Ivory Coast");
  const starters = (civR?.roster || [])
    .filter(p => p.starter === true)
    .sort((a, b) => Number(a.formationPlace || 0) - Number(b.formationPlace || 0));
  if (!civR || starters.length < 11) { log("Onze officiel CIV pas encore publié"); return null; }

  const buckets = [[], [], [], []];
  for (const p of starters) {
    const name = p.athlete?.displayName || "?";
    buckets[roleIndex(p.position?.abbreviation)].push(name);
  }
  const roles = ["Gardien", "Défenseurs", "Milieux", "Attaquants"];
  const lines = buckets.map((players, i) => ({ role: roles[i], players })).filter(l => l.players.length);
  const oppFr = toFr(oppName) || oppName || "";

  return {
    match: "Côte d'Ivoire" + (oppFr ? " – " + oppFr : "") + " · groupe E (Mondial 2026)",
    formation: civR.formation || "",
    coach: "Emerse Faé",
    probable: false,
    lines,
    note: "🟢 Onze officiel — mis à jour automatiquement (source ESPN)."
  };
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

  // Onze officiel de la Côte d'Ivoire (overlay compo, dès publication ~1h avant le match)
  try {
    const lineup = await civLineupESPN();
    if (lineup) { data.civLineup = lineup; log("civLineup ajouté", lineup.formation); }
  } catch (e) { log("civLineup échec", e.message); }

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
