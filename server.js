process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚙️ الإعدادات الأساسية
const FIREBASE_URL = "https://gamerdz1517-db-default-rtdb.europe-west1.firebasedatabase.app";
const CLOUDFLARE_WORKER_URL = "https://xt2.gamerdz1517.com"; // رابط الووركر الخاص بك للبث

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// دوال مساعدة للاتصال بسيرفرات Stalker
function getSpoofedIP(mac) {
    if (!mac) return '197.22.14.11';
    let hash = 0; const str = String(mac).toLowerCase();
    for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
    hash = Math.abs(hash);
    return `197.${(hash % 200) + 10}.${((hash >> 8) % 200) + 10}.${((hash >> 16) % 200) + 10}`;
}

async function callStalkerDirect(serverUrl, macAddress, stalkerType, stalkerAction, token = null) {
    const spoofedIP = getSpoofedIP(macAddress);
    const headers = {
        "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
        "Referer": `${serverUrl}/c/`,
        "Cookie": `mac=${macAddress}; stb_lang=en; timezone=Africa/Algiers;`,
        "X-Forwarded-For": spoofedIP, "X-Real-IP": spoofedIP, "Client-IP": spoofedIP
    };
    let targetUrl;
    if (stalkerAction === "handshake") {
        targetUrl = `${serverUrl}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`;
    } else {
        targetUrl = `${serverUrl}/server/load.php?type=${stalkerType}&action=${stalkerAction}&JsHttpRequest=1-xml`;
        if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    try {
        const res = await fetch(targetUrl, { headers, timeout: 20000 });
        return await res.json();
    } catch { return null; }
}

async function fetchContentStrict(server, mac, type, allowedIds, categoryId, token, extraParam = "") {
    const genreParam = type === "itv" ? "genre" : "category";
    let catsToFetch = allowedIds.includes('ALL') ? [""] : allowedIds;
    const uniqueMap = new Map();

    for (const catId of catsToFetch) {
        const catQuery = catId ? `&${genreParam}=${catId}` : "";
        let page = 1, keepGoing = true;
        while (keepGoing && page <= 60) {
            const promises = Array.from({length: 3}, (_, i) =>
                callStalkerDirect(server, mac, type, `get_ordered_list${catQuery}&limit=1500&p=${page+i}`, token)
            );
            const results = await Promise.all(promises);
            let found = false;
            for (const res of results) {
                let pageData = res?.js?.data || res?.js;
                if (!pageData) continue;
                if (!Array.isArray(pageData)) pageData = Object.values(pageData);
                for (const item of pageData) {
                    const id = item.id || item.cmd || Math.random();
                    if (!uniqueMap.has(id)) uniqueMap.set(id, item);
                    found = true;
                }
            }
            if (!found) { keepGoing = false; break; }
            page += 3;
        }
    }
    return Array.from(uniqueMap.values());
}

// ==============================================================
// 1️⃣ الفحص وجلب التصنيفات
// ==============================================================
app.get('/api/scan', async (req, res) => {
    let { server, mac } = req.query;
    try {
        server = server.trim().replace(/\/c\/?$/i, '').replace(/\/+$/, '');
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

// ==============================================================
// 2️⃣ جلب القنوات
// ==============================================================
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

// ==============================================================
// 3️⃣ إنشاء الحساب (Firebase)
// ==============================================================
app.post('/create_account', async (req, res) => {
    try {
        const { mac, server, selections } = req.body;
        if (!mac || !server) return res.json({ success: false });

        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let shortPass = '';
        for (let i = 0; i < 8; i++) shortPass += chars.charAt(Math.floor(Math.random() * chars.length));

        await fetch(`${FIREBASE_URL}/accounts/${shortPass}.json`, {
            method: 'PUT', body: JSON.stringify({ mac: mac.trim(), server: server.trim(), selections })
        });
        res.json({ success: true, password: shortPass });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ==============================================================
// 4️⃣ العقل المدبر: استخراج الرابط المباشر للمنصة، وتوجيه تطبيقات الهاتف للوركر
// ==============================================================
app.get('/proxy_stream', async (req, res) => {
    let { server, mac, stream_id, type, resolve_only } = req.query;

    if (server) {
        server = server.trim().replace(/\/c\/?$/i, '').replace(/\/+$/, '');
        if (!server.startsWith('http')) server = 'http://' + server;
    }
    if (!server || !mac || !stream_id) return res.status(400).send("Missing params");

    try {
        const tkRes = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk = tkRes?.js?.token;
        if (!tk) return res.status(403).json({ success: false, error: "MAC Blocked" });

        let streamUrl = "";
        if (type === 'vod' || type === 'movie') {
            streamUrl = `${server}/play/movie.php?mac=${mac}&stream=${stream_id}.mkv&type=movie`;
        } else {
            const cmd = encodeURIComponent(`ffmpeg localhost/ch/${stream_id}`);
            const linkRes = await callStalkerDirect(server, mac, "itv", `create_link&cmd=${cmd}`, tk);
            const pt = linkRes?.js?.play_token || linkRes?.js?.token_random || "";

            if (linkRes?.js?.cmd) {
                const rawCmd = linkRes.js.cmd;
                if (rawCmd.startsWith('http')) streamUrl = rawCmd;
                else streamUrl = rawCmd.startsWith('ffmpeg ') ? rawCmd.split(' ').pop() : rawCmd;
            }
            if (!streamUrl) streamUrl = `${server}/play/live.php?mac=${mac}&stream=${stream_id}&extension=ts`;
            if (pt && !streamUrl.includes('play_token=')) streamUrl += (streamUrl.includes('?') ? '&' : '?') + `play_token=${pt}`;
        }

        // 🚀 إذا كان الطلب من منصة Blogger نعطيها الرابط الـ HTTP كما هو + التوكن
        if (resolve_only === '1') {
            return res.json({ success: true, stream_url: streamUrl, type: type, token: tk });
        }

        // 🚀 إذا كان الطلب من تطبيق XT GAMERDZ1517 PLAYER نوجهه مباشرة إلى الوركر للبث
        const workerUrl = `${CLOUDFLARE_WORKER_URL}/stream?url=${encodeURIComponent(streamUrl)}&mac=${encodeURIComponent(mac)}&token=${encodeURIComponent(tk)}`;
        return res.redirect(302, workerUrl);

    } catch (e) {
        res.status(500).send("Proxy Error");
    }
});

// ==============================================================
// 5️⃣ محاكاة واجهة Xtream لتطبيقات الهاتف
// ==============================================================
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
            res.redirect(302, `/proxy_stream?server=${encodeURIComponent(account.server)}&mac=${encodeURIComponent(account.mac)}&stream_id=${streamId}&type=${typeStr}`);
        } else {
            res.status(401).send("Unauthorized");
        }
    } catch(e) { res.status(500).send("Error"); }
});

app.get('/', (req, res) => res.send('✅ GAMERDZ1517 BACKEND IS RUNNING PERFECTLY!'));
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
