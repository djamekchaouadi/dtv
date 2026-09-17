process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const FIREBASE_URL = "https://gamerdz1517-db-default-rtdb.europe-west1.firebasedatabase.app";
const CLOUDFLARE_WORKER_URL = "https://xt81.djamelchaouadi.workers.dev";

process.on('uncaughtException', (err) => console.error('Caught exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

const listsCache = new Map();
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

function streamToResponse(fetchBody, res, req) {
    if (fetchBody.on && typeof fetchBody.on === 'function') {
        fetchBody.on('data', (chunk) => { if (!res.writableEnded) res.write(chunk); });
        fetchBody.on('end',  ()      => { if (!res.writableEnded) res.end(); });
        fetchBody.on('error',()      => { if (!res.writableEnded) res.end(); });
        req.on('close', () => {
            if (!res.writableEnded) res.end();
            if (typeof fetchBody.destroy === 'function') fetchBody.destroy();
        });
    } else if (fetchBody.getReader) {
        const reader = fetchBody.getReader();
        req.on('close', () => { reader.cancel(); if (!res.writableEnded) res.end(); });
        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { if (!res.writableEnded) res.end(); break; }
                    if (!res.writableEnded) res.write(value);
                    else { reader.cancel(); break; }
                }
            } catch { if (!res.writableEnded) res.end(); }
        })();
    } else {
        if (!res.writableEnded) res.end();
    }
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept-Ranges');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
}

async function getAuthDataFromFirebase(password) {
    if (!password) return null;
    if (localCache.has(password)) return localCache.get(password);
    try {
        const r = await fetch(`${FIREBASE_URL}/accounts/${password}.json`);
        if (!r.ok) return null;
        const data = await r.json();
        if (data?.server && data?.mac) {
            const result = { srv: data.server, mac: data.mac, selections: data.selections };
            localCache.set(password, result);
            return result;
        }
        return null;
    } catch { return null; }
}

