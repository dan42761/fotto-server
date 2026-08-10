const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Endpoint di ricerca che interroga direttamente l'API pubblica di YTS
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) return res.status(400).json({ success: false, error: "Manca la query" });

    try {
        // Chiamata all'API JSON di YTS
        const apiUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(searchQuery)}&limit=10`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        const risultati = [];

        if (data.status === 'ok' && data.data.movie_count > 0) {
            data.data.movies.forEach(movie => {
                if (movie.torrents) {
                    movie.torrents.forEach(t => {
                        // Creiamo il magnet link ufficiale usando l'hash del torrent fornito dall'API
                        const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.demonii.com:1337/announce`;
                        
                        risultati.push({
                            titolo: `${movie.title} (${movie.year}) - [${t.quality}]`,
                            detailsUrl: magnet, // Passiamo direttamente il magnet link completo
                            size: t.size,
                            seeds: t.seeds
                        });
                    });
                }
            });
        }

        res.json({ success: true, count: risultati.length, data: risultati });

    } catch (error) {
        console.error("Errore API YTS:", error.message);
        res.status(500).json({ success: false, error: "Errore durante la ricerca su YTS" });
    }
});

// Endpoint fittizio di supporto (restituisce direttamente il magnet che gli passiamo)
app.get('/getMagnet', async (req, res) => {
    const magnet = req.query.url;
    if (!magnet) return res.status(400).json({ success: false, error: "Manca l'URL" });
    res.json({ success: true, magnet });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server YTS proxy attivo sulla porta ${PORT}`));
