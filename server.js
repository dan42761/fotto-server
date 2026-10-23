const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const SELF_PING_URL = process.env.SELF_PING_URL || '';

// Cartella dove mettere eventuali tuoi file MP3/M4A personali
const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Configurazione CORS completa per WebView Android/Capacitor e browser
app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Range', 'Authorization'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges']
}));

// 1. ENDPOINT HEALTH & KEEP-ALIVE (Evita che il server gratuito vada in sleep)
app.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'alive',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// 2. RICERCA BRANI: /?q=... oppure /search?q=...
// Cerca prima nei tuoi file locali in ./media e poi su API musicali aperte (Audius / iTunes)
app.get(['/', '/search'], async (req, res) => {
    const query = (req.query.q || req.query.query || '').trim();
    if (!query) {
        return res.json({
            status: 'online',
            message: 'Fotto-Music Audio Backend attivo',
            endpoints: {
                ping: '/ping',
                search: '/?q=nome+brano',
                audio: '/audio?videoId=ID_O_TITOLO&q=titolo+artista',
                streamLocal: '/stream-local/:filename'
            }
        });
    }

    try {
        const results = await searchCatalog(query, req);
        return res.json({ results, items: results });
    } catch (err) {
        return res.status(500).json({ error: err.message, results: [] });
    }
});

