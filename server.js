const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://fotto-server.onrender.com').replace(/\/$/, '');

app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Range', 'Authorization'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges']
}));

// Recupera un nodo attivo della rete Audius (streaming tracce complete)
async function getAudiusHost() {
    try {
        const res = await fetch('https://api.audius.co', { signal: AbortSignal.timeout(4000) });
        const json = await res.json();
        if (json?.data?.length > 0) return json.data[0];
    } catch (e) {}
    return 'https://discoveryprovider.audius.co';
}

// Cerca brani completi su Audius + Internet Archive
async function searchFullTracks(query) {
    const host = await getAudiusHost();
    const results = [];

    // 1. Ricerca su Audius (Brani completi)
    try {
        const res = await fetch(
            `${host}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=FottoMusic`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (res.ok) {
            const data = await res.json();
            for (const t of (data.data || [])) {
                if (!t.id || !t.title) continue;
                results.push({
                    // Codifichiamo l'ID Audius nel campo videoId così l'app non richiede modifiche
                    videoId: `audius_${t.id}`,
                    id: `audius_${t.id}`,
                    title: t.title,
                    author: t.user?.name || 'Artista',
                    artist: t.user?.name || 'Artista',
                    duration: t.duration || 180,
                    thumbnail: t.artwork?.['480x480'] || t.artwork?.['150x150'] || 'https://placehold.co/400x400/282828/ffffff?text=FM'
                });
            }
        }
    } catch (e) {
        console.error('Errore ricerca Audius:', e.message);
    }

    // 2. Fallback / Integrazione con Internet Archive (File MP3 completi)
    if (results.length < 5) {
        try {
            const iaUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:(audio)&fl[]=identifier,title,creator&rows=10&page=1&output=json`;
            const iaRes = await fetch(iaUrl, { signal: AbortSignal.timeout(6000) });
            if (iaRes.ok) {
                const iaData = await iaRes.json();
                for (const doc of (iaData?.response?.docs || [])) {
                    results.push({
                        videoId: `ia_${doc.identifier}`,
                        id: `ia_${doc.identifier}`,
                        title: doc.title || query,
                        author: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || 'Archivio Audio'),
                        artist: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || 'Archivio Audio'),
                        duration: 210,
                        thumbnail: `https://archive.org/services/img/${doc.identifier}`
                    });
                }
            }
        } catch (e) {}
    }

    return results;
}

// 1. Healthcheck per evitare lo sleep su Render
app.get('/ping', (req, res) => {
    res.status(200).json({ status: 'alive', uptime: Math.floor(process.uptime()) });
});

// 2. Endpoint Ricerca: /?q=... oppure /search?q=...
app.get(['/', '/search'], async (req, res) => {
    const query = (req.query.q || req.query.query || '').trim();
    if (!query) {
        return res.json({ status: 'online', mode: 'Full-Track Streaming Backend' });
    }

    try {
        const results = await searchFullTracks(query);
        return res.json({ results, items: results });
    } catch (err) {
        return res.status(500).json({ error: err.message, results: [] });
    }
});

// 3. Endpoint Audio: /audio?videoId=...
// Accetta sia ID "audius_...", sia "ia_...", sia un titolo/ID qualsiasi (facendo ricerca automatica del brano completo)
app.get('/audio', async (req, res) => {
    const rawId = (req.query.videoId || req.query.id || '').trim();
    const queryHint = (req.query.q || req.query.title || '').trim();

    if (!rawId && !queryHint) {
        return res.status(400).json({ error: 'Parametro videoId mancante' });
    }

    try {
        const host = await getAudiusHost();
        let targetId = rawId;
        let trackTitle = queryHint || rawId;
        let trackArtist = 'Fotto-Music';

        // Se l'app ha passato un ID non-Audius/non-IA (es. vecchio ID o testo), cerchiamo il brano completo corrispondente
        if (!targetId.startsWith('audius_') && !targetId.startsWith('ia_')) {
            const searchKey = queryHint || rawId;
            const found = await searchFullTracks(searchKey);
            if (found.length > 0) {
                targetId = found[0].videoId;
                trackTitle = found[0].title;
                trackArtist = found[0].artist;
            }
        }

        let directStreamUrl = null;

        // Risoluzione stream completo Audius
        if (targetId.startsWith('audius_')) {
            const audiusTrackId = targetId.replace('audius_', '');
            directStreamUrl = `${host}/v1/tracks/${encodeURIComponent(audiusTrackId)}/stream?app_name=FottoMusic`;
        }
        // Risoluzione stream completo Internet Archive
        else if (targetId.startsWith('ia_')) {
            const identifier = targetId.replace('ia_', '');
            const metaRes = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
            if (metaRes.ok) {
                const meta = await metaRes.json();
                const mp3File = (meta.files || []).find(f => f.name && f.name.toLowerCase().endsWith('.mp3'));
                if (mp3File) {
                    directStreamUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(mp3File.name)}`;
                }
            }
        }

        if (!directStreamUrl) {
            return res.status(404).json({ error: 'Brano completo non trovato nel catalogo aperto.' });
        }

        const proxiedUrl = `${PUBLIC_BASE_URL}/proxy-stream?url=${encodeURIComponent(directStreamUrl)}`;

        return res.json({
            videoId: rawId || targetId,
            url: proxiedUrl,
            audioUrl: proxiedUrl,
            streamUrl: proxiedUrl,
            mimeType: 'audio/mpeg',
            title: trackTitle,
            artist: trackArtist,
            provider: 'full_stream'
        });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
});

// 4. Proxy Stream ottimizzato con supporto HTTP 206 Range e gestione chiusura connessione
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
    console.log(`Server Fotto-Music attivo sulla porta ${PORT}`);
});

// Auto-ping verso l'URL PUBBLICO di Render (non 127.0.0.1!)
setInterval(() => {
    fetch(`${PUBLIC_BASE_URL}/ping`).catch(() => {});
}, 4 * 60 * 1000);
