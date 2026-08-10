const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Endpoint di ricerca che interroga l'API pubblica di YTS usando yts.lu
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) return res.status(400).json({ success: false, error: "Manca la query" });

    try {
        // Usiamo yts.lu (o yts.mx a seconda della disponibilità del dominio)
        const apiUrl = `https://yts.lu/api/v2/list_movies.json?query_term=${encodeURIComponent(searchQuery)}&limit=10`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        const risultati = [];

        if (data.status === 'ok' && data.data.movie_count > 0) {
            data.data.movies.forEach(movie => {
                if (movie.torrents) {
                    movie.torrents.forEach(t => {
                        const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.demonii.com:1337/announce`;
                        
                        risultati.push({
                            titolo: `${movie.title} (${movie.year}) - [${t.quality}]`,
                            detailsUrl: magnet,
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

app.get('/getMagnet', async (req, res) => {
    const magnet = req.query.url;
    if (!magnet) return res.status(400).json({ success: false, error: "Manca l'URL" });
    res.json({ success: true, magnet });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server YTS proxy attivo sulla porta ${PORT}`));