function encodeSafeBase64(str) {
    try { return Buffer.from(unescape(encodeURIComponent(str))).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
    catch { return Buffer.from(str).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
}

function decodeSafeBase64(str) {
    try {
        let b64 = str.replace(/-/g,'+').replace(/_/g,'/');
        while (b64.length % 4) b64 += '=';
        return decodeURIComponent(escape(Buffer.from(b64,'base64').toString('utf-8')));
    } catch { return str; }
}

function isAdultContent(name) {
    return name ? /porn|xxx|adult|18\+|erotic|sex|adults/i.test(name) : false;
}

function getRealLogo(serverUrl, logoPath, type) {
    if (!logoPath) return "";
    const url = String(logoPath).trim();
    if (url.startsWith('http')) return url;
    const srv = serverUrl.replace(/\/+$/, '');
    if (url.startsWith('/')) return srv + url;
    if (url.includes('/')) return srv + '/' + url;
    return srv + (type === 'vod' || type === 'series'
        ? '/stalker_portal/misc/video_cover/' + url
        : '/stalker_portal/misc/logos/320/' + url);
}

function safeFallback(action) {
    if (action === "") return {
        user_info: { username:"GAMERDZ", password:"", message:"Unauthorized", auth:0, status:"Inactive", exp_date:"0", is_trial:"0", active_cons:"0", max_connections:"1000", created_at:"0", allowed_output_formats:["m3u8","ts","rtmp","mkv","mp4"] },
        server_info: { url:"", port:"80", https_port:"443", server_protocol:"http", timezone:"Africa/Algiers", version:"2.9.0" }
    };
    if (action === "get_series_info") return { seasons:[], episodes:{}, info:{ name:"Not Found", cover:"", plot:"", cast:"", director:"", genre:"", releaseDate:"", rating:"5", rating_5based:5.0, backdrop_path:[] } };
    if (action === "get_short_epg" || action === "get_simple_data_table") return { epg_listings:[] };
    return [];
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
// ================================================================
// Stalker: Handshake
// ================================================================
app.get('/stalker/handshake', async (req, res) => {
    const { portal, mac } = req.query;
    if (!portal || !mac) return res.status(400).json({ success:false, error:"Missing params" });
    try {
        const result = await callStalkerDirect(portal, mac, "stb", "handshake", null);
        const token  = result?.js?.token;
        if (!token) return res.status(401).json({ success:false, error:"Invalid MAC or Portal" });
        return res.json({ success:true, token });
    } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});

// ================================================================
// Stalker: Profile
// ================================================================
app.get('/stalker/profile', async (req, res) => {
    const { portal, mac, token } = req.query;
    if (!portal || !mac || !token) return res.status(400).json({ success:false, error:"Missing params" });
    try {
        const result = await callStalkerDirect(portal, mac, "stb", "get_profile", token);
        if (!result?.js) return res.status(404).json({ success:false, error:"No profile data" });
        return res.json({ success:true, expire_billing_date: result.js.expire_billing_date ?? null, phone: result.js.phone ?? null, fname: result.js.fname ?? null });
    } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});

// ================================================================
// Stalker: Account Info — يجلب Expire الحقيقي
// ================================================================
app.get('/stalker/account', async (req, res) => {
    const { portal, mac, token } = req.query;
    if (!portal || !mac || !token) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        const spoofedIP = getSpoofedIP(mac);
        const headers = {
            "User-Agent":       "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
            "Referer":          `${portal}/c/`,
            "Cookie":           `mac=${mac}; stb_lang=en; timezone=Africa/Algiers;`,
            "Accept":           "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Authorization":    `Bearer ${token}`,
            "X-Forwarded-For":  spoofedIP,
            "X-Real-IP":        spoofedIP,
            "Client-IP":        spoofedIP
        };

        let exp = null;

        // محاولة 1: account_info
        try {
            const accountUrl = `${portal}/portal.php?type=account_info&action=get_main_info&JsHttpRequest=1-xml`;
            const accountRes = await fetch(accountUrl, { headers, timeout: 30000 });
            if (accountRes.ok) {
                const accountJson = await accountRes.json();
                const js = accountJson?.js;
                exp = js?.phone;
                if (!exp || exp === "" || exp === "0000-00-00 00:00:00") exp = js?.exp_date;
                console.log(`[ACCOUNT_INFO] phone=${js?.phone} exp_date=${js?.exp_date}`);
            }
        } catch(e) { console.log('[ACCOUNT_INFO] failed:', e.message); }

        // محاولة 2: get_profile
        if (!exp || exp === "" || exp === "0000-00-00 00:00:00" || exp === "0") {
            try {
                const profileUrl = `${portal}/server/load.php?type=stb&action=get_profile&JsHttpRequest=1-xml&token=${token}`;
                const profileRes = await fetch(profileUrl, { headers, timeout: 30000 });
                if (profileRes.ok) {
                    const js = (await profileRes.json())?.js;
                    exp = js?.expire_billing_date;
                    if (!exp || exp === "0000-00-00 00:00:00") exp = js?.tariff_plan_expired_date;
                    if (!exp || exp === "0000-00-00 00:00:00") exp = js?.end_date;
                    if (!exp || exp === "0000-00-00 00:00:00") exp = js?.exp_date;
                    if (!exp || exp === "0000-00-00 00:00:00") exp = js?.phone;
                    console.log(`[GET_PROFILE] expire=${exp}`);
                }
            } catch(e) { console.log('[GET_PROFILE] failed:', e.message); }
        }

        // محاولة 3: stalker_portal مسار بديل
        if (!exp || exp === "" || exp === "0000-00-00 00:00:00" || exp === "0") {
            try {
                const altUrl = `${portal}/stalker_portal/server/load.php?type=account_info&action=get_main_info&JsHttpRequest=1-xml`;
                const altRes = await fetch(altUrl, { headers, timeout: 30000 });
                if (altRes.ok) {
                    const js = (await altRes.json())?.js;
                    exp = js?.phone || js?.exp_date || js?.expire_billing_date;
                    console.log(`[ALT_ACCOUNT] expire=${exp}`);
                }
            } catch(e) { console.log('[ALT_ACCOUNT] failed:', e.message); }
        }

        const isEmpty = !exp || exp === "" || exp === "0000-00-00 00:00:00" || exp === "0";
        return res.json({ success: true, exp_date: isEmpty ? null : exp, raw: exp });
    } catch(e) {
        console.error('[ACCOUNT] Error:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ================================================================
// 🚀 XTREAM: Verify — التحقق من صحة البيانات وجلب Expire
// ================================================================
app.get('/xtream/verify', async (req, res) => {
    const { host, user, pass } = req.query;
    if (!host || !user || !pass) return res.status(400).json({ valid: false, error: "Missing params" });
    try {
        const url = `${host}/player_api.php?username=${user}&password=${pass}`;
        const response = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 30000
        });
        if (!response.ok) return res.json({ valid: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        if (!data?.user_info) return res.json({ valid: false, error: "Invalid response" });

        const status = data.user_info?.status ?? "";
        const expRaw = data.user_info?.exp_date ?? null;
        const isValid = status.toLowerCase() === "active";

        let expDate = "Unlimited";
        if (expRaw && expRaw !== "0" && expRaw !== "") {
            if (/^\d+$/.test(expRaw)) {
                const dt = new Date(parseInt(expRaw) * 1000);
                expDate = dt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'2-digit' });
            } else {
                expDate = expRaw;
            }
        }

        console.log(`[XTREAM/VERIFY] host=${host} user=${user} status=${status} exp=${expDate}`);
        return res.json({ valid: isValid, status, exp_date: expDate, user_info: data.user_info, server_info: data.server_info });
    } catch(e) {
        console.error('[XTREAM/VERIFY] Error:', e.message);
        return res.json({ valid: true, exp_date: "Unknown", error: e.message });
    }
});

// ================================================================
// 🚀 XTREAM: Get Live Categories
// ================================================================
app.get('/xtream/live/categories', async (req, res) => {
    const { host, user, pass } = req.query;
    if (!host || !user || !pass) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        const url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_live_categories`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Get VOD Categories
// ================================================================
app.get('/xtream/vod/categories', async (req, res) => {
    const { host, user, pass } = req.query;
    if (!host || !user || !pass) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        const url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_vod_categories`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Get Series Categories
// ================================================================
app.get('/xtream/series/categories', async (req, res) => {
    const { host, user, pass } = req.query;
    if (!host || !user || !pass) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        const url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_series_categories`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Get Live Streams
// ================================================================
app.get('/xtream/live/streams', async (req, res) => {
    const { host, user, pass, category_id } = req.query;
    if (!host || !user || !pass) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        let url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_live_streams`;
        if (category_id) url += `&category_id=${category_id}`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 60000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Get VOD Streams
// ================================================================
app.get('/xtream/vod/streams', async (req, res) => {
    const { host, user, pass, category_id } = req.query;
    if (!host || !user || !pass) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        let url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_vod_streams`;
        if (category_id) url += `&category_id=${category_id}`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 60000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Get Series
// ================================================================
app.get('/xtream/series/streams', async (req, res) => {
    const { host, user, pass, category_id } = req.query;
    if (!host || !user || !pass) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        let url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_series`;
        if (category_id) url += `&category_id=${category_id}`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 60000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Get Series Info
// ================================================================
app.get('/xtream/series/info', async (req, res) => {
    const { host, user, pass, series_id } = req.query;
    if (!host || !user || !pass || !series_id) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        const url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_series_info&series_id=${series_id}`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Get VOD Info
// ================================================================
app.get('/xtream/vod/info', async (req, res) => {
    const { host, user, pass, vod_id } = req.query;
    if (!host || !user || !pass || !vod_id) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        const url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_vod_info&vod_id=${vod_id}`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: EPG
// ================================================================
app.get('/xtream/epg', async (req, res) => {
    const { host, user, pass, stream_id, limit } = req.query;
    if (!host || !user || !pass || !stream_id) return res.status(400).json({ success: false, error: "Missing params" });
    try {
        const lim = limit || 4;
        const url = `${host}/player_api.php?username=${user}&password=${pass}&action=get_short_epg&stream_id=${stream_id}&limit=${lim}`;
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 20000 });
        if (!response.ok) return res.json({ success: false, error: `HTTP ${response.status}` });
        const data = await response.json();
        return res.json({ success: true, data });
    } catch(e) { return res.json({ success: false, error: e.message }); }
});

// ================================================================
// 🚀 XTREAM: Proxy Stream (يحل CORS لمشغل الفيديو)
// ================================================================
// ================================================================
// 🚀 XTREAM: Proxy Stream (يحل CORS و 401 لمشغل الفيديو)
// ================================================================
app.get('/xtream/stream', async (req, res) => {
    const { host, user, pass, stream_id, type, ext } = req.query;
    if (!host || !user || !pass || !stream_id) return res.status(400).send("Missing params");

    let streamUrl = "";
    const extension = ext || "ts";

    if (type === "movie") {
        streamUrl = `${host}/movie/${user}/${pass}/${stream_id}.${extension === 'ts' ? 'mp4' : extension}`;
    } else if (type === "series") {
        streamUrl = `${host}/series/${user}/${pass}/${stream_id}.${extension === 'ts' ? 'mp4' : extension}`;
    } else {
        streamUrl = `${host}/live/${user}/${pass}/${stream_id}.${extension}`;
    }

    console.log(`[XTREAM/STREAM] ${streamUrl}`);

    try {
        // 🌟 1. تمويه الهوية كأننا تطبيق أندرويد حقيقي (ExoPlayer) لمنع الحظر
        const headers = {
            "User-Agent": "ExoPlayer/2.18.1 (Linux; Android 11) ExoPlayerLib/2.18.1",
            "Accept": "*/*",
            "Connection": "keep-alive"
        };
        if (req.headers.range) headers["Range"] = req.headers.range;

        const fetchRes = await fetch(streamUrl, { headers, redirect: 'follow', timeout: 15000 });

        if (fetchRes.status === 429) return res.status(429).send("Too Many Connections");

        // 🌟 2. السطر السحري: إذا تم حظرنا بـ 401 أو 403، نحول البث فوراً عبر Cloudflare Worker!
        if ([401, 403, 407, 511].includes(fetchRes.status) || fetchRes.status >= 500) {
            console.log(`[XTREAM] Blocked with ${fetchRes.status}. Routing via Cloudflare Worker...`);
            const workerUrl = `${CLOUDFLARE_WORKER_URL}/stream?url=${encodeURIComponent(streamUrl)}`;
            const workerRes = await fetch(workerUrl, { headers, redirect: 'follow', timeout: 0 });
            res.status(workerRes.status);
            setCorsHeaders(res);
            ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
                if (workerRes.headers.has(h)) res.setHeader(h, workerRes.headers.get(h));
            });
            return streamToResponse(workerRes.body, res, req);
        }

        if (!fetchRes.ok && fetchRes.status !== 206) return res.status(fetchRes.status).send(`Stream Error: ${fetchRes.status}`);

        res.status(fetchRes.status);
        setCorsHeaders(res);
        ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
            if (fetchRes.headers.has(h)) res.setHeader(h, fetchRes.headers.get(h));
        });
        if (!res.getHeader('Content-Type'))
            res.setHeader('Content-Type', (type === 'movie' || type === 'series') ? 'video/mp4' : 'video/mp2t');
        streamToResponse(fetchRes.body, res, req);
    } catch(e) {
        console.error('[XTREAM/STREAM] Error:', e.message);
        try {
            const workerUrl = `${CLOUDFLARE_WORKER_URL}/stream?url=${encodeURIComponent(streamUrl)}`;
            const workerRes = await fetch(workerUrl, { headers: { "User-Agent": "ExoPlayer/2.18.1" }, redirect: 'follow', timeout: 0 });
            res.status(workerRes.status);
            setCorsHeaders(res);
            streamToResponse(workerRes.body, res, req);
        } catch(e2) { res.status(500).send("Stream Error: " + e2.message); }
    }
});
// ================================================================
// Stalker: جلب الفئات
// ================================================================
app.post('/api/get_categories', async (req, res) => {
    const { server, mac, type } = req.body;
    if (!server || !mac || !type) return res.json({ success:false, error:"Missing params" });
    try {
        const hs  = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk  = hs?.js?.token;
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });
        const action = type === "itv" ? "get_genres" : "get_categories";
        const catRaw = await callStalkerDirect(server, mac, type, action, tk);
        const list   = catRaw?.js ? (Array.isArray(catRaw.js) ? catRaw.js : Object.values(catRaw.js)) : [];
        return res.json({ success: true, token: tk, data: list.map(c => ({ id: String(c.id), title: c.title || c.name || "Unknown" })) });
    } catch(e) { return res.json({ success:false, error:e.message }); }
});

app.post('/api/get_category_items', async (req, res) => {
    const { server, mac, type, categoryId, token } = req.body;
    if (!server || !mac || !type) return res.json({ success:false, error:"Missing params" });
    try {
        let tk = token;
        if (!tk) {
            const hs = await callStalkerDirect(server, mac, "stb", "handshake", null);
            tk = hs?.js?.token;
        }
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });
        const items     = await fetchContentStrict(server, mac, type, [categoryId], categoryId, tk);
        const formatted = items.map(item => ({ id: String(item.id || item.cmd), name: item.name || item.cmd || "Unknown", logo: item.logo || item.screenshot_uri || "" }));
        return res.json({ success:true, data:formatted });
    } catch(e) { return res.json({ success:false, error:e.message }); }
});

app.post('/api/get_items', async (req, res) => {
    const { server, mac, type, selectedCats } = req.body;
    try {
        const hs = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk = hs?.js?.token;
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });
        const items     = await fetchContentStrict(server, mac, type, selectedCats, null, tk);
        const formatted = items.map(item => ({ id: item.id || item.cmd, name: item.name || item.cmd, logo: item.logo || item.screenshot_uri || "" }));
        res.json({ success:true, data:formatted });
    } catch(e) { res.json({ success:false, error:e.message }); }
});