// 3. RISOLUZIONE URL AUDIO PER IL PLAYER IN BACKGROUND: /audio?videoId=...
app.get('/audio', async (req, res) => {
    const id = (req.query.videoId || req.query.id || '').trim();
    const queryHint = (req.query.q || req.query.title || '').trim();

    if (!id && !queryHint) {
        return res.status(400).json({ error: 'Parametro videoId o q mancante' });
    }

    try {
        const resolved = await resolveAudioStream(id, queryHint, req);
        if (!resolved || !resolved.audioUrl) {
            return res.status(404).json({ error: 'Nessuno stream audio trovato per questa traccia' });
        }

        return res.json({
            videoId: id || resolved.id,
            url: resolved.audioUrl,
            audioUrl: resolved.audioUrl,
            streamUrl: resolved.audioUrl,
            mimeType: resolved.mimeType || 'audio/mpeg',
            title: resolved.title || '',
            artist: resolved.artist || '',
            provider: resolved.provider || 'custom'
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 4. STREAMING FILE LOCALI CON SUPPORTO HTTP 206 RANGE (Fondamentale per Android Background / ExoPlayer)
app.get('/stream-local/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(MEDIA_DIR, safeName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File audio locale non trovato' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const ext = path.extname(safeName).toLowerCase();
    const contentType = ext === '.m4a' || ext === '.mp4' ? 'audio/mp4' : 'audio/mpeg';

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

// 5. PROXY STREAM CON SUPPORTO HEADER RANGE (Utile per sorgenti esterne autorizzate)
app.get('/proxy-stream', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url parameter');

    try {
        const headers = { 'User-Agent': 'FottoMusicBackend/1.0' };
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
        res.status(upstream.status);

        const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
        forwardHeaders.forEach(h => {
            const val = upstream.headers.get(h);
            if (val) res.setHeader(h, val);
        });
        if (!res.getHeader('accept-ranges')) {
            res.setHeader('accept-ranges', 'bytes');
        }

        if (upstream.body) {
            const reader = upstream.body.getReader();
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
        if (!res.headersSent) res.status(502).json({ error: err.message });
    }
});

// ============================================================================
// FUNZIONI DI RICERCA E RISOLUZIONE (Libreria Locale + Audius API + Deezer/iTunes)
// ============================================================================

function getBaseUrl(req) {
    if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    return `${proto}://${req.get('host')}`;
}

async function getAudiusHost() {
    const res = await fetch('https://api.audius.co');
    const data = await res.json();
    return (data && data.data && data.data[0]) || 'https://discoveryprovider.audius.co';
}

async function searchCatalog(query, req) {
    const baseUrl = getBaseUrl(req);
    const results = [];

    // A) Cerca prima tra i tuoi file MP3/M4A presenti nella cartella ./media
    const files = fs.readdirSync(MEDIA_DIR).filter(f => /\.(mp3|m4a|ogg|wav)$/i.test(f));
    const qLower = query.toLowerCase();
    for (const file of files) {
        if (file.toLowerCase().includes(qLower)) {
            const cleanName = file.replace(/\.(mp3|m4a|ogg|wav)$/i, '');
            results.push({
                videoId: `local:${file}`,
                id: `local:${file}`,
                title: cleanName,
                author: 'Libreria Locale',
                artist: 'Libreria Locale',
                duration: 180,
                audioUrl: `${baseUrl}/stream-local/${encodeURIComponent(file)}`
            });
        }
    }

    // B) Cerca su Audius API (Streaming completo gratuito con supporto Range)
    try {
        const host = await getAudiusHost();
        const audiusRes = await fetch(`${host}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=FottoMusic`);
        if (audiusRes.ok) {
            const audiusData = await audiusRes.json();
            for (const track of (audiusData.data || []).slice(0, 12)) {
                results.push({
                    videoId: `audius:${track.id}`,
                    id: `audius:${track.id}`,
                    title: track.title,
                    author: track.user?.name || 'Artista',
                    artist: track.user?.name || 'Artista',
                    duration: track.duration || 180,
                    thumbnail: track.artwork?.['480x480'] || ''
                });
            }
        }
    } catch (_) {}

    return results;
}

async function resolveAudioStream(id, queryHint, req) {
    const baseUrl = getBaseUrl(req);

    // Caso 1: File locale nella cartella ./media (es. videoId="local:canzone.mp3" oppure file col nome del videoId)
    if (id.startsWith('local:')) {
        const fileName = id.slice(6);
        return {
            id,
            audioUrl: `${baseUrl}/stream-local/${encodeURIComponent(fileName)}`,
            mimeType: 'audio/mpeg',
            title: fileName,
            provider: 'local_media'
        };
    }

    const directLocalFile = fs.readdirSync(MEDIA_DIR).find(f => f.startsWith(id + '.'));
    if (directLocalFile) {
        return {
            id,
            audioUrl: `${baseUrl}/stream-local/${encodeURIComponent(directLocalFile)}`,
            mimeType: directLocalFile.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg',
            title: directLocalFile,
            provider: 'local_media'
        };
    }

    // Caso 2: ID Audius diretto (es. "audius:D7KyD")
    if (id.startsWith('audius:')) {
        const audiusId = id.slice(7);
        const host = await getAudiusHost();
        const streamEndpoint = `${host}/v1/tracks/${encodeURIComponent(audiusId)}/stream?app_name=FottoMusic`;
        return {
            id,
            audioUrl: `${baseUrl}/proxy-stream?url=${encodeURIComponent(streamEndpoint)}`,
            mimeType: 'audio/mpeg',
            provider: 'audius'
        };
    }

    // Caso 3: Ricerca tramite titolo/hint su Audius o fallback preview Deezer/iTunes
    const searchTerm = queryHint || id;
    try {
        const host = await getAudiusHost();
        const searchRes = await fetch(`${host}/v1/tracks/search?query=${encodeURIComponent(searchTerm)}&app_name=FottoMusic`);
        if (searchRes.ok) {
            const sData = await searchRes.json();
            const first = (sData.data || [])[0];
            if (first && first.id) {
                const streamEndpoint = `${host}/v1/tracks/${encodeURIComponent(first.id)}/stream?app_name=FottoMusic`;
                return {
                    id: first.id,
                    audioUrl: `${baseUrl}/proxy-stream?url=${encodeURIComponent(streamEndpoint)}`,
                    mimeType: 'audio/mpeg',
                    title: first.title,
                    artist: first.user?.name || '',
                    provider: 'audius_search'
                };
            }
        }
    } catch (_) {}

    // Fallback: Preview MP3/M4A da Deezer / iTunes
    try {
        const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(searchTerm)}&limit=1`);
        if (dzRes.ok) {
            const dzData = await dzRes.json();
            const item = (dzData.data || [])[0];
            if (item && item.preview) {
                return {
                    id: String(item.id),
                    audioUrl: item.preview,
                    mimeType: 'audio/mpeg',
                    title: item.title,
                    artist: item.artist?.name || '',
                    provider: 'deezer_preview'
                };
            }
        }
    } catch (_) {}

    return null;
}

// ============================================================================
// RINTOCCO INTERNO ANTI-SLEEP (Self-Ping ogni 4 minuti)
// ============================================================================
setInterval(async () => {
    const target = SELF_PING_URL || (PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/ping` : `http://127.0.0.1:${PORT}/ping`);
    try {
        await fetch(target);
        console.log(`[Keep-Alive] Rintocco inviato con successo a ${target} (${new Date().toLocaleTimeString()})`);
    } catch (err) {
        console.warn(`[Keep-Alive] Errore durante il rintocco su ${target}:`, err.message);
    }
}, 4 * 60 * 1000); // Ogni 4 minuti (240.000 ms)

app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`Fotto-Music Backend attivo sulla porta ${PORT}`);
    console.log(`Healthcheck Keep-Alive: http://0.0.0.0:${PORT}/ping`);
    console.log(`Cartella file audio:    ${MEDIA_DIR}`);
    console.log(`====================================================`);
});
