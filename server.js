const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

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

// 1. Healthcheck / Keep-alive
app.get('/ping', (req, res) => {
    res.status(200).json({ status: 'alive', uptime: Math.floor(process.uptime()) });
});

// 2. Ricerca brani sul catalogo aperto
app.get(['/', '/search'], async (req, res) => {
    const query = (req.query.q || req.query.query || '').trim();
    if (!query) {
        return res.json({ status: 'online', message: 'Fotto-Music Audio Streaming Backend attivo' });
    }

    try {
        const results = [];
        
        // Cerca su Audius API (Brani completi gratuiti)
        try {
            const audiusRes = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=FottoMusic`, { signal: AbortSignal.timeout(4000) });
            if (audiusRes.ok) {
                const data = await audiusRes.json();
                for (const t of (data.data || []).slice(0, 15)) {
                    results.push({
                        videoId: `audius_${t.id}`,
                        id: `audius_${t.id}`,
                        title: t.title,
                        author: t.user?.name || 'Artista',
                        artist: t.user?.name || 'Artista',
                        duration: t.duration || 180,
                        thumbnail: t.artwork?.['480x480'] || ''
                    });
                }
            }
        } catch (e) {}

        // Fallback su Deezer Search (Per coprire qualsiasi brano cercato)
        try {
            const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=15`, { signal: AbortSignal.timeout(4000) });
            if (dzRes.ok) {
                const dzData = await dzRes.json();
                for (const item of (dzData.data || [])) {
                    results.push({
                        videoId: `dz_${item.id}`,
                        id: `dz_${item.id}`,
                        title: item.title,
                        author: item.artist?.name || 'Artista',
                        artist: item.artist?.name || 'Artista',
                        duration: item.duration || 180,
                        thumbnail: item.album?.cover_medium || item.artist?.picture_medium || ''
                    });
                }
            }
        } catch (e) {}

        return res.json({ results, items: results });
    } catch (err) {
        return res.status(500).json({ error: err.message, results: [] });
    }
});

// 3. Risoluzione Audio: /audio?videoId=...
app.get('/audio', async (req, res) => {
    const rawId = (req.query.videoId || req.query.id || '').trim();
    const queryHint = (req.query.q || req.query.title || '').trim();

    if (!rawId && !queryHint) {
        return res.status(400).json({ error: 'Parametro videoId mancante' });
    }

    try {
        let directStreamUrl = null;
        let trackTitle = queryHint || rawId;
        let trackArtist = 'Fotto-Music';

        // Se è un ID Audius
        if (rawId.startsWith('audius_')) {
            const audiusId = rawId.replace('audius_', '');
            directStreamUrl = `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(audiusId)}/stream?app_name=FottoMusic`;
        } 
        // Se è un ID Deezer
        else if (rawId.startsWith('dz_') || /^\d+$/.test(rawId)) {
            const dzId = rawId.replace('dz_', '');
            const trackRes = await fetch(`https://api.deezer.com/track/${dzId}`);
            if (trackRes.ok) {
                const trackData = await trackRes.json();
                if (trackData && trackData.preview) {
                    directStreamUrl = trackData.preview;
                    trackTitle = trackData.title || trackTitle;
                    trackArtist = trackData.artist?.name || trackArtist;
                }
            }
        }

        // Se non abbiamo ancora un URL, facciamo una ricerca al volo
        if (!directStreamUrl) {
            const searchTerm = queryHint || rawId;
            const dzSearch = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(searchTerm)}&limit=1`);
            if (dzSearch.ok) {
                const dzData = await dzSearch.json();
                const item = (dzData.data || [])[0];
                if (item && item.preview) {
                    directStreamUrl = item.preview;
                    trackTitle = item.title || searchTerm;
                    trackArtist = item.artist?.name || '';
                }
            }
        }

        // Fallback di sicurezza finale (traccia lofi di test)
        if (!directStreamUrl) {
            directStreamUrl = 'https://cdn.pixabay.com/download/audio/2022/05/15/audio_7ceb78abf7.mp3?filename=lofi-study-112191.mp3';
        }

        const baseUrl = getBaseUrl(req);
        const proxiedUrl = `${baseUrl}/proxy-stream?url=${encodeURIComponent(directStreamUrl)}`;

        return res.json({
            videoId: rawId || 'fallback',
            url: proxiedUrl,
            audioUrl: proxiedUrl,
            streamUrl: proxiedUrl,
            mimeType: 'audio/mpeg',
            title: trackTitle,
            artist: trackArtist,
            provider: 'streaming_proxy'
        });

    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
});

// 4. Proxy Stream con supporto HTTP 206 Range per il background su mobile
app.get('/proxy-stream', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL mancante');

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
        const headers = { 'User-Agent': 'FottoMusic/1.0' };
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const upstream = await fetch(targetUrl, {
            headers,
            redirect: 'follow',
            signal: abortController.signal
        });

        res.status(upstream.status);

        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
            const val = upstream.headers.get(h);
            if (val) res.setHeader(h, val);
        });

        if (!res.getHeader('accept-ranges')) {
            res.setHeader('accept-ranges', 'bytes');
        }
        if (!res.getHeader('content-type')) {
            res.setHeader('content-type', 'audio/mpeg');
        }

        if (upstream.body) {
            Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
        } else {
            res.end();
        }
    } catch (err) {
        if (!res.headersSent) res.status(502).end();
    }
});

app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server Fotto-Music in ascolto sulla porta ${PORT}`);
});

// Keep-alive automatico ogni 4 minuti
setInterval(() => {
    fetch(`${PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`}/ping`).catch(() => {});
}, 4 * 60 * 1000);
