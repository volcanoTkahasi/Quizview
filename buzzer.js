/*
 * buzzer.js — 早押しボタン機能（ゲームパッド / キーボード）
 * -----------------------------------------------------------------------
 * setup.html と display.html の両方で読み込む。得点・ルール・問題文などは
 * 既存の quiz-core.js / setup.html の処理をそのまま使い、ここでは
 * 「誰が先に押したか（解答権）」だけを管理する。
 *
 * localStorage
 *   quiz_buzz       : { phase:'idle'|'open'|'locked', queue:[id], answering:id|null,
 *                       tried:[id], timerEnd:ms, timeUp:bool, seq:number }
 *   quiz_buzz_binds : [ {type:'key',code} | {type:'pad',pad,btn} | null ] … 壇上の席順(1〜16)ごと
 *   quiz_buzz_cfg   : { time, afterNg, autoOpen, showOrder, sound }
 *
 * ボタンは「壇上プールの並び順（＝表示画面の左から何番目）」に割り当てる。
 * 押した判定は両方の画面で行い、Web Locks で先着1回だけ書き込む。
 */
const Buzzer = (() => {
    const IS_SETUP = !!document.getElementById('playerList');
    const IS_DISPLAY = !IS_SETUP && !!document.getElementById('main-screen');
    const LOCK = 'quiz-buzz-lock';
    const MAX_SEATS = 16;
    const DEF_CFG = { time: 5, afterNg: 'end', autoOpen: false, showOrder: true, sound: true };
    const OP_KEYS = ['Space', 'KeyQ', 'KeyW', 'Escape'];
    const KB_DEFAULT = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','KeyA','KeyS','KeyD','KeyF','KeyG','KeyH'];

    // Agency FB（PCにインストール済みならそれを使用。同じフォルダに AGENCYR.TTF / AGENCYB.TTF を置いても可）
    const FONT_CSS = `
        @font-face{font-family:'Agency FB';src:url('fonts/AGENCYB.TTF'),local('Agency FB Bold'),local('AgencyFB-Bold');font-weight:100 900;unicode-range:U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-205E,U+20AC,U+2122,U+2190-2199}
        @font-face{font-family:'BIZ UDPGothic';src:local('BIZ UDPGothic'),local('BIZ UDPゴシック'),local('BIZUDPGothic-Regular'),url('fonts/BIZUDPGothic-Regular.ttf');font-weight:100 500}
        @font-face{font-family:'BIZ UDPGothic';src:local('BIZ UDPGothic Bold'),local('BIZ UDPゴシック Bold'),local('BIZUDPGothic-Bold'),url('fonts/BIZUDPGothic-Bold.ttf');font-weight:600 900}
        html body, html body *:not(.material-icons){font-family:'Agency FB','BIZ UDPGothic','BIZ UDPゴシック','Yu Gothic','Meiryo',sans-serif !important}
    `;
    const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
    const idleState = () => ({ q: QuizCore.readState().rules.questionNum, phase: 'idle', queue: [], answering: null, tried: [], times: {}, timerEnd: 0, timeUp: false, seq: Date.now() });
    const readBuzz = () => Object.assign(idleState(), jget('quiz_buzz', {}));
    const readBinds = () => { const b = jget('quiz_buzz_binds', []); return Array.isArray(b) ? b : []; };
    const readCfg = () => Object.assign({}, DEF_CFG, jget('quiz_buzz_cfg', {}));
    const saveCfg = c => localStorage.setItem('quiz_buzz_cfg', JSON.stringify(c));
    const saveBinds = b => localStorage.setItem('quiz_buzz_binds', JSON.stringify(b));

    function withLock(fn) {
        if (navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK, () => fn());
        return Promise.resolve().then(fn);
    }
    // read-modify-write of quiz_buzz under the lock. fn returns false to skip writing.
    async function mutateBuzz(fn) {
        return withLock(() => {
            const b = readBuzz();
            const before = JSON.stringify(b);
            if (fn(b) === false) return b;
            if (JSON.stringify(b) !== before) { b.seq = Date.now(); localStorage.setItem('quiz_buzz', JSON.stringify(b)); onBuzzChanged(JSON.parse(before), b); }
            return b;
        });
    }

    function stagePlayers() {
        return QuizCore.readState().players.filter(p => p.pool !== 'waiting');
    }
    function canPress(p, b, players, rules) {
        if (!p) return false;
        if (b.tried.includes(p.id) || b.queue.includes(p.id)) return false;
        if (p.winOrder > 0 || (p.freeze || 0) > 0) return false;
        if (rules.mpPending != null || QuizCore.isGameOver(players, rules)) return false;
        const total = players.reduce((s, x) => s + x.circles, 0);
        const st = QuizCore.getStatus(p, rules, total);
        return !st.isWinner && !st.isLoser;
    }
    function anyoneCanPress(b) {
        const { players, rules } = QuizCore.readState();
        const stage = players.filter(p => p.pool !== 'waiting');
        return stage.some(p => canPress(p, b, stage, rules));
    }

    // ---- 押された ----
    const nowMs = () => (performance.timeOrigin || Date.now() - performance.now()) + performance.now();
    function press(seat, at) {
        at = at || nowMs();
        mutateBuzz(b => {
            if (b.phase === 'idle') return false;
            const { players, rules } = QuizCore.readState();
            const stage = players.filter(p => p.pool !== 'waiting');
            const p = stage[seat];
            if (!canPress(p, b, stage, rules)) return false;
            b.queue.push(p.id);
            b.times = b.times || {}; b.times[p.id] = at;
            if (b.phase === 'open' && rules.ruleType === 'runrate') {
                // ランプレート：押した順に「解答権獲得判定」。当たればその人に解答権
                const v = (QuizCore.rollFor(rules) || {})[p.id];
                const rate = v ? v.rate : 100;
                const ok = Math.random() * 100 < rate;
                b.rr = b.rr || {}; b.rr[p.id] = ok;
                if (!ok) return;
            }
            if (b.phase === 'open') {
                const cfg = readCfg();
                b.phase = 'locked'; b.answering = p.id; b.timeUp = false;
                b.timerEnd = cfg.time > 0 ? Date.now() + cfg.time * 1000 : 0;
            }
        });
    }

    // ---- 入力（キーボード / ゲームパッド） ----
    let learnSeat = null, learnAll = false;
    const prevPad = {};
    function keyLabel(b) {
        if (!b) return '未割当';
        if (b.type === 'key') return 'キー ' + b.code.replace(/^Key|^Digit/, '').replace('Numpad', 'テンキー');
        return `パッド${b.pad + 1}-ボタン${b.btn + 1}`;
    }
    function assign(bind) {
        const binds = readBinds();
        for (let i = 0; i < MAX_SEATS; i++) {
            const x = binds[i];
            if (x && x.type === bind.type && (bind.type === 'key' ? x.code === bind.code : (x.pad === bind.pad && x.btn === bind.btn))) binds[i] = null;
        }
        binds[learnSeat] = bind; saveBinds(binds);
        const n = stagePlayers().length;
        if (learnAll && learnSeat + 1 < Math.min(n, MAX_SEATS)) learnSeat++;
        else { learnSeat = null; learnAll = false; }
        if (IS_SETUP) renderPanel();
    }
    function onInput(bind) {
        if (IS_SETUP && learnSeat != null) { assign(bind); return; }
        const binds = readBinds();
        for (let i = 0; i < binds.length; i++) {
            const x = binds[i];
            if (!x || x.type !== bind.type) continue;
            if (bind.type === 'key' ? x.code === bind.code : (x.pad === bind.pad && x.btn === bind.btn)) {
                const { rules } = QuizCore.readState();
                if (rules.mpPending != null) { const t = stagePlayers()[i]; if (t) pickTarget(t.id); return; }
                press(i); return;
            }
        }
    }
    function isTyping(e) {
        const t = e.target;
        return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    }
    document.addEventListener('keydown', e => {
        if (e.repeat || isTyping(e)) return;
        // Ctrl+Z（Mac: ⌘+Z）で1つ戻る
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ') {
            e.preventDefault();
            if (typeof window.execUndo === 'function') window.execUndo();
            else Promise.resolve(QuizCore.undo()).then(prev => { if (prev && typeof window.update === 'function') window.update(); });
            return;
        }
        if (IS_SETUP && learnSeat != null) {
            if (e.code === 'Escape') { learnSeat = null; learnAll = false; renderPanel(); e.preventDefault(); return; }
            if (OP_KEYS.includes(e.code)) return;
            e.preventDefault(); assign({ type: 'key', code: e.code }); return;
        }
        if (OP_KEYS.includes(e.code)) {
            e.preventDefault();
            if (e.code === 'Space') openOrReopen();
            else if (e.code === 'KeyQ') { holdStart('o'); judge('o'); }
            else if (e.code === 'KeyW') { holdStart('x'); judge('x'); }
            else if (e.code === 'Escape') resetBuzz();
            return;
        }
        const binds = readBinds();
        if (binds.some(x => x && x.type === 'key' && x.code === e.code)) e.preventDefault();
        onInput({ type: 'key', code: e.code });
    });
    // Q/Wを離したら正解音/不正解音を止める
    document.addEventListener('keyup', e => {
        if (e.code === 'KeyQ') holdStop('o');
        else if (e.code === 'KeyW') holdStop('x');
    });
    window.addEventListener('blur', () => { holdStop('o'); holdStop('x'); });
    // マウスの○×ボタンも押している間だけ鳴らす
    document.addEventListener('pointerdown', e => {
        const t = e.target.closest && e.target.closest('#buzzOk, #buzzNg');
        if (!t) return;
        const type = t.id === 'buzzOk' ? 'o' : 'x';
        holdStart(type);
        const end = () => { holdStop(type); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end); };
        document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
    }, true);
    function pollPads() {
        if (window.__REMOTE_VIEW) return;
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const gp of pads) {
            if (!gp) continue;
            const prev = prevPad[gp.index] || [];
            const now = gp.buttons.map(b => b.pressed || b.value > 0.5);
            now.forEach((v, bi) => { if (v && !prev[bi]) onInput({ type: 'pad', pad: gp.index, btn: bi }); });
            prevPad[gp.index] = now;
        }
    }
    setInterval(pollPads, 8);

    // ---- 効果音 ----
    let ac = null;
    function beep(freqs, dur, type = 'square', vol = 0.25) {
        try {
            ac = ac || new (window.AudioContext || window.webkitAudioContext)();
            if (ac.state === 'suspended') ac.resume();
            let t = ac.currentTime;
            freqs.forEach(f => {
                const o = ac.createOscillator(), g = ac.createGain();
                o.type = type; o.frequency.value = f;
                g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
                o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur); t += dur * 0.9;
            });
        } catch (e) { /* 音が出せない環境 */ }
    }
    // ---- mp3効果音（押下音・正解音・不正解音） ----
    const SND_FILES = { pon: 'buzz_pon.mp3', o: 'judge_ok.mp3', x: 'judge_ng.mp3' };
    function sndMuted() { return localStorage.getItem('quiz_se_muted') === 'true' || !readCfg().sound; }
    function playPon() {
        if (sndMuted()) return;
        try { const a = new Audio(SND_FILES.pon); a.play().catch(() => {}); } catch (e) { }
    }
    // 正解音: 押している間 OK_INTERVAL ms ごとに重ねて再生（間隔を短く）、離しても鳴っている1回は最後まで鳴らす（最低1回）
    // 不正解音: 押している間ループし、離したら止める
    const OK_INTERVAL = 420;
    const holdAudio = {}, holdTimer = {};
    function judgeMuted() { return sndMuted() || !!readCfg().judgeMute; }
    function holdStart(type) {
        if (judgeMuted()) return;
        holdStop(type);
        try {
            if (type === 'o') {
                const fire = () => { const a = new Audio(SND_FILES.o); a.play().catch(() => {}); };
                fire();
                holdTimer.o = setInterval(fire, OK_INTERVAL);
            } else {
                const a = new Audio(SND_FILES[type]);
                a.loop = true;
                holdAudio[type] = a;
                a.play().catch(() => {});
            }
        } catch (e) { }
    }
    function holdStop(type) {
        if (holdTimer[type]) { clearInterval(holdTimer[type]); holdTimer[type] = null; }
        const a = holdAudio[type];
        if (!a) return;
        holdAudio[type] = null;
        try { a.pause(); a.currentTime = 0; } catch (e) { }
    }
    function onBuzzChanged(oldB, newB) {
        if (IS_SETUP) {
            const cfg = readCfg();
            if (cfg.sound && newB.answering != null && newB.answering !== oldB.answering) playPon();
            if (cfg.sound && newB.timeUp && !oldB.timeUp) beep([440, 330], 0.35, 'triangle', 0.25);
            renderPanel();
        }
        if (IS_DISPLAY) decorate();
    }

    // =====================================================================
    // setup.html（操作画面）
    // =====================================================================
    async function openOrReopen() {
        await mutateBuzz(b => {
            if (b.phase === 'locked') return false;
            b.phase = 'open'; b.answering = null; b.timerEnd = 0; b.timeUp = false;
        });
    }
    async function resetBuzz() {
        // 押し直し：今の問題の受付をやり直す（誤答済みの人も含めて全員押せる）
        await mutateBuzz(b => { Object.assign(b, idleState()); b.phase = 'open'; });
    }
    async function stopBuzz() { await mutateBuzz(b => { Object.assign(b, idleState()); }); }

    async function commitState(fn) {
        if (IS_SETUP && typeof window.commit === 'function') return window.commit(fn);
        return QuizCore.mutate(fn);
    }
    function refreshPage() {
        if (IS_SETUP) { if (typeof window.load === 'function') window.load(); }
        else if (typeof window.update === 'function') window.update();
    }
    // メロンパン：攻撃先の決定
    function attackTargets() {
        const { players, rules } = QuizCore.readState();
        if (rules.mpPending == null) return [];
        const stage = players.filter(p => p.pool !== 'waiting');
        const total = stage.reduce((a, p) => a + p.circles, 0);
        return stage.filter(p => p.id !== rules.mpPending && !QuizCore.getStatus(p, rules, total).isLoser);
    }
    let picking = false;
    async function pickTarget(id) {
        if (picking) return;
        if (id != null && !attackTargets().some(p => p.id === id)) return;
        picking = true;
        try {
            await commitState((players, rules) => { if (rules.mpPending != null) QuizCore.applyAttack(players, rules, id); });
            refreshPage();
        } finally { picking = false; }
    }

    let judging = false;
    async function judge(type) {
        if (judging) return;
        judging = true;
        try { await judgeInner(type); } finally { judging = false; }
    }
    async function judgeInner(type) {
        const b = readBuzz();
        if (b.answering == null) return;
        const id = b.answering;
        const cfg = readCfg();
        const ruleType = QuizCore.readState().rules.ruleType;
        if (type === 'o' || cfg.afterNg === 'end' || ruleType === 'kobanzame' || ruleType === 'melonpan') {
            // 元アプリと同じ処理（chanceModeに従って問題が進む）
            // コバンザメ：2番目に押した人＝セカンド
            const secondId = b.queue.find(q => q !== id);
            await stopBuzz();
            await commitState((players, rules) => { QuizCore.applyAnswer(players, rules, id, type, { secondId: rules.ruleType === 'kobanzame' && b.queue[0] === id ? secondId : null }); });
            refreshPage();
            return;
        }
        // 誤答後も同じ問題を続ける：この1回だけ問題を進めずに×を記録
        await commitState((players, rules) => {
            const cm = rules.chanceMode; rules.chanceMode = 'endless';
            QuizCore.applyAnswer(players, rules, id, 'x');
            rules.chanceMode = cm;
        });
        refreshPage();
        await mutateBuzz(bz => {
            if (!bz.tried.includes(id)) bz.tried.push(id);
            bz.answering = null; bz.timerEnd = 0; bz.timeUp = false;
            if (cfg.afterNg === 'reopen') bz.queue = [];
            const { players, rules } = QuizCore.readState();
            const stage = players.filter(p => p.pool !== 'waiting');
            let next = null;
            if (cfg.afterNg === 'next') {
                for (const qid of bz.queue) {
                    if (bz.tried.includes(qid)) continue;
                    const p = stage.find(x => x.id === qid);
                    const tmp = { ...bz, queue: [], tried: [] };
                    if (p && canPress(p, tmp, stage, rules)) { next = qid; break; }
                }
            }
            if (next != null) {
                bz.phase = 'locked'; bz.answering = next;
                bz.timerEnd = cfg.time > 0 ? Date.now() + cfg.time * 1000 : 0;
            } else {
                bz.phase = 'open';
                if (!stage.some(p => canPress(p, bz, stage, rules))) bz.phase = 'idle';
            }
        });
    }

    let panelEl = null;
    function buildPanel() {
        const css = document.createElement('style');
        css.textContent = FONT_CSS + `
        .buzz-box{background:#fffbe6;border:2px solid #f0c419;border-radius:12px;padding:14px;margin-bottom:20px}
        .buzz-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
        .buzz-title{font-weight:bold;color:#8a6200;font-size:1.05rem}
        .buzz-status{font-size:1.6rem;font-weight:bold;flex:1;min-width:240px}
        .buzz-status.open{color:#1a9c5a}.buzz-status.locked{color:#d81b60}.buzz-status.idle{color:#6b7280}
        .buzz-order{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;min-height:26px}
        .buzz-chip{padding:3px 10px;border-radius:999px;background:#fff;border:2px solid #ccc;font-weight:bold}
        .buzz-chip.ans{background:#ffd600;border-color:#b8790a}.buzz-chip.tried{opacity:.45;text-decoration:line-through}
        .buzz-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
        .buzz-btns .btn{padding:10px 16px;font-size:1rem}
        .buzz-set{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:.9rem}
        .buzz-set input[type=number]{width:60px;padding:4px}
        .buzz-bind{display:none;margin-top:10px}
        .buzz-bind.show{display:block}
        .buzz-bind table{width:100%;border-collapse:collapse;font-size:.9rem;background:#fff}
        .buzz-bind td,.buzz-bind th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left}
        .buzz-bind tr.learn{background:#ffe08a}
        .buzz-pads{font-size:.8rem;color:#6b7280;margin-top:4px}`;
        document.head.appendChild(css);
        panelEl = document.createElement('div');
        panelEl.className = 'buzz-box';
        panelEl.innerHTML = `
          <div class="buzz-head">
            <span class="buzz-title">🔔 早押し</span>
            <span id="buzzStatus" class="buzz-status idle">待機中</span>
          </div>
          <div id="buzzOrder" class="buzz-order"></div>
          <div id="mpPick" style="display:none;margin-top:8px;padding:10px;border-radius:10px;background:#3a0d0d;color:#fff"></div>
          <div class="buzz-btns">
            <button class="btn" style="background:#1a9c5a" id="buzzOpen">▶ 受付開始 (Space)</button>
            <button class="btn" style="background:#1e8e4a" id="buzzOk">〇 正解 (Q)</button>
            <button class="btn" style="background:#c0392b" id="buzzNg">× 誤答 (W)</button>
            <button class="btn" style="background:#5b6472" id="buzzReset">↻ 押し直し (Esc)</button>
            <button class="btn" style="background:#454b58" id="buzzStop">■ 受付停止</button>
            <button class="btn" style="background:#0d4a75" id="buzzBindToggle">🎮 ボタン割当</button>
          </div>
          <div class="buzz-set">
            <label>解答時間 <input type="number" id="buzzTime" min="0" max="60"> 秒（0=無制限）</label>
            <label>誤答後
              <select id="buzzAfterNg">
                <option value="end">問題を進める（元アプリと同じ）</option>
                <option value="next">次に押した人へ</option>
                <option value="reopen">他の人で再受付</option>
              </select></label>
            <label><input type="checkbox" id="buzzAuto"> 問題が進んだら自動で受付開始</label>
            <label><input type="checkbox" id="buzzShowOrder"> 表示画面に押した順</label>
            <label><input type="checkbox" id="buzzSound"> 早押し音</label>
            <label><input type="checkbox" id="buzzJudgeMute"> 正解・不正解音をミュート</label>
          </div>
          <div class="buzz-bind" id="buzzBind">
            <div class="buzz-btns" style="margin-top:0">
              <button class="btn" style="background:#0d4a75" id="buzzLearnAll">全員まとめて割当（1番から順に押す）</button>
              <button class="btn" style="background:#1f7a91" id="buzzKbAll">キーボード自動割当（1〜0, A〜H）</button>
              <button class="btn" style="background:#c0392b" id="buzzClearAll">全解除</button>
            </div>
            <div class="buzz-pads" id="buzzPads"></div>
            <table><thead><tr><th>席</th><th>壇上のプレイヤー</th><th>ボタン</th><th></th></tr></thead><tbody id="buzzBindBody"></tbody></table>
            <div class="buzz-pads">席の番号＝壇上プールの並び順（表示画面の左から）。割当中は押したいボタン／キーを押すと登録、Escで中止。Space・Q・W・Escは操作用なので割当できません（表示画面でも使えます）。</div>
          </div>`;
        const anchor = document.querySelector('.announcement-box');
        anchor.parentNode.insertBefore(panelEl, anchor.nextSibling);

        const $ = id => document.getElementById(id);
        $('buzzOpen').onclick = () => { const b = readBuzz(); if (b.phase === 'locked') return; openOrReopen(); };
        $('buzzOk').onclick = () => judge('o');
        $('buzzNg').onclick = () => judge('x');
        $('buzzReset').onclick = resetBuzz;
        $('buzzStop').onclick = stopBuzz;
        $('buzzBindToggle').onclick = () => { $('buzzBind').classList.toggle('show'); };
        $('buzzLearnAll').onclick = () => { if (!stagePlayers().length) { alert('壇上プールにプレイヤーがいません。'); return; } learnSeat = 0; learnAll = true; renderPanel(); };
        $('buzzKbAll').onclick = () => { const binds = readBinds(); for (let i = 0; i < MAX_SEATS; i++) binds[i] = { type: 'key', code: KB_DEFAULT[i] }; saveBinds(binds); renderPanel(); };
        $('buzzClearAll').onclick = () => { if (confirm('ボタン割当を全て解除しますか？')) { saveBinds([]); renderPanel(); } };
        const cfg = readCfg();
        $('buzzTime').value = cfg.time; $('buzzAfterNg').value = cfg.afterNg; $('buzzAuto').checked = cfg.autoOpen;
        $('buzzShowOrder').checked = cfg.showOrder; $('buzzSound').checked = cfg.sound; $('buzzJudgeMute').checked = !!cfg.judgeMute;
        const saveFromUi = () => saveCfg({ time: Math.max(0, parseInt($('buzzTime').value) || 0), afterNg: $('buzzAfterNg').value,
            autoOpen: $('buzzAuto').checked, showOrder: $('buzzShowOrder').checked, sound: $('buzzSound').checked, judgeMute: $('buzzJudgeMute').checked });
        ['buzzTime', 'buzzAfterNg', 'buzzAuto', 'buzzShowOrder', 'buzzSound', 'buzzJudgeMute'].forEach(id => { $(id).onchange = saveFromUi; $(id).oninput = saveFromUi; });
        $('buzzBindBody').onclick = e => {
            const btn = e.target.closest('button'); if (!btn) return;
            const seat = +btn.dataset.seat;
            if (btn.dataset.a === 'learn') { learnSeat = (learnSeat === seat ? null : seat); learnAll = false; }
            else { const binds = readBinds(); binds[seat] = null; saveBinds(binds); }
            renderPanel();
        };
    }
    function diffLabel(b, id) {
        const t = b.times || {}; const first = t[b.queue[0]];
        if (t[id] == null || first == null) return '';
        if (id === b.queue[0]) return '1着';
        return '+' + ((t[id] - first) / 1000).toFixed(3) + '秒';
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    function renderPanel() {
        if (!panelEl) return;
        const b = readBuzz();
        const stage = stagePlayers();
        const byId = id => stage.find(p => p.id === id);
        const st = document.getElementById('buzzStatus');
        if (b.phase === 'locked' && byId(b.answering)) {
            const left = b.timerEnd ? Math.max(0, Math.ceil((b.timerEnd - Date.now()) / 1000)) : null;
            st.textContent = `解答権：${byId(b.answering).name}` + (b.timeUp ? '（時間切れ）' : left != null ? `（残り${left}秒）` : '');
            st.className = 'buzz-status locked';
        } else if (b.phase === 'open') { st.textContent = '受付中…'; st.className = 'buzz-status open'; }
        else { st.textContent = '待機中（Spaceで受付開始）'; st.className = 'buzz-status idle'; }
        const st0 = QuizCore.readState().rules;
        document.getElementById('buzzOrder').innerHTML = b.queue.map((id, i) => {
            const p = byId(id); if (!p) return '';
            const miss = b.rr && b.rr[id] === false;
            const cls = id === b.answering ? 'ans' : (b.tried.includes(id) || miss) ? 'tried' : '';
            const tag = st0.ruleType === 'kobanzame' ? (i === 0 ? ' [ファースト]' : i === 1 ? ' [セカンド]' : '') : (miss ? ' [獲得失敗]' : '');
            return `<span class="buzz-chip ${cls}" style="border-color:${p.color}">${i + 1}. ${esc(p.name)}${tag} <small>${diffLabel(b, id)}</small></span>`;
        }).join('');
        const mp = document.getElementById('mpPick');
        if (st0.mpPending != null) {
            const from = byId(st0.mpPending);
            mp.style.display = 'block';
            mp.innerHTML = `<b>⚔ ${esc(from ? from.name : '')} の攻撃先を選んでください</b>（その人のボタン／キーを押しても選べます）<div class="buzz-btns">` +
                attackTargets().map(t => `<button class="btn" data-mp="${t.id}" style="background:${t.color};color:#111;border:2px solid #fff">${esc(t.name)}</button>`).join('') +
                `<button class="btn" data-mp="none" style="background:#555">攻撃しない</button></div>`;
            mp.onclick = e => { const bt = e.target.closest('button[data-mp]'); if (bt) pickTarget(bt.dataset.mp === 'none' ? null : Number(bt.dataset.mp)); };
        } else mp.style.display = 'none';
        const binds = readBinds();
        const rows = [];
        for (let i = 0; i < Math.max(stage.length, 0) && i < MAX_SEATS; i++) {
            rows.push(`<tr class="${learnSeat === i ? 'learn' : ''}"><td>${i + 1}</td>
              <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${stage[i].color};margin-right:5px"></span>${esc(stage[i].name)}</td>
              <td>${learnSeat === i ? '▶ ボタンを押してください…' : keyLabel(binds[i])}</td>
              <td><button class="btn" style="background:#0d4a75;padding:3px 10px" data-a="learn" data-seat="${i}">${learnSeat === i ? '中止' : '割当'}</button>
                  <button class="btn" style="background:#888;padding:3px 10px" data-a="clear" data-seat="${i}">解除</button></td></tr>`);
        }
        if (stage.length > MAX_SEATS) rows.push(`<tr><td colspan="4" style="color:#c0392b">※早押しボタンは壇上の先頭${MAX_SEATS}人まで</td></tr>`);
        document.getElementById('buzzBindBody').innerHTML = rows.join('') || '<tr><td colspan="4" style="color:#6b7280">壇上プールにプレイヤーがいません</td></tr>';
        const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean);
        document.getElementById('buzzPads').textContent = pads.length
            ? '接続中のゲームパッド: ' + pads.map(g => `${g.index + 1}:${g.id.slice(0, 32)}`).join(' / ')
            : 'ゲームパッド未検出（接続後、どれかのボタンを1回押すと認識されます）';
    }

    // 問題番号の変化・時間切れの監視（両画面で動かす。処理は冪等）
    function startWatchers() {
        // 問題番号が変わったら（○・スルー・Undo・リセット等）解答権をリセット
        setInterval(() => {
            const q = QuizCore.readState().rules.questionNum;
            const cur = readBuzz();
            if (cur.q !== q) {
                const cfg = readCfg();
                mutateBuzz(b => {
                    if (b.q === q) return false;
                    const first = b.q === undefined;
                    if (!first) { Object.assign(b, idleState()); if (cfg.autoOpen) b.phase = 'open'; }
                    b.q = q;
                });
            }
            // ラッキーショット／ランプレート：問題ごとの乱数を用意
            const st = QuizCore.readState();
            if (['luckyshot', 'runrate'].includes(st.rules.ruleType)) {
                const vals = QuizCore.rollFor(st.rules);
                if (!vals || st.players.some(p => !vals[p.id])) QuizCore.mutate((pl, r) => { QuizCore.ensureRoll(pl, r); }, { recordHistory: false }).then(() => refreshPage());
            }
            // 時間切れ
            const b = readBuzz();
            if (b.phase === 'locked' && b.timerEnd && !b.timeUp && Date.now() >= b.timerEnd) mutateBuzz(x => { if (x.phase === 'locked' && x.timerEnd && Date.now() >= x.timerEnd) x.timeUp = true; else return false; });
            if (IS_SETUP && b.phase === 'locked' && b.timerEnd && !b.timeUp) renderPanel();
        }, 150);
    }

    function initSetup() {
        buildPanel(); renderPanel();
        // render() が呼ばれたら（壇上の入れ替え等）割当表も更新
        const origRender = window.render;
        if (typeof origRender === 'function') window.render = function () { const r = origRender.apply(this, arguments); renderPanel(); return r; };
        startWatchers();
        setInterval(() => { if (document.getElementById('buzzBind').classList.contains('show')) renderPanel(); }, 2000);
        window.addEventListener('storage', e => {
            if (e.key === 'quiz_buzz') { let o = idleState(); try { if (e.oldValue) o = Object.assign(idleState(), JSON.parse(e.oldValue)); } catch (err) {} onBuzzChanged(o, readBuzz()); }
            if (e.key === 'quiz_players') renderPanel();
        });
        // 他の操作で問題が進んだ時、全員誤答で押せる人がいなくなった時などのため
        setInterval(() => { const b = readBuzz(); if (b.phase === 'open' && !anyoneCanPress(b)) mutateBuzz(x => { if (x.phase === 'open' && !anyoneCanPress(x)) Object.assign(x, idleState()); else return false; }); }, 1000);
    }

    // =====================================================================
    // display.html（表示画面）
    // =====================================================================
    function initDisplay() {
        const css = document.createElement('style');
        css.textContent = FONT_CSS + `
        .player-column.buzz-answering .name-card{border:4px solid #ffd600;transform:translateY(-1.5vh) scale(1.04);animation:buzz-glow .5s ease-in-out infinite alternate;z-index:5}
        @keyframes buzz-glow{from{box-shadow:0 0 18px 4px rgba(255,214,0,.6)}to{box-shadow:0 0 50px 18px rgba(255,214,0,1)}}
        .player-column.buzz-answering .name-area{color:#ffd600}
        .player-column.buzz-tried .name-card{opacity:.45}
        .player-column{position:relative}
        .buzz-order-badge{position:absolute;top:-1.6vw;left:50%;transform:translateX(-50%);width:3vw;height:3vw;border-radius:50%;background:#ffd600;color:#111;font-family:'Agency FB','Rajdhani',sans-serif;font-weight:900;font-size:1.9vw;display:flex;align-items:center;justify-content:center;z-index:60;box-shadow:0 0 10px rgba(255,214,0,.8)}
        .buzz-count{position:absolute;bottom:14%;left:0;width:100%;text-align:center;font-family:'Agency FB','Rajdhani',sans-serif;font-weight:700;font-size:3vw;color:#ffd600;text-shadow:0 0 10px #000,0 0 4px #000;z-index:35}
        .buzz-count.up{color:#ff5252}
        .buzz-open-pill{color:#2fae8b}
        .buzz-diff{position:absolute;top:1.7vw;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(0,0,0,.8);border:1px solid #ffd600;color:#ffd600;border-radius:6px;padding:0 .5vw;font-family:'Agency FB','Rajdhani',sans-serif;font-weight:700;font-size:1.4vw;z-index:61}
        .buzz-diff.first{background:#ffd600;color:#111}
        .buzz-diff.rr-miss{top:-4.4vw;background:#555;border-color:#999;color:#eee}
        .player-column.mp-target{cursor:crosshair}
        .player-column.mp-target .name-card{outline:3px dashed #ff5252;outline-offset:4px}
        .mp-banner{position:fixed;left:0;right:0;top:110px;text-align:center;z-index:200;pointer-events:none}
        .mp-banner span{display:inline-block;background:rgba(120,0,0,.92);color:#fff;font-size:2.4vw;padding:.4vw 2vw;border-radius:8px;border:2px solid #ff5252;font-family:'HGS創英角ｺﾞｼｯｸUB','HG創英角ｺﾞｼｯｸUB','Yu Gothic','Meiryo',sans-serif !important;font-weight:900}
        .mp-slash{position:absolute;inset:-10%;z-index:80;pointer-events:none;overflow:visible}
        .mp-slash i{position:absolute;left:-20%;top:50%;width:140%;height:.6vw;background:linear-gradient(90deg,transparent,#fff 30%,#bfe9ff 50%,#fff 70%,transparent);box-shadow:0 0 1.2vw .4vw rgba(160,220,255,.9);transform-origin:center;opacity:0}
        .mp-slash i:nth-child(1){transform:rotate(-55deg) scaleX(0);animation:mp-cut .28s .05s ease-out forwards}
        .mp-slash i:nth-child(2){transform:rotate(55deg) scaleX(0);animation:mp-cut2 .28s .32s ease-out forwards}
        @keyframes mp-cut{0%{opacity:1;transform:rotate(-55deg) scaleX(0)}60%{opacity:1;transform:rotate(-55deg) scaleX(1)}100%{opacity:0;transform:rotate(-55deg) scaleX(1.05)}}
        @keyframes mp-cut2{0%{opacity:1;transform:rotate(55deg) scaleX(0)}60%{opacity:1;transform:rotate(55deg) scaleX(1)}100%{opacity:0;transform:rotate(55deg) scaleX(1.05)}}
        .mp-flash{position:absolute;inset:0;background:#fff;opacity:0;z-index:79;animation:mp-flash .5s .1s ease-out;pointer-events:none}
        @keyframes mp-flash{0%{opacity:0}20%{opacity:.85}100%{opacity:0}}
        .mp-hit .name-card{animation:mp-shake .5s .1s}
        @keyframes mp-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-1vw) rotate(-2deg)}40%{transform:translateX(.9vw) rotate(2deg)}60%{transform:translateX(-.6vw)}80%{transform:translateX(.4vw)}}
        .mp-dmg{position:absolute;top:30%;left:0;right:0;text-align:center;font-family:'Agency FB',sans-serif;font-weight:900;font-size:5vw;color:#ff3b3b;text-shadow:0 0 .6vw #000,0 0 .2vw #000;z-index:81;pointer-events:none;animation:mp-dmg 1.4s .3s ease-out forwards;opacity:0}
        @keyframes mp-dmg{0%{opacity:0;transform:translateY(1vh) scale(.6)}20%{opacity:1;transform:translateY(0) scale(1.2)}70%{opacity:1}100%{opacity:0;transform:translateY(-4vh) scale(1)}}`;
        document.head.appendChild(css);
        const origUpdate = window.update;
        if (typeof origUpdate === 'function') window.update = function () { const r = origUpdate.apply(this, arguments); decorate(); return r; };
        window.addEventListener('storage', () => decorate());
        lastSlash = (QuizCore.readState().rules.mpLast || {}).seq || 0;
        document.getElementById('main-screen').addEventListener('click', e => {
            const col = e.target.closest('.player-column.mp-target');
            if (col && !e.target.closest('button')) pickTarget(Number(col.dataset.pid));
        });
        decorate();
        startWatchers();
        (function tick() {
            const b = readBuzz();
            const el = document.querySelector('.buzz-count');
            if (el) {
                if (b.timeUp) { el.textContent = 'TIME UP'; el.classList.add('up'); }
                else if (b.timerEnd) { el.textContent = Math.max(0, Math.ceil((b.timerEnd - Date.now()) / 1000)); el.classList.remove('up'); }
                else el.textContent = '';
            }
            requestAnimationFrame(tick);
        })();
    }
    let lastSlash = 0;
    function slashSound() {
        try {
            ac = ac || new (window.AudioContext || window.webkitAudioContext)();
            if (ac.state === 'suspended') ac.resume();
            [0, 0.27].forEach(off => {
                const len = 0.22, buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate), d = buf.getChannelData(0);
                for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
                const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
                src.buffer = buf; f.type = 'bandpass'; f.frequency.setValueAtTime(5000, ac.currentTime + off); f.frequency.exponentialRampToValueAtTime(1200, ac.currentTime + off + len);
                g.gain.value = 0.5; src.connect(f); f.connect(g); g.connect(ac.destination); src.start(ac.currentTime + off);
            });
        } catch (e) {}
    }
    function decorate() {
        if (!IS_DISPLAY) return;
        const b = readBuzz(), cfg = readCfg();
        const st = QuizCore.readState().rules;
        // メロンパン：攻撃先の指名待ち
        const targets = st.mpPending != null ? attackTargets().map(p => p.id) : [];
        let banner = document.querySelector('.mp-banner');
        if (st.mpPending != null) {
            if (!banner) { banner = document.createElement('div'); banner.className = 'mp-banner'; document.body.appendChild(banner); }
            const from = QuizCore.readState().players.find(p => p.id === st.mpPending);
            banner.innerHTML = `<span>⚔ ${esc(from ? from.name : '')} が攻撃するプレイヤーを指名</span>`;
        } else if (banner) banner.remove();
        // 剣で切る演出
        const ml = st.mpLast;
        if (ml && ml.seq > lastSlash) {
            lastSlash = ml.seq;
            const col = document.querySelector(`#main-screen .player-column[data-pid="${ml.to}"]`);
            if (col) {
                const card = col.querySelector('.name-card') || col;
                const r = card.getBoundingClientRect();
                // 画面の再描画で消えないよう、カードの上に固定配置で重ねる
                const fx = document.createElement('div');
                fx.className = 'mp-fx';
                fx.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:150;pointer-events:none;overflow:visible`;
                fx.innerHTML = `<div class="mp-flash"></div><div class="mp-slash"><i></i><i></i></div><div class="mp-dmg">-${ml.dmg}</div>`;
                document.body.appendChild(fx);
                col.classList.add('mp-hit');
                slashSound();
                setTimeout(() => { fx.remove(); document.querySelectorAll('.mp-hit').forEach(x => x.classList.remove('mp-hit')); }, 2000);
            }
        }
        document.querySelectorAll('#main-screen .player-column').forEach(col => {
            const id = Number(col.dataset.pid);
            col.classList.toggle('mp-target', !!targets.includes(id));
            col.classList.toggle('buzz-answering', b.phase === 'locked' && b.answering === id);
            col.classList.toggle('buzz-tried', !!((b.tried.includes(id) || (b.rr && b.rr[id] === false)) && b.answering !== id));
            col.querySelectorAll('.buzz-order-badge,.buzz-count,.buzz-diff').forEach(x => x.remove());
            const ord = b.queue.indexOf(id);
            if (cfg.showOrder && ord >= 0) {
                col.insertAdjacentHTML('afterbegin', `<div class="buzz-order-badge">${ord + 1}</div>`);
                const d = diffLabel(b, id);
                if (d) col.insertAdjacentHTML('afterbegin', `<div class="buzz-diff ${ord === 0 ? 'first' : ''}">${d === '1着' ? '1st' : d.replace('秒', 's')}</div>`);
                if (b.rr && b.rr[id] === false) col.insertAdjacentHTML('afterbegin', `<div class="buzz-diff rr-miss">MISS</div>`);
            }
            if (b.phase === 'locked' && b.answering === id) {
                const card = col.querySelector('.name-card');
                if (card) card.insertAdjacentHTML('beforeend', '<div class="buzz-count"></div>');
            }
        });
    }

    if (IS_SETUP) initSetup();
    if (IS_DISPLAY) initDisplay();
    return { press, judge, readBuzz };
})();
