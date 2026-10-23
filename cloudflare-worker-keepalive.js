// ============================================================================
// CLOUDFLARE WORKER CON CRON TRIGGER (Rintocco automatico ogni 5 minuti)
// Incolla questo codice nel tuo Worker (fotto-music.atuttifotto.workers.dev)
// e aggiungi un Cron Trigger (es. */5 * * * *) nella scheda "Triggers" di Cloudflare.
// ============================================================================

const BACKEND_ORIGIN = "https://TUO-SERVER-ESTERNO.onrender.com"; // <-- Sostituisci con l'URL del tuo server gratuito

export default {
  // 1. Gestisce le richieste HTTP provenienti dall'app Fotto-Music
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range, Authorization",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const targetUrl = `${BACKEND_ORIGIN}${url.pathname}${url.search}`;

    const upstreamHeaders = new Headers();
    if (request.headers.has("Range")) {
      upstreamHeaders.set("Range", request.headers.get("Range"));
    }

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: upstreamHeaders,
      });

      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Backend offline o in risveglio", details: err.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },

  // 2. RINTOCCO CRON DI CLOUDFLARE: tiene sveglio il server gratuito 24/7
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch(`${BACKEND_ORIGIN}/ping`)
        .then(res => console.log(`Keep-alive ping status: ${res.status}`))
        .catch(err => console.error(`Keep-alive ping failed: ${err.message}`))
    );
  }
};