// ================================================================
// Proxy Stream (Stalker)
// ================================================================
async function routeViaWorker(req, res, streamUrl, type, mac) {
    try {
        const workerUrl = `${CLOUDFLARE_WORKER_URL}/stream?url=${encodeURIComponent(streamUrl)}`;
        const spoofedIP = getSpoofedIP(mac);
        const headers   = { "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3", "Accept": "*/*", "X-Forwarded-For": spoofedIP, "X-Real-IP": spoofedIP, "Client-IP": spoofedIP };
        if (req.headers.range && (type === 'vod' || type === 'movie')) headers["Range"] = req.headers.range;
        const workerRes = await fetch(workerUrl, { headers, redirect:'follow', timeout:0 });
        if (!workerRes.ok && workerRes.status !== 206) return res.status(workerRes.status).send(`Worker Error: ${workerRes.status}`);
        res.status(workerRes.status);
        setCorsHeaders(res);
        ['content-type','content-length','content-range','accept-ranges'].forEach(h => { if (workerRes.headers.has(h)) res.setHeader(h, workerRes.headers.get(h)); });
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', (type==='vod'||type==='movie') ? 'video/mp4' : 'video/mp2t');
        streamToResponse(workerRes.body, res, req);
    } catch(e) { res.status(500).send("Worker Error: " + e.message); }
}

