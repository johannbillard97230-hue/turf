/* TURFMETRICS PRO — micro-fonction proxy (Netlify Functions)
   Relaie UNE requête GET vers les sources hippiques autorisées
   pour contourner le blocage CORS du navigateur.
   Aucune base de données, aucune conservation : simple relais. */

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

function estChallengeYoor(buf) {
  return buf.includes("Vérification de sécurité") && buf.includes("__yg_l7_js_pass_");
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

exports.handler = async (event) => {
  const entetes = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: entetes, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: entetes, body: "Method Not Allowed" };
  }

  const cible = event.queryStringParameters && event.queryStringParameters.url;
  if (!cible) {
    return { statusCode: 400, headers: entetes, body: "Paramètre 'url' manquant" };
  }

  let url;
  try { url = new URL(cible); } catch {
    return { statusCode: 400, headers: entetes, body: "URL invalide" };
  }
  if (url.protocol !== "https:" || !DOMAINES_AUTORISES.includes(url.hostname)) {
    return { statusCode: 403, headers: entetes, body: "Domaine non autorisé" };
  }

  try {
    const { reponse, brut } = await fetchSource(url);
    // Relais des octets bruts (base64) : le navigateur gère lui-même
    // le décodage du charset d'origine (utf-8, windows-1252…).
    return {
      statusCode: reponse.status,
      headers: {
        ...entetes,
        "Content-Type": reponse.headers.get("content-type") || "text/html",
        "Cache-Control": "no-store"
      },
      body: brut.toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return { statusCode: 502, headers: entetes, body: "Erreur de relais : " + e.message };
  }
};
