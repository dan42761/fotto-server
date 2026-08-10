const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// ENDPOINT 1: Ricerca sicura tramite API pubbliche (Niente Cloudflare, niente 403)
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) return res.status(400).json({ success: false, error: "Manca la query" });

    try {
        // Usiamo l'API ufficiale e aperta di YTS che restituisce direttamente JSON
        const apiUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(searchQuery)}&limit=10`;
        
        const response = await axios.get(apiUrl);
        const data = response.data;

        const risultati = [];

        if (data.status === 'ok' && data.data.movie_count > 0) {
            data.data.movies.forEach(movie => {
                if (movie.torrents) {
                    movie.torrents.forEach(t => {
                        risultati.push({
                            titolo: `${movie.title} (${movie.year}) - [${t.quality}]`,
                            // Invece di un URL di dettaglio, passiamo direttamente il magnet link ricavato dall'API!
                            detailsUrl: t.url, 
                            magnet: t.hash, // Salviamo già l'hash o il magnet se disponibile
                            size: t.size,
                            seeds: t.seeds
                        });
                    });
                }
            });
        }

        res.json({ success: true, count: risultati.length, data: risultati });

    } catch (error) {
        console.error("Errore API:", error.message);
        res.status(500).json({ success: false, error: "Errore durante la ricerca" });
    }
});

// ENDPOINT 2: Restituisce direttamente il Magnet Link
app.get('/getMagnet', async (req, res) => {
    const torrentUrl = req.query.url; // Qui riceveremo l'hash o il link diretto dell'API
    if (!torrentUrl) return res.status(400).json({ success: false, error: "Manca l'URL" });

    // Se stiamo usando YTS, possiamo costruire il magnet link all'istante dall'hash senza fare scraping
    // (Nel blocco sopra abbiamo messo t.hash dentro detailsUrl o possiamo ricavarlo)
    try {
        // Supponendo che detailsUrl contenga l'hash del torrent di YTS:
        const hash = req.query.url;
        const magnet = `magnet:?xt=urn:btih:${hash}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.demonii.com:1337/announce`;

        res.json({ success: true, magnet });
    } catch (error) {
        res.status(500).json({ success: false, error: "Errore generazione magnet" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server API attivo sulla porta ${PORT}`));
