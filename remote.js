/* =====================================================================
 * remote.js — スマホで表示画面を見る（QRコード）
 *  方式1 同じWi-Fi : アプリ本体のローカルサーバー（?remote=1, SSE）
 *  方式2 インターネット: GitHub Pages の表示画面 + 公開MQTTサーバーで中継（?cloud=1）
 *        データはURLの#以降にある鍵でAES-GCM暗号化（鍵はサーバーに送られない）
 *  ・操作画面 : localStorage の変化を送信＋QRコードパネル
 *  ・表示画面（PC）: 「表示画面にQRを出す」がONなら右下にQRコード
 *  ・スマホ   : 受け取って表示するだけ（操作・音は無効）
 * ===================================================================== */
(function () {
    const PAGE = (location.pathname.split('/').pop() || '').toLowerCase();
    const IS_LAN_REMOTE = /[?&]remote=1/.test(location.search);
    const IS_CLOUD_REMOTE = /[?&]cloud=1/.test(location.search);
    const IS_REMOTE = IS_LAN_REMOTE || IS_CLOUD_REMOTE;
    const API = window.electronAPI;
    const HAS_LAN = !!(API && API.remotePush);
    const IS_HOST = !IS_REMOTE && /setup\.html$/.test(PAGE);
    const EXCLUDE = /^(quiz_history|eq_undo|quiz_sheets_keyfile_path|quiz_buzz_binds|quiz_se_duck_count|quiz_qr_show|quiz_remote_url|quiz_remote_ip_idx|quiz_cloud_.*)$/;
    const CLOUD_PAGE = 'https://volcanotkahasi.github.io/Quizview/';
    const BROKERS = window.__HQ_BROKERS || [
        { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
        { url: 'wss://broker.emqx.io:8084/mqtt' },
        { url: 'wss://broker.hivemq.com:8884/mqtt' }];
    const brokerOpts = (i, extra) => { const b = BROKERS[i] || BROKERS[0]; return [b.url, Object.assign({ username: b.username, password: b.password }, extra)]; };
    const TOPIC = room => `hayaoshiq/v1/${room}/k/`;
    const MAX_VAL = 256 * 1024;

    // ---------------- 暗号化（AES-GCM） ----------------
    const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
    function importKey(k) { return crypto.subtle.importKey('raw', unb64u(k), 'AES-GCM', false, ['encrypt', 'decrypt']); }
    async function enc(key, text) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
        const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12);
        return out;
    }
    async function dec(key, bytes) {
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
        return new TextDecoder().decode(pt);
    }
    function randId(n) { const a = crypto.getRandomValues(new Uint8Array(n)); return Array.from(a, x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join(''); }

    // ---------------- レスポンシブ（スマホ・タブレットで見る時だけ） ----------------
    // 元の表示画面はプロジェクター(16:9)向けに vw/vh で作られているので、
    // CSS内の vw/vh を var(--rvw)/var(--rvh) に置き換え、端末の画面サイズと人数から
    // 毎回いちばん大きく見える並べ方（列×段）を計算して値を入れる。
    function setupResponsive(isTeam) {
        const root = document.documentElement;
        root.classList.add('rsp');
        const SKIP_D = /^\s*(html|body)\s*(,\s*(html|body)\s*)*$|top-strip|strip-pill|head-num|rule-image|qa-banner|q-display|a-display|deliberation|reach-cutin|full-eruption|qr-|remote-|rsp/;
        const SKIP_T = /^\s*(html|body)\s*(,\s*(html|body)\s*)*$|qr-|remote-|rsp/;
        const SKIP = isTeam ? SKIP_T : SKIP_D;
        const RE = /(-?\d*\.?\d+)v([wh])\b/g;
        const conv = v => v.replace(RE, (m, n, u) => `calc(${n} * var(--rv${u}))`);
        const done = new WeakSet();
        function rewrite(rules) {
            for (const r of Array.from(rules)) {
                if (r.selectorText && SKIP.test(r.selectorText)) continue;
                const s = r.style;
                if (s) for (let i = 0; i < s.length; i++) {
                    const p = s[i], v = s.getPropertyValue(p);
                    if (/\dv[wh]\b/.test(v)) s.setProperty(p, conv(v), s.getPropertyPriority(p));
                }
                if (r.cssRules) rewrite(r.cssRules);
            }
        }
        function rewriteAll() {
            for (const sh of Array.from(document.styleSheets)) {
                if (done.has(sh)) continue;
                let rules; try { rules = sh.cssRules; } catch (e) { done.add(sh); continue; }
                if (!rules) continue;
                done.add(sh); try { rewrite(rules); } catch (e) { }
            }
        }
        let last = '';
        function setVars(o) {
            const sig = JSON.stringify(o); if (sig === last) return false; last = sig;
            for (const k in o) root.style.setProperty('--' + k, k === 'cols' ? String(o[k] | 0) : typeof o[k] === 'number' ? o[k].toFixed(2) + 'px' : o[k]);
            return true;
        }
        function layoutDisplay(W, H, port) {
            const n = Math.max(1, document.querySelectorAll('#main-screen .player-column').length);
            const th = Math.round(Math.max(30, Math.min(H * (port ? 0.055 : 0.09), 92)));
            const qh = Math.round(H * (port ? 0.15 : 0.17)), qm = Math.round(H * 0.012), pb = Math.round(H * 0.015);
            const gapX = Math.max(4, W * 0.012), gapY = Math.max(6, H * (port ? 0.02 : 0.015));
            const AW = W * 0.96, AH = H - th - qh - qm - pb;
            let best = null;
            for (let c = 1; c <= n; c++) {
                const r = Math.ceil(n / c);
                const cw = (AW - gapX * (c - 1)) / c;
                const top = r > 1 ? cw * 0.2 : 0; // 押し順バッジ等の余白
                const rh = (AH - gapY * (r - 1)) / r;
                const u = Math.min(cw, (rh - top) / 4.1, 230);
                if (!best || u > best.u + 0.5) best = { c, r, cw, rh, u };
            }
            const { c, rh, u } = best;
            const colw = Math.min(best.cw, u * 1.25);
            const cardh = Math.max(u * 1.2, rh - u * 1.2 - 16 - (best.r > 1 ? best.cw * 0.2 : 0));
            return { H, th, qh, qm, pb, gapx: gapX, gapy: gapY, cols: c, colw, rowh: rh, cardh, rvw: u / 9.9, rvh: u / 17.6 };
        }
        function layoutTeam(W, H, port) {
            const n = Math.max(1, document.querySelectorAll('#stage .team').length);
            let u;
            if (port) u = Math.min(W / (n > 2 ? 58 : 88), H / (16 + (n > 2 ? 64 : 78) * n));
            else u = Math.min(H / 100, W / 177.8);
            return { H, rvh: u, rvw: u * 1.778 };
        }
        function layout() {
            const W = window.innerWidth, H = window.innerHeight, port = H > W * 1.05;
            root.classList.toggle('rsp-port', !!port);
            rewriteAll();
            const changed = setVars(isTeam ? layoutTeam(W, H, port) : layoutDisplay(W, H, port));
            if (changed && typeof window.fitQaText === 'function') { try { window.fitQaText(); } catch (e) { } }
        }
        let raf = 0;
        const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; layout(); }); };
        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', () => setTimeout(schedule, 200));
        new MutationObserver(schedule).observe(document.head, { childList: true });
        window.addEventListener('DOMContentLoaded', () => {
            const box = document.getElementById(isTeam ? 'stage' : 'main-screen');
            if (box) new MutationObserver(schedule).observe(box, { childList: true });
            layout(); setTimeout(layout, 300);
        });
        window.addEventListener('load', schedule);
    }

    // ---------------- スマホ側 ----------------
    if (IS_REMOTE) {
        window.__REMOTE_VIEW = true;
        try { HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; } catch (e) { }
        try { window.AudioContext = window.webkitAudioContext = function () { throw new Error('muted'); }; } catch (e) { }
        const block = e => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); };
        ['click', 'pointerdown', 'mousedown', 'touchend', 'dblclick', 'contextmenu', 'keydown', 'keyup'].forEach(t => window.addEventListener(t, block, true));
        const st = document.createElement('style');
        st.textContent = `.control-panel,.hover-ctrl,.qr-overlay{display:none!important}
            #remote-status{position:fixed;left:6px;bottom:calc(6px + env(safe-area-inset-bottom));z-index:99999;font:12px sans-serif;color:#9aa;background:rgba(0,0,0,.55);padding:2px 8px;border-radius:8px;pointer-events:none;transition:opacity .6s}
            #remote-status.ok{opacity:0;transition-delay:3s}
            html.rsp,html.rsp body{height:var(--H)!important;min-height:0!important;overflow:hidden!important}
            html.rsp body{width:100vw;-webkit-text-size-adjust:100%;text-size-adjust:100%}
            /* ---- 個人戦 ---- */
            html.rsp .top-strip{height:var(--th)!important;flex:0 0 var(--th)!important;padding:0 3vw!important}
            html.rsp .top-strip .strip-pill,html.rsp #head-num{font-size:calc(var(--th) * .6)!important;gap:calc(var(--th) * .25)!important}
            html.rsp .rule-image{max-height:calc(var(--th) * .75)!important}
            html.rsp .qa-banner{height:var(--qh)!important;min-height:0!important;max-height:none!important;margin:0 2vw var(--qm)!important;padding:calc(var(--qh) * .08) 3vw!important;border-radius:12px!important;gap:3vw!important}
            html.rsp.rsp-port .qa-banner{flex-direction:column;align-items:stretch;justify-content:center;gap:4px!important}
            html.rsp.rsp-port .q-display,html.rsp.rsp-port .a-display{flex:0 1 auto!important}
            html.rsp #deliberation-text{font-size:calc(var(--qh) * .3)!important}
            html.rsp .screen{display:grid!important;grid-template-columns:repeat(var(--cols),var(--colw));grid-auto-rows:var(--rowh);justify-content:center;align-content:center;align-items:end;padding:0 2vw var(--pb)!important;gap:var(--gapy) var(--gapx)!important;width:100vw!important}
            html.rsp .player-column{max-width:none!important;width:100%!important;height:100%!important;margin:0!important}
            html.rsp .name-card{height:var(--cardh)!important;max-height:none!important}
            html.rsp .mp-banner{top:calc(var(--th) + 4px)!important}
            html.rsp.rsp-port .reach-cutin-school{font-size:min(4.5vw,3vh)!important}
            html.rsp.rsp-port .reach-cutin-name:not([style*="font-size"]){font-size:min(11vw,8vh)!important}
            html.rsp.rsp-port .reach-cutin-label{font-size:min(15vw,10vh)!important;-webkit-text-stroke-width:2px!important}
            /* ---- チーム戦 ---- */
            html.rsp.rsp-port #stage{flex-direction:column!important;justify-content:center!important}
            html.rsp.rsp-port #stage .team{flex:0 0 auto!important}`;
        document.head.appendChild(st);
        if (!document.querySelector('meta[name=viewport]')) {
            const mv = document.createElement('meta'); mv.name = 'viewport';
            mv.content = 'width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover';
            document.head.appendChild(mv);
        }
        setupResponsive(/team-display/.test(PAGE));

        const myKind = /team-display/.test(PAGE) ? 'team' : 'display';
        function gotoKind(kind) {
            if (IS_LAN_REMOTE) location.replace('/view');
            else location.replace((kind === 'team' ? 'team-display.html' : 'display.html') + location.search + location.hash);
        }
        function apply(data, full) {
            if (!data) return;
            if (data.quiz_remote_page && data.quiz_remote_page !== myKind) { gotoKind(data.quiz_remote_page); return; }
            const changed = [];
            for (const k of Object.keys(data)) {
                const v = data[k] == null ? null : String(data[k]);
                const old = localStorage.getItem(k);
                if (old === v) continue;
                if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v);
                changed.push([k, old, v]);
            }
            if (full) {
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const k = localStorage.key(i);
                    if (!(k in data)) { const old = localStorage.getItem(k); localStorage.removeItem(k); changed.push([k, old, null]); }
                }
            }
            for (const [k, o, n] of changed) {
                try { window.dispatchEvent(new StorageEvent('storage', { key: k, oldValue: o, newValue: n })); } catch (e) { }
            }
        }
        function setStatus(t) { const el = document.getElementById('remote-status'); if (el) { el.textContent = t; el.classList.toggle('ok', t.startsWith('●')); } }

        function connectLan() {
            const es = new EventSource('/api/events');
            es.onmessage = ev => { try { const m = JSON.parse(ev.data); apply(m.data, m.full); setStatus('● 接続中'); } catch (e) { } };
            es.onerror = () => setStatus('○ 再接続中…');
        }
        async function connectCloud() {
            const h = new URLSearchParams(location.hash.slice(1));
            const room = h.get('r'), k = h.get('k'), b = Number(h.get('b') || 0);
            if (!room || !k || typeof mqtt === 'undefined') { setStatus('URLが正しくありません。QRコードを読み直してください'); return; }
            if (sessionStorage.getItem('cloud_room') !== room) { localStorage.clear(); sessionStorage.setItem('cloud_room', room); }
            let key; try { key = await importKey(k); } catch (e) { setStatus('URLが正しくありません'); return; }
            const prefix = TOPIC(room);
            const cli = mqtt.connect(...brokerOpts(b, { clientId: 'hqv_' + randId(10), clean: true, reconnectPeriod: 2000, connectTimeout: 10000 }));
            cli.on('connect', () => { setStatus('● 接続中'); cli.subscribe(prefix + '#', { qos: 0 }); });
            cli.on('reconnect', () => setStatus('○ 再接続中…'));
            cli.on('offline', () => setStatus('○ オフライン'));
            let chain = Promise.resolve();
            cli.on('message', (topic, payload) => {
                const name = topic.slice(prefix.length);
                chain = chain.then(async () => {
                    if (!payload || !payload.length) { apply({ [name]: null }); return; }
                    try { apply({ [name]: await dec(key, new Uint8Array(payload)) }); } catch (e) { }
                });
            });
        }
        window.addEventListener('DOMContentLoaded', () => {
            const s = document.createElement('div'); s.id = 'remote-status'; s.textContent = '接続中…'; document.body.appendChild(s);
            if (IS_LAN_REMOTE) connectLan(); else connectCloud();
        });
        return;
    }

    // ---------------- QRコード描画 ----------------
    function qrSvg(text, cell) {
        if (typeof qrcode !== 'function') return '';
        const q = qrcode(0, 'L'); q.addData(text); q.make();
        return q.createSvgTag({ cellSize: cell || 6, margin: 2, scalable: true });
    }

    // ---------------- 表示画面（PC） ----------------
    if (!IS_HOST && /display\.html$/.test(PAGE)) {
        const st = document.createElement('style');
        st.textContent = `.qr-overlay{position:fixed;right:1.2vw;bottom:1.2vw;z-index:9000;background:#fff;border-radius:12px;padding:10px 10px 6px;box-shadow:0 6px 24px rgba(0,0,0,.6);text-align:center}
            .qr-overlay svg{width:15vw;height:15vw;max-width:260px;max-height:260px;min-width:120px;min-height:120px;display:block}
            .qr-overlay .qr-cap{font:bold 1vw 'BIZ UDPGothic',sans-serif;color:#111;margin-top:4px;white-space:nowrap}`;
        document.head.appendChild(st);
        let lastKey = '';
        function refresh() {
            const show = localStorage.getItem('quiz_qr_show') === '1';
            const url = localStorage.getItem('quiz_remote_url') || '';
            const key = show + '|' + url;
            if (key === lastKey) return; lastKey = key;
            let el = document.querySelector('.qr-overlay');
            if (!show || !url) { if (el) el.remove(); return; }
            if (!el) { el = document.createElement('div'); el.className = 'qr-overlay'; document.body.appendChild(el); }
            el.innerHTML = qrSvg(url, 6) + `<div class="qr-cap">スマホで表示画面を見る</div>`;
        }
        window.addEventListener('storage', refresh);
        setInterval(refresh, 1000);
        window.addEventListener('DOMContentLoaded', refresh);
        return;
    }

    // ---------------- 操作画面 ----------------
    if (!IS_HOST) return;
    const myKind = /team-setup/.test(PAGE) ? 'team' : 'display';
    localStorage.setItem('quiz_remote_page', myKind);

    function snapshot() {
        const now = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!EXCLUDE.test(k)) now[k] = localStorage.getItem(k);
        }
        return now;
    }
    function diffOf(last, now) {
        const diff = {}; let n = 0;
        for (const k in now) if (last[k] !== now[k]) { diff[k] = now[k]; n++; }
        for (const k in last) if (!(k in now)) { diff[k] = null; n++; }
        return n ? diff : null;
    }

    // --- 方式1: 同じWi-Fi ---
    let lanLast = {};
    // --- 方式2: インターネット ---
    const cloudOn = () => localStorage.getItem('quiz_cloud_on') === '1';
    let cloud = null; // { cli, key, room, prefix, last, chain, connected }
    function cloudCreds() {
        let room = localStorage.getItem('quiz_cloud_room'), k = localStorage.getItem('quiz_cloud_key');
        if (!room || !k) {
            room = randId(12); k = b64u(crypto.getRandomValues(new Uint8Array(16)));
            localStorage.setItem('quiz_cloud_room', room); localStorage.setItem('quiz_cloud_key', k);
        }
        return { room, k, b: Number(localStorage.getItem('quiz_cloud_broker') || 0) };
    }
    function cloudUrl() { const c = cloudCreds(); return `${CLOUD_PAGE}display.html?cloud=1#r=${c.room}&k=${c.k}&b=${c.b}`; }
    async function startCloud() {
        stopCloud();
        if (typeof mqtt === 'undefined' || !window.crypto || !crypto.subtle) { cloudStatus = 'この環境では使えません'; return; }
        const c = cloudCreds();
        const key = await importKey(c.k);
        const cli = mqtt.connect(...brokerOpts(c.b, { clientId: 'hqh_' + randId(10), clean: true, reconnectPeriod: 3000, connectTimeout: 10000 }));
        cloud = { cli, key, room: c.room, prefix: TOPIC(c.room), last: {}, chain: Promise.resolve(), connected: false, fails: 0 };
        const me = cloud;
        cloudStatus = '接続中…';
        cli.on('connect', () => { me.connected = true; me.fails = 0; me.last = {}; cloudStatus = '● 配信中'; refreshPanel(); });
        cli.on('close', () => {
            if (me !== cloud) return;
            me.connected = false; cloudStatus = '○ 再接続中…'; me.fails++;
            // つながらない時は別の公開サーバーへ切り替え（QRも変わる）
            if (me.fails >= 4) { localStorage.setItem('quiz_cloud_broker', String((c.b + 1) % BROKERS.length)); startCloud(); }
            refreshPanel();
        });
    }
    function stopCloud() { if (cloud) { const c = cloud; cloud = null; try { c.cli.end(true); } catch (e) { } } }
    let cloudStatus = '';
    function pushCloud(now) {
        if (!cloud || !cloud.connected) return;
        const diff = diffOf(cloud.last, now); if (!diff) return;
        cloud.last = now;
        const me = cloud;
        for (const k of Object.keys(diff)) {
            const v = diff[k];
            me.chain = me.chain.then(async () => {
                if (me !== cloud) return;
                if (v == null) { me.cli.publish(me.prefix + k, '', { retain: true, qos: 0 }); return; }
                if (v.length > MAX_VAL) return;
                const body = await enc(me.key, v);
                me.cli.publish(me.prefix + k, body, { retain: true, qos: 0 });
            }).catch(() => { });
        }
    }

    function tick() {
        const now = snapshot();
        if (HAS_LAN) { const d = diffOf(lanLast, now); if (d) { lanLast = now; try { API.remotePush(d); } catch (e) { } } }
        pushCloud(now);
    }
    setInterval(tick, 200);

    // --- QRパネル ---
    let info = null, ipIdx = Number(localStorage.getItem('quiz_remote_ip_idx') || 0);
    function lanUrl() {
        if (!info || !info.port || !info.ips.length) return '';
        const ip = info.ips[Math.min(ipIdx, info.ips.length - 1)].address;
        return `http://${ip}:${info.port}/view`;
    }
    function currentUrl() { return cloudOn() ? cloudUrl() : lanUrl(); }
    async function loadInfo() {
        if (HAS_LAN) { try { info = await API.remoteInfo(); } catch (e) { info = null; } }
        const url = currentUrl();
        if (localStorage.getItem('quiz_remote_url') !== url) localStorage.setItem('quiz_remote_url', url);
        refreshPanel();
    }
    let lastSig = '';
    function refreshPanel(force) {
        const p = document.getElementById('rmPanel');
        if (!p || !p.classList.contains('show')) return;
        const sig = JSON.stringify(info) + ipIdx + cloudOn() + cloudStatus + currentUrl();
        if (!force && sig === lastSig) return; lastSig = sig; renderPanel();
    }
    const css = document.createElement('style');
    css.textContent = `#rmBtn{position:fixed;left:12px;bottom:12px;z-index:9500;background:#222;color:#fff;border:none;border-radius:22px;padding:10px 16px;font:bold 14px 'BIZ UDPGothic',sans-serif;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35)}
        #rmPanel{position:fixed;left:12px;bottom:60px;z-index:9500;background:#fff;color:#222;border-radius:14px;padding:14px 16px;width:310px;box-shadow:0 8px 30px rgba(0,0,0,.4);display:none;font:13px 'BIZ UDPGothic',sans-serif}
        #rmPanel.show{display:block} #rmPanel svg{width:220px;height:220px;display:block;margin:6px auto}
        #rmPanel .u{font:12px monospace;word-break:break-all;text-align:center;user-select:all;color:#444;max-height:3.2em;overflow:hidden} #rmPanel select{width:100%;margin:4px 0}
        #rmPanel .tabs{display:flex;gap:6px;margin:8px 0}#rmPanel .tabs button{flex:1;padding:6px 4px;border:1px solid #bbb;background:#f4f4f4;border-radius:8px;cursor:pointer;font:bold 12px 'BIZ UDPGothic',sans-serif}
        #rmPanel .tabs button.on{background:#222;color:#fff;border-color:#222}
        #rmPanel .note{color:#777;font-size:11px;line-height:1.5;margin-top:6px} #rmPanel .st{font-weight:bold;text-align:center;margin-top:2px}
        #rmPanel .sm{font-size:11px;padding:3px 8px;margin-top:4px;cursor:pointer}`;
    document.head.appendChild(css);
    function renderPanel() {
        const p = document.getElementById('rmPanel'); if (!p) return;
        const on = cloudOn();
        const url = currentUrl();
        const tabs = `<div class="tabs"><button data-m="lan" class="${on ? '' : 'on'}">同じWi-Fi</button><button data-m="cloud" class="${on ? 'on' : ''}">インターネット経由</button></div>`;
        let body;
        if (!on) {
            if (!HAS_LAN) body = '<div class="note">「同じWi-Fi」方式はアプリ版でのみ使えます。「インターネット経由」を選んでください。</div>';
            else if (!url) body = '<div class="note">ネットワークが見つかりません。PCをWi-Fi/LANに接続してください。</div>';
            else {
                const opts = info.ips.map((x, i) => `<option value="${i}" ${i === ipIdx ? 'selected' : ''}>${x.address}（${x.name}）</option>`).join('');
                body = `${qrSvg(url, 5)}<div class="u">${url}</div>${info.ips.length > 1 ? `<select id="rmIp">${opts}</select>` : ''}
                    <div class="note">接続中のスマホ: ${info.clients}台<br>PCと同じWi-Fiのスマホで読み取ってください。初回はWindowsのファイアウォール確認で「許可」を。</div>`;
            }
        } else {
            body = `${qrSvg(url, 4)}<div class="st">${cloudStatus}</div>
                <div class="note">スマホはモバイル回線でOK（PCはインターネット接続が必要）。内容は暗号化して送っています。<br>
                <button class="sm" id="rmNew">URLを作り直す</button>（以前のQRで見ている人は見られなくなります）</div>`;
        }
        p.innerHTML = `<b>📱 スマホで表示画面を見る</b>${tabs}${body}
            <label style="display:block;margin-top:8px"><input type="checkbox" id="rmShow" ${localStorage.getItem('quiz_qr_show') === '1' ? 'checked' : ''}> 表示画面（プロジェクター）にQRコードを出す</label>`;
        p.querySelectorAll('.tabs button').forEach(bt => bt.onclick = () => {
            const c = bt.dataset.m === 'cloud';
            localStorage.setItem('quiz_cloud_on', c ? '1' : '0');
            if (c) startCloud(); else stopCloud();
            loadInfo(); refreshPanel(true);
        });
        const sel = document.getElementById('rmIp');
        if (sel) sel.onchange = () => { ipIdx = Number(sel.value); localStorage.setItem('quiz_remote_ip_idx', ipIdx); loadInfo(); };
        const nb = document.getElementById('rmNew');
        if (nb) nb.onclick = () => { if (!confirm('新しいURL（QRコード）を作りますか？')) return; localStorage.removeItem('quiz_cloud_room'); localStorage.removeItem('quiz_cloud_key'); startCloud(); loadInfo(); };
        document.getElementById('rmShow').onchange = e => localStorage.setItem('quiz_qr_show', e.target.checked ? '1' : '0');
    }
    window.addEventListener('DOMContentLoaded', () => {
        const b = document.createElement('button'); b.id = 'rmBtn'; b.textContent = '📱 スマホ表示(QR)';
        const p = document.createElement('div'); p.id = 'rmPanel';
        document.body.appendChild(b); document.body.appendChild(p);
        b.onclick = () => { p.classList.toggle('show'); refreshPanel(true); loadInfo(); };
        if (cloudOn()) startCloud();
        loadInfo();
        setInterval(loadInfo, 3000);
    });
})();
