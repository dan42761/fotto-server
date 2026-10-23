const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurazione CORS aperta per consentire qualsiasi richiesta dal tuo sito Firebase o file locale
app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type']
}));

// Cartella temporanea dove il server scarica le canzoni per servirle direttamente al tag <audio>
const CACHE_DIR = path.join('/tmp', 'fotto_audio_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Pulizia automatica ogni 15 minuti: elimina i file audio più vecchi di 45 minuti per non riempire la memoria di Render
const MAX_FILE_AGE_MS = 45 * 60 * 1000;
setInterval(() => {
    try {
        const files = fs.readdirSync(CACHE_DIR);
        const now = Date.now();
        for (const f of files) {
            const fullPath = path.join(CACHE_DIR, f);
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
                fs.unlinkSync(fullPath);
            }
        }
    } catch (e) {}
}, 15 * 60 * 1000);

// Lista dei nodi API usati da monochrome.st (dalla repository ufficiale monochrome-music/monochrome)
const MONOCHROME_API_NODES = [
    "https://monochrome.st",
    "https://monochrome.tf",
    "https://triton.squid.wtf",
    "https://tidal.kinoplus.online",
    "https://hifi.401658.xyz",
    "https://wolf.qqdl.site",
    "https://maus.qqdl.site",
    "https://vogel.qqdl.site",
    "https://katze.qqdl.site",
    "https://hund.qqdl.site"
];

// CDN Secondari di emergenza (320kbps MP4/AAC) nel caso un brano non sia sui nodi Monochrome
const FALLBACK_CDN_NODES = [
    "https://saavn.dev/api/search/songs",
    "https://jiosaavn-api-privatecvc2.vercel.app/search/songs",
    "https://saavn.sumit.co/api/search/songs"
];

