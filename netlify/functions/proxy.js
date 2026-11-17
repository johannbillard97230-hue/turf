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
    const reponse = await fetch(url.toString(), {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/json,*/*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": url.origin + "/"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000)
    });
    // Relais des octets bruts (base64) : le navigateur gère lui-même
    // le décodage du charset d'origine (utf-8, windows-1252…).
    const brut = Buffer.from(await reponse.arrayBuffer());
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
