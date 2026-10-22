// 選手紹介（3D）— 配信画面（bracket.html / match.html）に重ねて流す演出
// デザインは試合配信画面（縦札）と同じ系統：黒地・白い斜めパネル・縞・Agency FB。光り物は使わない。
// 状態は localStorage 'qt_intro'（団体戦は 'qt_intro_team'）:
//   { on, ri, gid, t, idx, idxT, auto, sec }  idx = idxT 時点のスライド番号（0 = オープニング、1.. = 選手）
// 表示側は時刻から今のスライドを計算するので、途中から開いても同じ場面になる。
(function (root) {
    'use strict';
    const OPEN = 4.5, OUTRO = 0.6;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ord = n => { n = Number(n) || 0; const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
    const COLORS = (root.TournamentCore && root.TournamentCore.COLORS) || ['#e53935', '#1e88e5', '#fdd835', '#43a047', '#8e24aa', '#fb8c00', '#00acc1', '#d81b60', '#6d4c41', '#3949ab', '#7cb342', '#546e7a'];

    function durations(n, sec) { const d = [OPEN]; for (let i = 0; i < n; i++) d.push(Math.max(3, Number(sec) || 9)); return d; }
    // 今どのスライドか: { k, el(ms), end, total, endAgo(ms) }
    function position(I, n, now) {
        now = now || Date.now();
        const d = durations(n, I && I.sec);
        if (!I || !I.on) return { k: d.length, el: 0, end: true, total: d.length, endAgo: 1e9 };
        let k = Math.max(0, I.idx || 0), el = I.auto === false ? 0 : now - (I.idxT || I.t || now);
        while (k < d.length && el >= d[k] * 1000) { el -= d[k] * 1000; k++; }
        return { k, el, end: k >= d.length, total: d.length, endAgo: k >= d.length ? el : 0 };
    }
    // 試合画面側が使う：この組の紹介が「流れている」か「いつ終わったか」
    function status(get, key, gid, count) {
        let I = null; try { I = JSON.parse(get(key)); } catch (e) { }
        if (!I || !I.on || (gid && I.gid !== gid)) return null;
        const P = position(I, count);
        return P.end ? { active: false, endedAt: Date.now() - P.endAgo, t: I.t } : { active: true, t: I.t };
    }

    const CSS = `
#qti{position:fixed;inset:0;z-index:9000;background:#000;overflow:hidden;opacity:1;transition:opacity ${OUTRO}s linear;color:#fff;font-family:'Agency FB','BIZ UDPGothic','Yu Gothic','Meiryo',sans-serif}
#qti.out{opacity:0}
#qti .qst{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;overflow:hidden}
#qti .jp{font-family:'BIZ UDPGothic','Yu Gothic','Meiryo',sans-serif}
#qti .en{font-family:'Agency FB','BIZ UDPGothic',sans-serif}
#qti .stk{color:#fff;-webkit-text-stroke:var(--sw,8px) var(--sc,#111);paint-order:stroke fill}
#qti .q3{position:absolute;inset:0;perspective:2200px;perspective-origin:50% 45%}
/* 背景：斜めの縞が横に流れる（静かに） */
#qti .bgs{position:absolute;left:-200px;right:-200px;top:0;height:1080px;opacity:.07;
  background:repeating-linear-gradient(-60deg,#fff 0 3px,transparent 3px 46px);animation:qtiBg 18s linear infinite}
@keyframes qtiBg{to{transform:translateX(184px)}}
/* ヘッダー（試合配信画面と同じ形） */
#qti .hd{position:absolute;left:0;top:0;width:1920px;height:170px;animation:qtiHd .5s ease-out backwards}
#qti .hd .rl{position:absolute;left:150px;top:22px;height:96px;display:flex;align-items:center;color:#111;font-size:80px;font-weight:900;white-space:nowrap}
#qti .hd .grp{position:absolute;left:560px;top:104px;font-size:60px;line-height:1;font-weight:900;white-space:nowrap}
#qti .hd .logo{position:absolute;right:58px;top:34px;line-height:1;font-size:54px;font-weight:900;font-style:italic;transform:skewX(-12deg);white-space:nowrap;max-width:640px;overflow:hidden;text-overflow:ellipsis}
#qti .hd .cap{position:absolute;right:58px;top:124px;font-size:34px;font-weight:900;letter-spacing:2px;color:#fff}
@keyframes qtiHd{from{transform:translateY(-170px)}}
/* オープニング */
#qti .op{position:absolute;left:0;right:0;top:220px;bottom:80px;transform-style:preserve-3d}
#qti .op .big{position:absolute;left:150px;top:30px;transform-style:preserve-3d;transform-origin:0 50%;animation:qtiSlabY .7s cubic-bezier(.2,.8,.2,1) backwards}
#qti .op .big .f{position:relative;background:#fff;color:#111;padding:6px 70px 14px 50px;font-size:150px;font-weight:900;line-height:1.1;white-space:nowrap;clip-path:polygon(0 0,100% 0,calc(100% - 60px) 100%,0 100%)}
#qti .op .big .f small{font-size:.48em;margin-left:30px;vertical-align:middle}
#qti .op .big .side{position:absolute;left:0;right:60px;bottom:-26px;height:26px;background:#777;transform:rotateX(-90deg);transform-origin:50% 0}
#qti .op .sub{position:absolute;left:210px;top:250px;font-size:60px;font-weight:900;white-space:nowrap;animation:qtiIn .5s .45s ease-out backwards}
#qti .op .sub b{display:inline-block;background:#111;border:4px solid #fff;padding:0 22px;margin-right:24px;transform:skewX(-12deg)}
#qti .op .mem{position:absolute;left:150px;right:150px;top:400px;display:flex;justify-content:center;gap:16px;transform-style:preserve-3d}
#qti .op .mi{width:var(--mw,180px);height:330px;background:#36c443;position:relative;transform-style:preserve-3d;transform-origin:50% 0;animation:qtiFlip .55s cubic-bezier(.2,.9,.3,1.15) backwards}
#qti .op .mi::before{content:'';position:absolute;left:0;top:0;border-top:56px solid var(--c);border-right:56px solid transparent}
#qti .op .mi span{position:absolute;inset:16px 0 10px;display:flex;justify-content:center;writing-mode:vertical-rl;text-orientation:upright;font-size:var(--mfs,58px);font-weight:900;line-height:1;white-space:nowrap;--sc:#1e7a2c;--sw:7px}
/* 選手 */
#qti .ps{position:absolute;inset:0;transform-style:preserve-3d}
#qti .plt{position:absolute;left:150px;top:210px;width:330px;height:790px;transform-style:preserve-3d;transform-origin:0 50%;animation:qtiPlate .8s cubic-bezier(.2,.8,.25,1) backwards}
#qti .plt .f{position:absolute;inset:0;background:#36c443;overflow:hidden}
#qti .plt .f .tri{position:absolute;width:0;height:0}
#qti .plt .f .tl{left:0;top:0;border-top:120px solid var(--c);border-right:120px solid transparent}
#qti .plt .f .br{right:0;bottom:0;border-bottom:120px solid var(--c);border-left:120px solid transparent}
#qti .plt .sd{position:absolute;top:0;bottom:0;right:-34px;width:34px;background:var(--c);filter:brightness(.55);transform:rotateY(90deg);transform-origin:0 50%}
#qti .plt .tp{position:absolute;left:0;right:0;top:-34px;height:34px;background:#bbb;transform:rotateX(-90deg);transform-origin:50% 100%}
#qti .plt .in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding-top:16px}
#qti .plt .pr{font-size:100px;font-weight:900;line-height:1;height:128px;white-space:nowrap;--sc:#1e7a2c}
#qti .plt .bd{flex:1;display:flex;gap:14px;padding:26px 0 40px}
#qti .plt .nm{display:flex;flex-direction:column;justify-content:space-between;font-size:var(--nfs,150px);font-weight:900;line-height:1;--sc:#1e7a2c;--sw:10px}
#qti .plt .nm.one{justify-content:flex-start}
#qti .plt .nm span{writing-mode:vertical-rl;text-orientation:upright;white-space:nowrap}
#qti .plt .af{writing-mode:vertical-rl;text-orientation:upright;font-size:var(--afs,46px);font-weight:900;white-space:nowrap;overflow:hidden;max-height:100%;--sc:#1e7a2c;--sw:7px}
#qti .no{position:absolute;left:560px;top:212px;font-size:52px;font-weight:900;white-space:nowrap;animation:qtiIn .4s .35s ease-out backwards}
#qti .no b{display:inline-block;background:#fff;color:#111;padding:0 20px;margin-right:18px;transform:skewX(-12deg)}
#qti .pf{position:absolute;left:560px;top:290px;font-size:46px;font-weight:900;white-space:nowrap;color:#ddd;animation:qtiIn .4s .45s ease-out backwards}
#qti .pf .mb{display:block;font-size:36px;color:#bbb;margin-top:6px}
#qti .hs{position:absolute;left:560px;right:80px;top:var(--ht,400px);bottom:70px;display:flex;flex-direction:column;gap:var(--gap,16px);transform-style:preserve-3d}
#qti .row{position:relative;display:flex;flex-direction:column;transform-style:preserve-3d;transform-origin:50% 0;animation:qtiFlip .5s cubic-bezier(.2,.9,.3,1.1) backwards}
#qti .row .h{display:flex;align-items:stretch;height:var(--rh,72px);background:#fff;color:#111;clip-path:polygon(0 0,100% 0,calc(100% - 36px) 100%,0 100%)}
#qti .row .h .rn{background:#111;color:#fff;font-size:calc(var(--rh,72px)*.72);font-weight:900;padding:0 26px;display:flex;align-items:center;white-space:nowrap;border:5px solid #fff}
#qti .row .h .gr{font-size:calc(var(--rh,72px)*.5);font-weight:900;padding:0 22px;display:flex;align-items:center;white-space:nowrap}
#qti .row .h .rule{font-size:calc(var(--rh,72px)*.44);font-weight:900;color:#555;display:flex;align-items:center;white-space:nowrap;overflow:hidden}
#qti .row .h .res{margin-left:auto;min-width:200px;padding:0 60px 0 26px;font-size:calc(var(--rh,72px)*.8);font-weight:900;display:flex;align-items:center;justify-content:flex-end;white-space:nowrap}
#qti .row .h .res.adv{background:#e59a1f;color:#fff}
#qti .row .h .res.out{background:#5a5a5a;color:#ddd;font-size:calc(var(--rh,72px)*.5)}
#qti .row .h .res small{font-size:.5em;margin-left:10px}
#qti .row .b{padding:10px 0 0 26px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 0;font-size:var(--afs,34px);font-weight:900;color:#eee}
#qti .row .b .lb{font-size:.72em;color:#9a9a9a;margin-right:16px;letter-spacing:1px}
#qti .row .b .a{white-space:nowrap;max-width:460px;overflow:hidden;text-overflow:ellipsis}
#qti .row .b .a+.a::before{content:'／';color:#666;margin:0 10px}
#qti .row .b .more{color:#888;font-size:.8em;margin-left:12px}
#qti .row .w{margin:12px 0 0 26px;display:flex;align-items:stretch;transform-origin:0 50%;animation:qtiSlabY .5s cubic-bezier(.2,.9,.3,1.1) backwards}
#qti .row .w .k{background:#e59a1f;color:#fff;font-size:var(--afs,34px);font-weight:900;padding:4px 18px;white-space:nowrap;display:flex;align-items:center}
#qti .row .w .v{background:#fff;color:#111;font-size:calc(var(--afs,34px)*1.15);font-weight:900;padding:4px 26px;white-space:nowrap;display:flex;align-items:center}
#qti .row .w .q{flex:1;font-size:calc(var(--afs,34px)*.78);color:#ccc;padding:4px 20px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#qti .row .nil{padding:8px 0 0 26px;font-size:var(--afs,34px);color:#888;font-weight:900}
#qti .first{position:absolute;left:560px;top:430px;transform-origin:0 50%;animation:qtiSlabY .6s .5s cubic-bezier(.2,.9,.3,1.1) backwards}
#qti .first .f{background:#fff;color:#111;font-size:110px;font-weight:900;padding:0 80px 10px 40px;clip-path:polygon(0 0,100% 0,calc(100% - 50px) 100%,0 100%);white-space:nowrap}
#qti .first .s{font-size:46px;font-weight:900;margin:16px 0 0 10px;color:#ddd}
/* 下 */
#qti .ft{position:absolute;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;gap:10px;padding:0 60px}
#qti .ft i{flex:1;height:10px;background:#333;transform:skewX(-30deg);max-width:120px}
#qti .ft i.on{background:#fff}
#qti .ft i.now{background:var(--c,#fff)}
@keyframes qtiIn{from{opacity:0;transform:translateX(-60px)}}
@keyframes qtiFlip{from{transform:rotateX(-92deg);opacity:0}40%{opacity:1}}
@keyframes qtiSlabY{from{transform:rotateY(80deg);opacity:0}40%{opacity:1}}
@keyframes qtiPlate{0%{transform:translateX(-500px) rotateY(75deg);opacity:0}50%{opacity:1}100%{transform:rotateY(14deg)}}
#qti .plt{transform:rotateY(14deg)}
`;

    function headerSvg() {
        let stripes = '';
        for (let i = 0; i < 9; i++) { const x = 40 + i * 44; stripes += `<polygon points="${x},148 ${x + 22},148 ${x + 44},120 ${x + 22},120" fill="#fff"/>`; }
        return `<svg width="1920" height="170" viewBox="0 0 1920 170" style="position:absolute;left:0;top:0">
          <polygon points="110,18 520,18 470,112 40,112" fill="#fff"/>${stripes}
          <polyline points="560,62 620,30 1170,30" fill="none" stroke="#fff" stroke-width="5"/>
          <polyline points="500,150 540,98 980,98 1060,30" fill="none" stroke="#fff" stroke-width="4"/>
          <circle cx="1170" cy="30" r="13" fill="#fff"/>
          <polyline points="1170,30 1235,104 1880,104" fill="none" stroke="#fff" stroke-width="4"/>
          <line x1="1240" y1="118" x2="1880" y2="118" stroke="#fff" stroke-width="3"/></svg>`;
    }
    function header(S, cap) {
        return `<div class="hd">${headerSvg()}<div class="rl en jp">${esc(S.round)}</div><div class="grp jp">${esc(S.group)}</div>
          <div class="logo jp">${esc(S.title || 'QUIZ')}</div><div class="cap jp">${esc(cap)}</div></div>`;
    }
    function nameCols(name) {
        const parts = String(name || '').trim().split(/[\s　]+/);
        return parts.length > 1 ? { one: false, html: `<span>${esc(parts[0])}</span><span>${esc(parts.slice(1).join(''))}</span>` } : { one: true, html: `<span>${esc(name)}</span>` };
    }
    function gradeOf(g) { return /^\d+$/.test(g || '') ? g + '年' : (g || ''); }

    function openSlide(S) {
        const n = S.players.length;
        const mw = Math.min(200, Math.floor((1620 - 16 * (n - 1)) / Math.max(n, 1)));
        const mfs = Math.round(Math.min(mw * .36, 64));
        let mem = '';
        S.players.forEach((p, i) => {
            const len = [...String(p.name).replace(/[\s　]/g, '')].length;
            mem += `<div class="mi" style="--c:${COLORS[i % COLORS.length]};animation-delay:${(.9 + i * .12).toFixed(2)}s"><span class="jp stk" style="--mfs:${Math.min(mfs, Math.floor(290 / Math.max(len, 1)))}px">${esc(String(p.name).replace(/[\s　]/g, ''))}</span></div>`;
        });
        return `<div class="op jp">
          <div class="big"><div class="f">${esc(S.round)}<small>${esc(S.group)}</small></div><div class="side"></div></div>
          <div class="sub"><b class="en">${esc(S.rule)}</b>${n}人 → ${S.advance}人勝ち抜け</div>
          <div class="mem" style="--mw:${mw}px">${mem}</div></div>`;
    }

    function playerSlide(S, i) {
        const p = S.players[i], c = COLORS[i % COLORS.length];
        const nc = nameCols(p.name);
        const longest = Math.max(...String(p.name).trim().split(/[\s　]+/).map(x => [...x].length), 1);
        const nfs = Math.min(150, Math.floor((nc.one ? 600 : 560) / longest));
        const aff = (p.affiliation || '') + gradeOf(p.grade);
        const afs = Math.min(46, Math.floor(600 / Math.max([...aff].length, 1)));
        let h = `<div class="ps">
          <div class="plt" style="--c:${c}"><div class="sd"></div><div class="tp"></div><div class="f"><div class="tri tl"></div><div class="tri br"></div>
            <div class="in"><div class="pr en stk">${p.paperRank ? esc(ord(p.paperRank)) : ''}</div>
            <div class="bd"><div class="nm jp stk ${nc.one ? 'one' : ''}" style="--nfs:${nfs}px">${nc.html}</div>${aff ? `<div class="af jp stk" style="--afs:${afs}px">${esc(aff)}</div>` : ''}</div></div></div></div>
          <div class="no jp"><b class="en">PLAYER ${i + 1}/${S.players.length}</b>${esc(p.name)}</div>
          <div class="pf jp">${esc(p.affiliation)}${p.grade ? '　' + esc(gradeOf(p.grade)) : ''}${p.paperRank ? `　ペーパー${p.paperRank}位${p.paper != null ? `（${esc(p.paper)}点）` : ''}` : ''}${p.members ? `<span class="mb">${esc(p.members.split(/[\/／、,]/).join('・'))}</span>` : ''}</div>`;
        const hist = p.hist || [], H = hist.length;
        if (!H) {
            h += `<div class="first jp"><div class="f">初登場</div><div class="s">${p.paperRank ? `ペーパー${p.paperRank}位から、このラウンドで登場` : 'このラウンドから出場'}</div></div>`;
            return h + '</div>';
        }
        const rh = H <= 2 ? 76 : H <= 3 ? 64 : H <= 4 ? 54 : 46, afs2 = H <= 2 ? 36 : H <= 3 ? 31 : H <= 4 ? 27 : 24;
        const maxA = H <= 2 ? 10 : H <= 3 ? 7 : 5;
        h += `<div class="hs jp" style="--rh:${rh}px;--afs:${afs2}px;--gap:${H <= 3 ? 22 : 12}px;--ht:${p.members ? 420 : 390}px">`;
        hist.forEach((x, k) => {
            const dl = (.75 + k * .5).toFixed(2);
            if (x.kind === 'paper') {
                h += `<div class="row" style="animation-delay:${dl}s"><div class="h"><span class="rn">${esc(x.round)}</span><span class="gr">ペーパー</span><span class="rule">${x.score != null ? esc(x.score) + '点' : ''}</span><span class="res adv">${x.rank ? x.rank + '位' : ''}<small>シード</small></span></div></div>`;
                return;
            }
            const res = x.adv ? `<span class="res adv en">${x.rank ? ord(x.rank) : 'WIN'}<small class="jp">通過</small></span>` : x.done ? '<span class="res out">敗退</span>' : '<span class="res"></span>';
            const cs = x.corrects || [];
            const others = x.win ? cs.slice(0, -1) : cs;
            const show = others.slice(Math.max(0, others.length - maxA));
            let b = '';
            if (others.length) b = `<div class="b"><span class="lb">正解 ${cs.length}問</span>${show.map(c2 => `<span class="a">${esc(c2.aText || (c2.q ? 'Q' + c2.q : '○'))}</span>`).join('')}${others.length > maxA ? `<span class="more">ほか${others.length - maxA}問</span>` : ''}</div>`;
            const w = x.win ? `<div class="w" style="animation-delay:${(+dl + .35).toFixed(2)}s"><span class="k">勝ち抜け${x.win.q ? ' Q' + esc(x.win.q) : ''}</span><span class="v">${esc(x.win.aText || '―')}</span>${x.win.qText && H <= 3 ? `<span class="q">${esc(x.win.qText)}</span>` : ''}</div>` : '';
            h += `<div class="row" style="animation-delay:${dl}s"><div class="h"><span class="rn">${esc(x.round)}</span><span class="gr">${esc(x.group)}</span><span class="rule en">${esc(x.rule)}</span>${res}</div>
              ${b}${w}${!cs.length ? `<div class="nil">${x.o || x.x ? '' : '記録なし'}</div>` : ''}</div>`;
        });
        return h + '</div></div>';
    }

    function create(opts) {
        // opts: { get(key)→string, key, accept(T, I)→bool, onState(active) }
        const TC = root.TournamentCore;
        let el = null, st = null, slot = null, hd = null, ft = null;
        let lastIt = null, lastK = -1, lastN = 0, slides = null, active = false;
        function fit() { if (!st) return; const s = Math.min(innerWidth / 1920, innerHeight / 1080); st.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px,${(innerHeight - 1080 * s) / 2}px) scale(${s})`; }
        function ensureDom() {
            if (el) return;
            if (!document.getElementById('qti-css')) { const s = document.createElement('style'); s.id = 'qti-css'; s.textContent = CSS; document.head.appendChild(s); }
            el = document.createElement('div'); el.id = 'qti';
            el.innerHTML = `<div class="qst"><div class="bgs"></div><div class="q3"><div class="slot"></div></div><div class="hdw"></div><div class="ft"></div></div>`;
            document.body.appendChild(el);
            st = el.querySelector('.qst'); slot = el.querySelector('.slot'); hd = el.querySelector('.hdw'); ft = el.querySelector('.ft');
            fit(); addEventListener('resize', fit);
        }
        function remove() { if (el) { el.remove(); el = null; } lastK = -1; }
        function tick() {
            let I = null, T = null;
            const is = opts.get(opts.key);
            try { I = JSON.parse(is); } catch (e) { }
            if (I && I.on) {
                if (is !== lastIt || !slides) {
                    try { T = JSON.parse(opts.get(TC.KEY)); TC.ensure(T); } catch (e) { T = null; }
                    let live = []; try { live = JSON.parse(opts.get('quiz_press_log')) || []; } catch (e) { }
                    const ok = T && (!opts.accept || opts.accept(T, I));
                    const S = ok ? TC.introSlides(T, I.ri, I.gid, live) : null;
                    if (!S || !S.players.length) { I = null; slides = null; }
                    else { if (!slides || slides.key !== I.t + ':' + I.gid) lastK = -1; slides = S; slides.key = I.t + ':' + I.gid; }
                    lastIt = is;
                }
            } else { slides = null; lastIt = is; }
            const P = slides ? position(I, slides.players.length) : { end: true, endAgo: 1e9 };
            const show = slides && (!P.end || P.endAgo < OUTRO * 1000);
            if (!show) { if (active) { active = false; opts.onState && opts.onState(false); } remove(); return; }
            ensureDom();
            if (!active) { active = true; opts.onState && opts.onState(true); }
            if (P.end) { el.classList.add('out'); return; }
            el.classList.remove('out');
            const k = P.k, n = slides.players.length;
            if (k !== lastK || n !== lastN) {
                if (lastK < 0) hd.innerHTML = header(slides, '選手紹介');
                slot.innerHTML = k === 0 ? openSlide(slides) : playerSlide(slides, k - 1);
                ft.innerHTML = slides.players.map((_, i) => `<i class="${k > 0 && i < k - 1 ? 'on' : k > 0 && i === k - 1 ? 'now' : ''}" style="--c:${COLORS[i % COLORS.length]}"></i>`).join('');
                lastK = k; lastN = n;
            }
        }
        const timer = setInterval(tick, 120); tick();
        return { tick, isActive: () => active, stop() { clearInterval(timer); remove(); } };
    }

    root.QTIntro = { create, position, durations, status, OPEN, OUTRO, COLORS };
})(typeof window !== 'undefined' ? window : globalThis);
