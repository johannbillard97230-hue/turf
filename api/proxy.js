/* TURFMETRICS PRO — micro-fonction proxy (Vercel Serverless)
   Identique à la version Netlify : relais GET uniquement,
   domaines hippiques autorisés, aucune conservation. */

const DOMAINES_AUTORISES = [
  "www.pronostics-turf.info",
  "pronostics-turf.info",
  "www.canalturf.com",
  "canalturf.com",
  "www.turf-fr.com",
  "turf-fr.com"
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// pronostics-turf.info est passé derrière une protection anti-bot
// YOORhosting : page « Vérification de sécurité » (challenge JS) servie
// à la place des données. Le challenge est soluble côté serveur : un
// POST signé (en-tête X-YOOR-L7) vers /__yg_l7_js_pass_https pose un
// cookie de passage (yg_l7_pass, ~30 jours), ensuite la page demandée
// est servie normalement. Le cookie est gardé en mémoire (instance
// serverless) — aucune conservation hors processus.
let cookieYoor = null;
let cookieYoorExpire = 0;

function estChallengeYoor(txt) {
  return txt.includes("Vérification de sécurité") && txt.includes("__yg_l7_js_pass_");
}

async function resoudreChallengeYoor(url) {
  if (cookieYoor && cookieYoorExpire > Date.now()) return cookieYoor;
  const proto = url.protocol === "https:" ? "https" : "http";
  const r = await fetch(`${url.origin}/__yg_l7_js_pass_${proto}?r=${Date.now()}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "X-YOOR-L7": "1",
      "Origin": url.origin,
      "Referer": url.toString(),
      "Content-Length": "0"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (r.status !== 204) throw new Error("challenge YOORhosting refusé (HTTP " + r.status + ")");
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
  for (const sc of setCookies) {
    const m = sc.match(/yg_l7_pass=([^;]+)/);
    if (m) {
      cookieYoor = "yg_l7_pass=" + m[1];
      const mExp = sc.match(/expires=([^;]+)/i);
      cookieYoorExpire = mExp ? new Date(mExp[1]).getTime() : Date.now() + 25 * 86400000;
    }
  }
  if (!cookieYoor) throw new Error("cookie de passage YOORhosting absent de la réponse");
  return cookieYoor;
}

async function fetchSource(url) {
  const entetes = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/json,*/*",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Referer": url.origin + "/"
  };
  if (url.hostname.includes("pronostics-turf.info")) {
    try {
      entetes["Cookie"] = await resoudreChallengeYoor(url);
    } catch { /* challenge non résolu : on tente quand même */ }
  }
  let reponse = await fetch(url.toString(), {
    headers: entetes, redirect: "follow", signal: AbortSignal.timeout(20000)
  });
  let brut = Buffer.from(await reponse.arrayBuffer());

  // Si la réponse est encore la page de vérification (cookie expiré ou
  // refusé), on résout le challenge puis on rejoue la requête.
  if (reponse.ok && brut.length < 8000 && estChallengeYoor(brut.toString("latin1"))) {
    cookieYoor = null; cookieYoorExpire = 0;
    entetes["Cookie"] = await resoudreChallengeYoor(url);
    reponse = await fetch(url.toString(), {
      headers: entetes, redirect: "follow", signal: AbortSignal.timeout(20000)
    });
    brut = Buffer.from(await reponse.arrayBuffer());
  }
  return { reponse, brut };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  const cible = req.query.url;
  if (!cible) return res.status(400).send("Paramètre 'url' manquant");

  let url;
  try { url = new URL(cible); } catch {
    return res.status(400).send("URL invalide");
  }
  if (url.protocol !== "https:" || !DOMAINES_AUTORISES.includes(url.hostname)) {
    return res.status(403).send("Domaine non autorisé");
  }

  try {
    const { reponse, brut } = await fetchSource(url);
    // Relais des octets bruts : le navigateur gère lui-même
    // le décodage du charset d'origine (utf-8, windows-1252…).
    res.setHeader("Content-Type", reponse.headers.get("content-type") || "text/html");
    res.setHeader("Cache-Control", "no-store");
    return res.status(reponse.status).send(brut);
  } catch (e) {
    return res.status(502).send("Erreur de relais : " + e.message);
  }
};
