process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run يفضل بورت 8080

// ⚙️ الإعدادات الأساسية
const FIREBASE_URL = "https://gamerdz1517-db-default-rtdb.europe-west1.firebasedatabase.app";
const CLOUDFLARE_WORKER_URL = "https://xt81.djamelchaouadi.workers.dev"; // الوركر الخاص بك

process.on('uncaughtException', (err) => console.error('Caught exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

const localCache = new Map();

app.use((req, res, next) => {
    if (req.path.includes('player_api') || req.path.includes('get_items') || req.path.includes('get.php'))
        res.setHeader('Cache-Control', 'public, max-age=14400');
    next();
});

function getSpoofedIP(mac) {
    if (!mac) return '197.22.14.11';
    let hash = 0;
    const str = String(mac).toLowerCase();
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    hash = Math.abs(hash);
    return `197.${(hash % 200) + 10}.${((hash >> 8) % 200) + 10}.${((hash >> 16) % 200) + 10}`;
}

async function callStalkerDirect(serverUrl, macAddress, stalkerType, stalkerAction, token = null) {
    const spoofedIP = getSpoofedIP(macAddress);
    const headers = {
        "User-Agent":      "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
        "Referer":         `${serverUrl}/c/`,
        "Cookie":          `mac=${macAddress}; stb_lang=en; timezone=Africa/Algiers;`,
        "Accept":          "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With":"XMLHttpRequest",
        "X-Forwarded-For": spoofedIP,
        "X-Real-IP":       spoofedIP,
        "Client-IP":       spoofedIP
    };

    let targetUrl;
    if (stalkerAction === "handshake") {
        targetUrl = `${serverUrl}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`;
        headers["Authorization"] = `MAC ${macAddress}`;
    } else {
        targetUrl = `${serverUrl}/server/load.php?type=${stalkerType}&action=${stalkerAction}&JsHttpRequest=1-xml`;
        if (token && token !== "null") {
            targetUrl += `&token=${token}`;
            headers["Authorization"] = `Bearer ${token}`;
        }
    }

    try {
        const res = await fetch(targetUrl, { headers, timeout: 35000 });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchContentStrict(server, mac, type, allowedIds, categoryId, token, extraParam = "") {
    const genreParam = type === "itv" ? "genre" : "category";
    const targetCat  = (categoryId && !["0","*","null","undefined"].includes(categoryId)) ? categoryId : "";
    const extraQuery = extraParam ? `&${extraParam}` : "";

    let catsToFetch = [];
    if (targetCat) {
        catsToFetch = [targetCat];
    } else if (allowedIds.includes('ALL')) {
        const catRes = await callStalkerDirect(server, mac, type, type === "itv" ? "get_genres" : "get_categories", token);
        const list   = catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [];
        catsToFetch  = list.map(c => String(c.id));
        if (!catsToFetch.length) catsToFetch = [""];
    } else {
        catsToFetch = allowedIds;
    }

    const uniqueMap = new Map();
    const batchSize = 3;

    for (const catId of catsToFetch) {
        const catQuery = catId ? `&${genreParam}=${catId}` : "";
        let page = 1, keepGoing = true;
        while (keepGoing && page <= 60) {
            const promises = Array.from({length: batchSize}, (_, i) =>
                callStalkerDirect(server, mac, type, `get_ordered_list${catQuery}${extraQuery}&limit=1500&p=${page+i}`, token)
            );
            const results = await Promise.all(promises);
            let found = false;
            for (const res of results) {
                let pageData = res?.js?.data || res?.js;
                if (!pageData) continue;
                if (!Array.isArray(pageData)) pageData = typeof pageData === 'object' ? Object.values(pageData) : [];
                for (const item of pageData) {
                    const itemCat = String(item.tv_genre_id || item.category_id || catId || targetCat || "0");
                    if (allowedIds.includes('ALL') || allowedIds.includes(itemCat) || extraParam) {
                        const id = item.id || item.cmd || Math.random();
                        if (!uniqueMap.has(id)) { item.injected_cat_id = itemCat; uniqueMap.set(id, item); }
                    }
                    found = true;
                }
            }
            if (!found) { keepGoing = false; break; }
            page += batchSize;
        }
    }
    return Array.from(uniqueMap.values());
}

app.post('/create_account', async (req, res) => {
    try {
        const { mac, server, selections } = req.body;
        if (!mac || !server) return res.json({success: false, error: "Missing Data"});

        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let shortPass = '';
        for (let i = 0; i < 8; i++) shortPass += chars.charAt(Math.floor(Math.random() * chars.length));

        const dbData = { mac: mac.trim(), server: server.trim(), selections };
        
        let fbRes = await fetch(`${FIREBASE_URL}/accounts/${shortPass}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dbData)
        });

        if(fbRes.ok) {
            localCache.set(shortPass, { srv: dbData.server, mac: dbData.mac, selections: dbData.selections });
            return res.json({success: true, password: shortPass});
        }
        else return res.json({success: false, error: "Database Error"});
    } catch(e) { res.json({success: false, error: e.message}); }
});

app.get('/api/scan', async (req, res) => {
    let server = req.query.server;
    let mac = req.query.mac;
    try {
        let hsRaw = await callStalkerDirect(server, mac, "stb", "handshake", null);
        let tk = hsRaw?.js?.token;
        if(!tk) return res.json({success: false, error: "الماك محظور أو السيرفر لا يستجيب"});

        let liveRes = await callStalkerDirect(server, mac, "itv", "get_genres", tk);
        let vodRes = await callStalkerDirect(server, mac, "vod", "get_categories", tk);
        let seriesRes = await callStalkerDirect(server, mac, "series", "get_categories", tk).catch(()=>({js:[]}));

        let formatCats = (arr) => {
            let list = Array.isArray(arr) ? arr : Object.values(arr||{});
            return list.map(c => ({id: String(c.id), title: String(c.title || c.name)}));
        };

        res.json({ success: true, categories: { live: formatCats(liveRes?.js), vod: formatCats(vodRes?.js), series: formatCats(seriesRes?.js) } });
    } catch(e) { res.json({success: false, error: e.message}); }
});

app.post('/api/get_items', async (req, res) => {
    const { server, mac, type, selectedCats } = req.body;
    try {
        const hs = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk = hs?.js?.token;
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });

        const items = await fetchContentStrict(server, mac, type, selectedCats, null, tk);
        const formatted = items.map(item => ({
            id:   item.id || item.cmd,
            name: item.name || item.cmd,
            logo: item.logo || item.screenshot_uri || ""
        }));
        res.json({ success:true, data:formatted });
    } catch(e) { res.json({ success:false, error:e.message }); }
});

// ================================================================
// 🚀 Proxy Stream - التوجيه السريع والصاروخي بدون تحميل الفيديو
// ================================================================
app.get('/proxy_stream', async (req, res) => {
    let { server, mac, stream_id, type, resolve_only } = req.query;
    if (server) { server = server.trim().replace(/\/c\/?$/i, '').replace(/\/+$/, ''); if (!server.startsWith('http')) server = 'http://' + server; }
    if (!server || !mac || !stream_id) return res.status(400).send("Missing params");
    
    try {
        const tkRes = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk    = tkRes?.js?.token;
        if (!tk) return res.status(403).send("MAC Blocked");
        
        let streamUrl = "";
        if (type === 'vod' || type === 'movie') {
            streamUrl = `${server}/play/movie.php?mac=${mac}&stream=${stream_id}.mkv&type=movie`;
        } else {
            const cmd = encodeURIComponent(`ffmpeg localhost/ch/${stream_id}`);
            const linkRes = await callStalkerDirect(server, mac, "itv", `create_link&cmd=${cmd}`, tk);
            const pt = linkRes?.js?.play_token || linkRes?.js?.token_random || null;
            if (linkRes?.js?.cmd) {
                const rawCmd = linkRes.js.cmd;
                streamUrl = rawCmd.startsWith('ffmpeg ') ? rawCmd.split(' ').pop() : rawCmd;
                if (pt && !streamUrl.includes('play_token=')) streamUrl += (streamUrl.includes('?') ? '&' : '?') + `play_token=${pt}`;
            }
            if (!streamUrl) { streamUrl = `${server}/play/live.php?mac=${mac}&stream=${stream_id}&extension=ts`; if (pt) streamUrl += `&play_token=${pt}`; }
        }
        
        if (!streamUrl) return res.status(404).send("Stream not found");
        
        // 🚀 إذا طلب المشغل الرابط المباشر (للمنصة)
        if (resolve_only === '1') return res.json({ success:true, stream_url:streamUrl, type });

        // 🚀 لتطبيقات XTREAM (الهاتف): توجيه مباشر نحو Cloudflare Worker ليتكفل بالبث
        const workerUrl = `${CLOUDFLARE_WORKER_URL}/stream?url=${encodeURIComponent(streamUrl)}`;
        return res.redirect(302, workerUrl);

    } catch(e) {
        res.status(500).send("Proxy Error: " + e.message); 
    }
});

// ================================================================
// محاكاة واجهات Xtream
// ================================================================
app.get('/player_api.php', async (req, res) => {
    res.json({ user_info: { auth: 1, status: "Active" } });
});

app.get(['/live/:user/:pass/:stream', '/movie/:user/:pass/:stream', '/series/:user/:pass/:stream'], async (req, res) => {
    const reqPass = req.params.pass;
    const streamId = req.params.stream.split('.')[0];
    const typeStr = req.path.includes('/movie/') ? 'vod' : 'itv';

    try {
        const fbRes = await fetch(`${FIREBASE_URL}/accounts/${reqPass}.json`);
        const account = await fbRes.json();
        
        if (account && account.server && account.mac) {
            // توجيه ذكي نحو مسار البروكسي الخاص بنا
            res.redirect(302, `/proxy_stream?server=${encodeURIComponent(account.server)}&mac=${encodeURIComponent(account.mac)}&stream_id=${streamId}&type=${typeStr}`);
        } else {
            res.status(401).send("Unauthorized");
        }
    } catch(e) { res.status(500).send("Error"); }
});

app.get('/', (req, res) => res.status(200).send('✅ GAMERDZ1517 SERVER IS RUNNING PERFECTLY ON CLOUD RUN!'));
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
