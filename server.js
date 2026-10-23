const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

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
    res.status(200).json({
        status: 'alive',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// 2. Ricerca brani (Cerca su Deezer per ottenere i titoli e i videoId di YouTube o ID traccia)
app.get(['/', '/search'], async (req, res) => {
    const query = (req.query.q || req.query.query || '').trim();
    if (!query) {
        return res.json({
            status: 'online',
            message: 'Fotto-Music Server con download locale da YouTube attivo',
            endpoints: { search: '/?q=nome+brano', audio: '/audio?videoId=ID' }
        });
    }

    try {
        const results = [];
        const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=15`);
        if (dzRes.ok) {
            const dzData = await dzRes.json();
            for (const item of (dzData.data || [])) {
                results.push({
                    videoId: String(item.id),
                    id: String(item.id),
                    title: item.title,
                    author: item.artist?.name || 'Artista',
                    artist: item.artist?.name || 'Artista',
                    duration: item.duration || 180,
                    thumbnail: item.album?.cover_medium || item.artist?.picture_medium || ''
                });
            }
        }
        return res.json({ results, items: results });
    } catch (err) {
        return res.status(500).json({ error: err.message, results: [] });
    }
});

// 3. ESTRAZIONE E DOWNLOAD LOCALE: /audio?videoId=...
// Scarica l'audio (tramite yt-dlp o ytdl-core), lo salva in ./media e restituisce il link locale con Range
app.get('/audio', async (req, res) => {
    const videoId = req.query.videoId || req.query.id;
    const queryHint = req.query.q || req.query.title || '';

    if (!videoId && !queryHint) {
        return res.status(400).json({ error: 'Parametro videoId o q mancante' });
    }

    const baseUrl = getBaseUrl(req);
    const targetKey = videoId || queryHint;
    const cleanKey = targetKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${cleanKey}.mp3`;
    const filePath = path.join(MEDIA_DIR, fileName);

    // Se il file è già stato scaricato in precedenza sul server, lo serve istantaneamente dalla cache locale
    if (fs.existsSync(filePath)) {
        const localStreamUrl = `${baseUrl}/stream-local/${encodeURIComponent(fileName)}`;
        return res.json({
            videoId: targetKey,
            url: localStreamUrl,
            audioUrl: localStreamUrl,
            streamUrl: localStreamUrl,
            mimeType: 'audio/mpeg',
            title: queryHint || targetKey,
            artist: 'Fotto-Music',
            provider: 'server_cache'
        });
    }

    // Altrimenti, ricerchiamo il brano su YouTube e lo scarichiamo localmente sul server
    try {
        let searchQuery = queryHint;
        if (!searchQuery && /^\d+$/.test(videoId)) {
            // Se è un ID Deezer, recupera titolo e artista per cercare su YouTube
            const dzTr = await fetch(`https://api.deezer.com/track/${videoId}`);
            if (dzTr.ok) {
                const trData = await dzTr.json();
                searchQuery = `${trData.title} ${trData.artist?.name}`;
            }
        }
        if (!searchQuery) searchQuery = videoId;

        // Esegue il download con yt-dlp (o ytdl se installato) estraendo l'audio in mp3
        // yt-dlp è estremamente robusto e aggira i blocchi standard di YouTube
        const ytSearchCommand = `yt-dlp "ytsearch1:${searchQuery}" -x --audio-format mp3 --audio-quality 128k -o "${filePath}"`;
        
        await execPromise(ytSearchCommand, { timeout: 45000 });

        if (fs.existsSync(filePath)) {
            const localStreamUrl = `${baseUrl}/stream-local/${encodeURIComponent(fileName)}`;
            return res.json({
                videoId: targetKey,
                url: localStreamUrl,
                audioUrl: localStreamUrl,
                streamUrl: localStreamUrl,
                mimeType: 'audio/mpeg',
                title: searchQuery,
                artist: 'Fotto-Music',
                provider: 'server_download'
            });
        }
    } catch (err) {
        console.error("Errore durante il download dal server:", err.message);
    }

    // Fallback di emergenza se il download dovesse fallire
    const fallbackUrl = 'https://cdn.pixabay.com/download/audio/2022/05/15/audio_7ceb78abf7.mp3?filename=lofi-study-112191.mp3';
    return res.json({
        videoId: targetKey,
        url: fallbackUrl,
        audioUrl: fallbackUrl,
        streamUrl: fallbackUrl,
        mimeType: 'audio/mpeg',
        title: queryHint || targetKey,
        artist: 'Fotto-Music',
        provider: 'fallback'
    });
});

// 4. STREAMING LOCALE CON SUPPORTO HTTP 206 RANGE (Indispensabile per il background su Android)
app.get('/stream-local/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(MEDIA_DIR, safeName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File locale non trovato' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

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
            'Content-Type': 'audio/mpeg'
        });
        file.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'audio/mpeg'
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

const PORT_NUM = Number(PORT);
app.listen(PORT_NUM, '0.0.0.0', () => {
    console.log(`Server Fotto-Music con download locale avviato sulla porta ${PORT_NUM}`);
});

// Ping keep-alive ogni 4 minuti
setInterval(async () => {
    try {
        const base = PUBLIC_BASE_URL || `http://127.0.0.1:${PORT_NUM}`;
        await fetch(`${base}/ping`);
    } catch (e) {}
}, 4 * 60 * 1000);
