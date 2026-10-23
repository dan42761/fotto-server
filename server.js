const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// Configurazione CORS per Android WebView
app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Range', 'Authorization'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges']
}));

function getBaseUrl(req) {
    if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto.includes('https') ? 'https' : proto}://${host}`;
}

// Lista di istanze pubbliche di Invidious
const INVIDIOUS_INSTANCES = [
    "https://inv.tux.pizza",
    "https://invidious.nerdvpn.de",
    "https://invidious.privacyredirect.com",
    "https://iv.melmac.space",
    "https://invidious.lunar.icu",
    "https://vid.puffyan.us"
];

async function fetchFromInvidious(endpoint) {
    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            const url = `${instance}${endpoint}`;
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                return await res.json();
            }
        } catch (e) {
            continue; // Passa all'istanza successiva se questa fallisce
        }
    }
    throw new Error("Tutte le istanze Invidious sono irraggiungibili o hanno bloccato la richiesta.");
}

// 1. Healthcheck
app.get('/ping', (req, res) => {
    res.json({ status: 'alive', uptime: process.uptime() });
});

// 2. Ricerca tramite Invidious API
app.get(['/', '/search'], async (req, res) => {
    const query = (req.query.q || req.query.query || '').trim();
    if (!query) return res.json({ status: 'online', mode: 'Invidious API' });

    try {
        const data = await fetchFromInvidious(`/api/v1/search?q=${encodeURIComponent(query)}&type=video`);
        const results = data.map(item => ({
            videoId: item.videoId,
            id: item.videoId,
            title: item.title,
            author: item.author || 'Artista Sconosciuto',
            artist: item.author || 'Artista Sconosciuto',
            duration: item.lengthSeconds || 180,
            thumbnail: item.videoThumbnails?.find(t => t.quality === 'medium')?.url || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`
        }));
        res.json({ results, items: results });
    } catch (err) {
        res.status(502).json({ error: err.message, results: [] });
    }
});

// 3. Estrazione Audio tramite Invidious
app.get('/audio', async (req, res) => {
    const videoId = req.query.videoId || req.query.id;
    if (!videoId) return res.status(400).json({ error: 'videoId mancante' });

    try {
        const data = await fetchFromInvidious(`/api/v1/videos/${videoId}`);
        
        if (!data.adaptiveFormats) {
            return res.status(404).json({ error: 'Nessun formato audio trovato.' });
        }

        // Filtra solo gli stream audio (preferendo m4a/mp4 per Android background)
        const audioFormats = data.adaptiveFormats.filter(f => f.type && f.type.startsWith('audio/'));
        audioFormats.sort((a, b) => {
            const aMp4 = a.type.includes('mp4') ? 1 : -1;
            const bMp4 = b.type.includes('mp4') ? 1 : -1;
            return bMp4 - aMp4;
        });

        if (audioFormats.length === 0) {
            return res.status(404).json({ error: 'Nessun flusso audio compatibile trovato.' });
        }

        const rawAudioUrl = audioFormats[0].url;
        const baseUrl = getBaseUrl(req);
        
        // FONDAMENTALE: Passiamo l'URL grezzo al nostro proxy interno.
        // YouTube blocca gli IP diversi da quelli che hanno generato il link.
        // Proxando il flusso dal server, YouTube vede l'IP del server, non quello del telefono.
        const proxiedStreamUrl = `${baseUrl}/proxy-stream?url=${encodeURIComponent(rawAudioUrl)}`;

        res.json({
            videoId: videoId,
            url: proxiedStreamUrl,
            audioUrl: proxiedStreamUrl,
            streamUrl: proxiedStreamUrl,
            mimeType: audioFormats[0].type.split(';')[0],
            title: data.title,
            artist: data.author,
            provider: 'invidious_proxy'
        });

    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// 4. Proxy Stream (Supporto Range per background Android)
app.get('/proxy-stream', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("URL mancante");

    try {
        const fetchOptions = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://www.youtube.com/'
            }
        };

        // Inoltra l'header Range inviato dal player Android (ExoPlayer / HTML5 Audio)
        if (req.headers.range) {
            fetchOptions.headers['Range'] = req.headers.range;
        }

        const upstreamRes = await fetch(targetUrl, fetchOptions);

        // Copia gli header necessari per il byte-serving
        res.status(upstreamRes.status);
        const headersToKeep = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
        
        headersToKeep.forEach(h => {
            const val = upstreamRes.headers.get(h);
            if (val) res.setHeader(h, val);
        });
        
        if (!res.getHeader('accept-ranges')) {
            res.setHeader('accept-ranges', 'bytes');
        }

        // Pipe dello stream audio
        if (upstreamRes.body) {
            const reader = upstreamRes.body.getReader();
            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(Buffer.from(value));
                }
                res.end();
            };
            await pump();
        } else {
            res.end();
        }
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'Errore proxy stream' });
    }
});

const PORT_NUM = Number(PORT);
app.listen(PORT_NUM, '0.0.0.0', () => {
    console.log(`Server Fotto-Music (Invidious Edition) avviato sulla porta ${PORT_NUM}`);
});

// Auto-ping
setInterval(async () => {
    try {
        const base = PUBLIC_BASE_URL || `http://127.0.0.1:${PORT_NUM}`;
        await fetch(`${base}/ping`);
    } catch (e) {}
}, 4 * 60 * 1000);
