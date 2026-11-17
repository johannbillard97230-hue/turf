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
    // Relais des octets bruts : le navigateur gère lui-même
    // le décodage du charset d'origine (utf-8, windows-1252…).
    const brut = Buffer.from(await reponse.arrayBuffer());
    res.setHeader("Content-Type", reponse.headers.get("content-type") || "text/html");
    res.setHeader("Cache-Control", "no-store");
    return res.status(reponse.status).send(brut);
  } catch (e) {
    return res.status(502).send("Erreur de relais : " + e.message);
  }
};