app.get('/proxy_stream', async (req, res) => {
    let { server, mac, stream_id, type, resolve_only } = req.query;
    if (server) { server = server.trim().replace(/\/c\/?$/i, '').replace(/\/+$/, ''); if (!server.startsWith('http')) server = 'http://' + server; }
    if (!server || !mac || !stream_id) return res.status(400).send("Missing params");
    console.log(`[PROXY] server=${server} stream_id=${stream_id} type=${type}`);
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
        if (resolve_only === '1') return res.json({ success:true, stream_url:streamUrl, type });
        const spoofedIP = getSpoofedIP(mac);
        const reqHeaders = { "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3", "Accept": "*/*", "Connection": "keep-alive", "X-Forwarded-For": spoofedIP, "X-Real-IP": spoofedIP, "Client-IP": spoofedIP };
        if (req.headers.range && (type === 'vod' || type === 'movie')) reqHeaders["Range"] = req.headers.range;
        let fetchRes;
        try { fetchRes = await fetch(streamUrl, { headers:reqHeaders, redirect:'follow', timeout:15000 }); }
        catch(fetchErr) { return routeViaWorker(req, res, streamUrl, type, mac); }
        if (fetchRes.status === 429) return res.status(429).send("Too Many Connections (429).");
        if ([403, 407, 511].includes(fetchRes.status) || fetchRes.status >= 500) return routeViaWorker(req, res, streamUrl, type, mac);
        if (!fetchRes.ok && fetchRes.status !== 206) return res.status(fetchRes.status).send(`Stream Error: ${fetchRes.status}`);
        res.status(fetchRes.status);
        setCorsHeaders(res);
        ['content-type','content-length','content-range','accept-ranges'].forEach(h => { if (fetchRes.headers.has(h)) res.setHeader(h, fetchRes.headers.get(h)); });
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', (type==='vod'||type==='movie') ? 'video/mp4' : 'video/mp2t');
        streamToResponse(fetchRes.body, res, req);
    } catch(e) {
        try { return routeViaWorker(req, res, `${server}/play/live.php?mac=${mac}&stream=${stream_id}&extension=ts`, type, mac); }
        catch { res.status(500).send("Proxy Error: " + e.message); }
    }
});

app.get('/get.php', async (req, res) => { /*... (نفس كود M3U كما هو) ...*/ });
app.all(['/player_api.php', '/panel_api.php', '/xmltv.php'], async (req, res) => { /*... (نفس الكود كما هو) ...*/ });
app.get(['/live/:user/:pass/:stream', '/movie/:user/:pass/:stream', '/series/:user/:pass/:stream', '/:user/:pass/:stream'], async (req, res) => { /*... (نفس الكود كما هو) ...*/ });

app.get('/', (req, res) => res.status(200).send('✅ GAMERDZ1517 SERVER IS RUNNING PERFECTLY!'));
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
