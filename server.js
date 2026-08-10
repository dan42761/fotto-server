const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// URL base del sito (puoi modificarlo qui se usi un mirror differente)
const BASE_URL = 'https://1337x.to';

const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://1337x.to/',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
};

// ENDPOINT 1: Ricerca su 1337x
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) return res.status(400).json({ success: false, error: "Manca la query" });

    try {
        // Aggiungiamo "ITA" se non è già presente per filtrare i contenuti in italiano
        const queryConIta = searchQuery.toLowerCase().includes('ita') ? searchQuery : `${searchQuery} ITA`;
        
        // Sostituiamo gli spazi con il '+' per evitare errori di formattazione dell'URL (404)
        const queryFormattata = queryConIta.trim().replace(/\s+/g, '+');
        
        const trackerUrl = `${BASE_URL}/search/${queryFormattata}/1/`;
        
        const response = await axios.get(trackerUrl, { headers: browserHeaders });

        const $ = cheerio.load(response.data);
        const risultati = [];

        $('table.table-list tbody tr').each((index, element) => {
            const nameCell = $(element).find('td.name');
            const linkDettaglio = nameCell.find('a').last();
            let titolo = linkDettaglio.text().trim();
            let detailsUrl = linkDettaglio.attr('href');

            if (titolo && detailsUrl) {
                if (!detailsUrl.startsWith('http')) {
                    detailsUrl = `${BASE_URL}${detailsUrl}`;
                }

                const seeds = $(element).find('td.seeds').text().trim() || $(element).find('td.col-2').text().trim() || '0';
                const sizeEl = $(element).find('td.size').length ? $(element).find('td.size') : $(element).find('td').eq(4);
                const size = sizeEl.clone().children().remove().end().text().trim() || 'N/D';

                risultati.push({ titolo, detailsUrl, size, seeds });
            }
        });

        res.json({ success: true, count: risultati.length, data: risultati });

    } catch (error) {
        console.error("Errore Ricerca 1337x:", error.message);
        res.status(500).json({ success: false, error: "Errore proxy ricerca 1337x" });
    }
});

// ENDPOINT 2: Estrazione del Magnet Link
app.get('/getMagnet', async (req, res) => {
    const detailsUrl = req.query.url;
    if (!detailsUrl) return res.status(400).json({ success: false, error: "Manca l'URL" });

    try {
        const response = await axios.get(detailsUrl, { headers: browserHeaders });
        const $ = cheerio.load(response.data);
        
        const magnet = $('a[href^="magnet:"]').attr('href');

        if (magnet) {
            res.json({ success: true, magnet });
        } else {
            res.json({ success: false, error: "Link magnetico non trovato nella pagina" });
        }
    } catch (error) {
        console.error("Errore Magnet 1337x:", error.message);
        res.status(500).json({ success: false, error: "Errore recupero magnet" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server proxy 1337x in esecuzione sulla porta ${PORT}`));