function normalizeText(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            ...(options.headers || {})
        };
        const res = await fetch(url, { ...options, headers, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// Decodifica il manifest di Monochrome (che può essere un JSON Direct URL, un JSON base64 con 'urls', o un oggetto OriginalTrackUrl)
function extractStreamUrlFromMonochromePayload(trackData) {
    if (!trackData) return null;
    const items = Array.isArray(trackData) ? trackData : [trackData];

    for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        // Caso 1: OriginalTrackUrl o streamUrl diretto
        const direct = item.OriginalTrackUrl || item.streamUrl || item.url || item?.data?.OriginalTrackUrl || item?.data?.streamUrl;
        if (direct && typeof direct === 'string' && direct.startsWith('http') && !direct.includes('/browse/')) {
            return { url: direct, mimeType: item.mimeType || 'audio/mp4' };
        }

        // Caso 2: Manifest codificato in Base64 (standard hifi-api / monochrome)
        const manifestB64 = item.manifest || item?.data?.manifest;
        const manifestMime = item.manifestMimeType || item?.data?.manifestMimeType || '';
        if (manifestB64 && typeof manifestB64 === 'string') {
            try {
                const decodedStr = Buffer.from(manifestB64, 'base64').toString('utf-8');
                // Se il manifest è JSON (application/vnd.tidal.bts) contiene l'array urls: ["https://..."]
                if (decodedStr.trim().startsWith('{')) {
                    const manifestJson = JSON.parse(decodedStr);
                    if (Array.isArray(manifestJson.urls) && manifestJson.urls.length > 0) {
                        return {
                            url: manifestJson.urls[0],
                            mimeType: manifestJson.mimeType || 'audio/mp4'
                        };
                    }
                }
                // Se il manifest è XML MPD ma contiene un BaseURL diretto
                const baseUrlMatch = decodedStr.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
                if (baseUrlMatch && baseUrlMatch[1] && baseUrlMatch[1].startsWith('http')) {
                    return { url: baseUrlMatch[1].replace(/&amp;/g, '&'), mimeType: 'audio/mp4' };
                }
            } catch (e) {}
        }
    }
    return null;
}

// 1. Cerca la canzone sui nodi di monochrome.st e restituisce l'URL sorgente del file audio
async function findAudioSourceFromMonochrome(title, artist) {
    const cleanTitle = (title || '').replace(/\(.*?\)|\[.*?\]/g, '').split(' - ')[0].trim() || title;
    const cleanArtist = (artist || '').split(',')[0].split('&')[0].split(/\s+feat/i)[0].trim() || artist;
    const query = `${cleanTitle} ${cleanArtist}`.trim();
    const normTitle = normalizeText(cleanTitle);
    const normArtist = normalizeText(cleanArtist);

    // A) Prova i nodi Monochrome (usiamo quality=HIGH che corrisponde a 320kbps AAC M4A, riproducibile su TUTTI i tag <audio> inclusi iOS/Safari/Firefox, e fallback su LOSSLESS)
    for (const node of MONOCHROME_API_NODES) {
        try {
            const searchUrls = [
                `${node}/search/?s=${encodeURIComponent(query)}`,
                `${node}/api/search/?s=${encodeURIComponent(query)}`
            ];

            let tracks = [];
            for (const sUrl of searchUrls) {
                try {
                    const sRes = await fetchWithTimeout(sUrl, {}, 4000);
                    if (!sRes.ok) continue;
                    const sData = await sRes.json();
                    const candidateList = sData?.items || sData?.tracks?.items || sData?.data?.items || (Array.isArray(sData) ? sData : []);
                    if (Array.isArray(candidateList) && candidateList.length > 0) {
                        tracks = candidateList;
                        break;
                    }
                } catch (e) {}
            }

            if (!tracks || tracks.length === 0) continue;

            // Trova la traccia che corrisponde meglio a titolo e artista
            const matchedTrack = tracks.find(t => {
                const tTitle = normalizeText(t.title || t.name || '');
                const tArtist = normalizeText(t.artist?.name || t.artists?.[0]?.name || '');
                const titleOk = tTitle.includes(normTitle) || normTitle.includes(tTitle);
                const artistOk = !normArtist || tArtist.includes(normArtist) || normArtist.includes(tArtist);
                return titleOk && artistOk;
            }) || tracks[0];

            const directCheck = extractStreamUrlFromMonochromePayload(matchedTrack);
            if (directCheck) return directCheck;

            const trackId = matchedTrack?.id || matchedTrack?.trackId;
            if (!trackId) continue;

            // Richiede il flusso audio per l'ID trovato (prima HIGH = M4A 320kbps universale, poi LOSSLESS = FLAC)
            for (const quality of ['HIGH', 'LOSSLESS', 'LOW']) {
                const trackEndpoints = [
                    `${node}/track/?id=${encodeURIComponent(trackId)}&quality=${quality}`,
                    `${node}/api/track/?id=${encodeURIComponent(trackId)}&quality=${quality}`,
                    `${node}/dash/?id=${encodeURIComponent(trackId)}&quality=${quality}`
                ];
                for (const tUrl of trackEndpoints) {
                    try {
                        const tRes = await fetchWithTimeout(tUrl, {}, 4500);
                        if (!tRes.ok) continue;
                        const tData = await tRes.json();
                        const extracted = extractStreamUrlFromMonochromePayload(tData);
                        if (extracted && extracted.url) {
                            return extracted;
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {
            continue;
        }
    }

    // B) Fallback secondario se tutti i nodi Monochrome sono temporaneamente irraggiungibili
    for (const cdnApi of FALLBACK_CDN_NODES) {
        try {
            const res = await fetchWithTimeout(`${cdnApi}?query=${encodeURIComponent(query)}&limit=6`, {}, 4000);
            if (!res.ok) continue;
            const json = await res.json();
            const results = json?.data?.results || json?.results || [];
            for (const item of results) {
                const sName = normalizeText(item.name || item.title || '');
                if ((sName.includes(normTitle) || normTitle.includes(sName)) && Array.isArray(item.downloadUrl) && item.downloadUrl.length > 0) {
                    const best = item.downloadUrl[item.downloadUrl.length - 1];
                    const url = best?.url || best?.link;
                    if (url) return { url, mimeType: 'audio/mp4' };
                }
            }
        } catch (e) {}
    }

    return null;
}

// Scarica il file audio nella cartella /tmp del server Render e restituisce il percorso locale
const activeDownloads = new Map();

async function downloadTrackToTempCache(cacheKey, remoteUrl, defaultMime = 'audio/mp4') {
    if (activeDownloads.has(cacheKey)) {
        return activeDownloads.get(cacheKey);
    }

    const downloadPromise = (async () => {
        const ext = defaultMime.includes('flac') ? '.flac' : '.m4a';
        const filePath = path.join(CACHE_DIR, `${cacheKey}${ext}`);
        const metaPath = path.join(CACHE_DIR, `${cacheKey}.json`);

        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 10000) {
            let mimeType = defaultMime;
            try {
                if (fs.existsSync(metaPath)) {
                    mimeType = JSON.parse(fs.readFileSync(metaPath, 'utf8')).mimeType || defaultMime;
                }
            } catch (e) {}
            return { filePath, mimeType };
        }

        const response = await fetchWithTimeout(remoteUrl, {}, 20000);
        if (!response.ok || !response.body) {
            throw new Error(`Download fallito con stato ${response.status}`);
        }

        const contentType = response.headers.get('content-type') || defaultMime;
        const finalMime = contentType.includes('flac') ? 'audio/flac' : 'audio/mp4';
        const tempWritePath = `${filePath}.part_${Date.now()}`;

        const fileStream = fs.createWriteStream(tempWritePath);
        await pipeline(Readable.fromWeb(response.body), fileStream);

        fs.renameSync(tempWritePath, filePath);
        fs.writeFileSync(metaPath, JSON.stringify({ mimeType: finalMime, createdAt: Date.now() }));

        return { filePath, mimeType: finalMime };
    })();

    activeDownloads.set(cacheKey, downloadPromise);
    try {
        return await downloadPromise;
    } finally {
        activeDownloads.delete(cacheKey);
    }
}

// Endpoint di stato (utile per verificare che il server Render sia online)
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Fotto-Music Monochrome Audio Server',
        endpoints: {
            resolveJson: '/api/stream?title=TITOLO&artist=ARTISTA',
            directAudioFile: '/api/files/:fileKey'
        }
    });
});

// =========================================================================
// ENDPOINT 1: Chiamato dal tuo file HTML (fotto_music_monochrome.html)
// Cerca il brano su Monochrome, lo scarica sul server Render e genera il link diretto per <audio>
// =========================================================================
app.get('/api/stream', async (req, res) => {
    try {
        const title = req.query.title || '';
        const artist = req.query.artist || '';
        const q = req.query.q || `${title} ${artist}`.trim();

        if (!q) {
            return res.status(400).json({ error: 'Parametri title/artist o q mancanti' });
        }

        const cacheKey = crypto.createHash('md5').update(normalizeText(`${title}__${artist}__${q}`)).digest('hex');
        const foundSource = await findAudioSourceFromMonochrome(title || q, artist);

        if (!foundSource || !foundSource.url) {
            return res.status(404).json({ error: 'Brano non trovato sui nodi Monochrome' });
        }

        // Scarica il brano sul server Render e genera un link locale pulito /api/files/:cacheKey
        constprotocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const baseUrl = `${constprotocol}://${req.get('host')}`;

        try {
            await downloadTrackToTempCache(cacheKey, foundSource.url, foundSource.mimeType);
            return res.json({
                streamUrl: `${baseUrl}/api/files/${cacheKey}`,
                directSourceUrl: foundSource.url,
                source: 'monochrome-render-downloaded'
            });
        } catch (downloadErr) {
            // Se il download su disco impiega troppo tempo, usa lo streaming proxy istantaneo
            return res.json({
                streamUrl: `${baseUrl}/api/proxy?url=${encodeURIComponent(foundSource.url)}`,
                directSourceUrl: foundSource.url,
                source: 'monochrome-render-proxy'
            });
        }
    } catch (err) {
        console.error('Errore /api/stream:', err);
        res.status(500).json({ error: err.message || 'Errore interno del server' });
    }
});

// =========================================================================
// ENDPOINT 2: Serve il file audio scaricato a <audio> con supporto HTTP 206 Range
// (Fondamentale per mandare avanti/indietro la barra del brano e non avere MAI blocchi ORB/CORS)
// =========================================================================
app.get('/api/files/:cacheKey', (req, res) => {
    const cacheKey = String(req.params.cacheKey || '').replace(/[^a-z0-9]/gi, '');
    const m4aPath = path.join(CACHE_DIR, `${cacheKey}.m4a`);
    const flacPath = path.join(CACHE_DIR, `${cacheKey}.flac`);
    const metaPath = path.join(CACHE_DIR, `${cacheKey}.json`);

    const filePath = fs.existsSync(m4aPath) ? m4aPath : (fs.existsSync(flacPath) ? flacPath : null);
    if (!filePath) {
        return res.status(404).send('File audio scaduto o non trovato');
    }

    let mimeType = filePath.endsWith('.flac') ? 'audio/flac' : 'audio/mp4';
    try {
        if (fs.existsSync(metaPath)) {
            mimeType = JSON.parse(fs.readFileSync(metaPath, 'utf8')).mimeType || mimeType;
        }
    } catch (e) {}

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunksize
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

// =========================================================================
// ENDPOINT 3: Fallback Proxy Streaming diretto con supporto Range
// =========================================================================
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL mancante');
    try {
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        if (req.headers.range) headers['Range'] = req.headers.range;

        const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });
        res.status(upstream.status);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mp4');
        if (upstream.headers.get('content-length')) {
            res.setHeader('Content-Length', upstream.headers.get('content-length'));
        }
        if (upstream.headers.get('content-range')) {
            res.setHeader('Content-Range', upstream.headers.get('content-range'));
        }
        Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
        res.status(500).send('Errore proxy audio');
    }
});

app.listen(PORT, () => {
    console.log(`Fotto Monochrome Audio Server avviato sulla porta ${PORT}`);
});
