/*
 * team-core.js — チーム戦（EQIDEN / AQL）の共通ロジック
 * team-setup.html（操作画面）と team-display.html（表示画面）で共有。
 * 元の「EQIDEN/AQL Manager」と同じルール・同じ保存キー(eq_*)を使う。
 * 早押しボタンの割当(quiz_buzz_binds)と設定(quiz_buzz_cfg)は個人戦と共通。
 */
const Team = (() => {
    const REQ_WINS = [0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2];
    const DEF_GS = { questionNum: 1, qText: '', aText: '', textVisible: false, ruleMode: 'AQL', targetScore: 200,
        theme: 'board', title1: '', title2: '', title3: '' };
    const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };

    function load() {
        const gs = Object.assign({}, DEF_GS, jget('eq_gamestate', {}));
        return { players: jget('eq_players', []), teams: jget('eq_teams', []), gameState: gs };
    }
    function save(s) {
        localStorage.setItem('eq_players', JSON.stringify(s.players));
        localStorage.setItem('eq_teams', JSON.stringify(s.teams));
        localStorage.setItem('eq_gamestate', JSON.stringify(s.gameState));
    }
    function pushUndo(s) {
        const st = jget('eq_undo', []);
        st.push(JSON.stringify(s)); while (st.length > 20) st.shift();
        localStorage.setItem('eq_undo', JSON.stringify(st));
    }
    function undo() {
        const st = jget('eq_undo', []);
        if (!st.length) return false;
        const s = JSON.parse(st.pop());
        localStorage.setItem('eq_undo', JSON.stringify(st));
        save(s); return true;
    }
    // 状態を変更する処理は全てここを通す（Undo保存付き）
    function mutate(fn, { undo: rec = true } = {}) {
        const s = load();
        if (rec) pushUndo(s);
        const r = fn(s);
        if (r === false) { if (rec) { const st = jget('eq_undo', []); st.pop(); localStorage.setItem('eq_undo', JSON.stringify(st)); } return s; }
        save(s); return s;
    }

    const aqlTotal = t => t.aql.points.reduce((a, b) => a * b, 1);
    function currentQA(gs) {
        const list = jget('quiz_csv_list', []);
        const idx = gs.questionNum - 2;
        if (gs.questionNum <= 1 || !list.length) return { q: '', a: '' };
        if (idx >= 0 && idx < list.length) return { q: list[idx].q, a: list[idx].a };
        return { q: '(問題切れ)', a: '' };
    }
    function advance(gs) {
        gs.questionNum++; gs.textVisible = true;
        const qa = currentQA(gs); gs.qText = qa.q; gs.aText = qa.a;
    }

    // ---- 元アプリと同じルール ----
    function eqiden(s, teamId, type) {
        const { teams, gameState } = s;
        const t = teams.find(x => x.id === teamId);
        if (!t || t.isDisqualified || t.isFinished || t.suspendCount > 0) return false;
        advance(gameState);
        if (type === 'correct') {
            t.currentWins++;
            if (t.currentWins >= (REQ_WINS[t.currentSection] || 2)) {
                t.currentWins = 0; t.currentSection++;
                if (t.currentSection > 10) { t.isFinished = true; t.rank = teams.filter(x => x.isFinished).length; }
            }
        } else {
            if (t.currentSection <= 5) { t.totalWrong++; if (t.totalWrong >= 4) t.isDisqualified = true; }
            else t.suspendCount = teams.filter(x => !x.isDisqualified && !x.isFinished).length;
        }
        teams.forEach(x => { if (x.suspendCount > 0 && x.id !== teamId) x.suspendCount--; });
    }
    function aql(s, teamId, idx, type) {
        const { teams, gameState } = s;
        const t = teams.find(x => x.id === teamId);
        if (!t || t.isFinished || t.aql.locked[idx]) return false;
        advance(gameState);
        if (type === 'correct') {
            t.aql.points[idx]++;
            if (aqlTotal(t) >= gameState.targetScore) { t.isFinished = true; t.rank = teams.filter(x => x.isFinished).length; }
        } else {
            t.aql.points[idx] = 1;
            t.aql.wrongs[idx]++;
            if (t.aql.wrongs[idx] >= 2) t.aql.locked[idx] = true;
            teams.forEach(opp => {
                if (opp.id !== teamId) for (let i = 0; i < 5; i++) if (opp.aql.locked[i]) { opp.aql.locked[i] = false; opp.aql.wrongs[i] = 1; }
            });
        }
    }
    function nextQuestion(s) {
        advance(s.gameState);
        if (s.gameState.ruleMode === 'EQIDEN') s.teams.forEach(t => { if (t.suspendCount > 0) t.suspendCount--; });
    }
    function resetScoresIn(s) {
        s.gameState.questionNum = 1; s.gameState.textVisible = false; s.gameState.qText = ''; s.gameState.aText = '';
        s.teams.forEach(t => {
            t.currentSection = 1; t.currentWins = 0; t.totalWrong = 0; t.suspendCount = 0;
            t.aql = { points: [1, 1, 1, 1, 1], wrongs: [0, 0, 0, 0, 0], locked: [false, false, false, false, false] };
            t.isDisqualified = false; t.isFinished = false; t.rank = 0;
        });
    }
    function recheckTarget(s) {
        s.teams.forEach(t => {
            if (s.gameState.ruleMode !== 'AQL' || t.isDisqualified) return;
            if (aqlTotal(t) >= s.gameState.targetScore) { if (!t.isFinished) { t.isFinished = true; t.rank = s.teams.filter(x => x.isFinished).length; } }
            else if (t.isFinished) { t.isFinished = false; t.rank = 0; }
        });
    }

    // =====================================================================
    // 早押し（席 → チーム/ポジション）
    //   AQL   : 席1〜5 = 1チーム目の No.1〜5、席6〜10 = 2チーム目 …
    //   EQIDEN: 席1 = 1チーム目、席2 = 2チーム目 …（今走っている区間の選手）
    // =====================================================================
    const idle = () => ({ phase: 'idle', queue: [], answering: null, times: {}, timerEnd: 0, timeUp: false, q: load().gameState.questionNum });
    const readBuzz = () => Object.assign(idle(), jget('eq_buzz', {}));
    const writeBuzz = b => localStorage.setItem('eq_buzz', JSON.stringify(b));
    const readBinds = () => { const b = jget('quiz_buzz_binds', []); return Array.isArray(b) ? b : []; };
    const readCfg = () => Object.assign({ time: 5, autoOpen: false, showOrder: true, sound: true }, jget('quiz_buzz_cfg', {}));
    const seatKey = (teamId, pos) => teamId + ':' + pos;

    function seatToKey(seat, s) {
        s = s || load();
        if (s.gameState.ruleMode === 'AQL') {
            const t = s.teams[Math.floor(seat / 5)];
            return t ? seatKey(t.id, seat % 5) : null;
        }
        const t = s.teams[seat];
        return t ? seatKey(t.id, -1) : null;
    }
    function canPress(key, s) {
        const [tid, posS] = key.split(':'); const pos = +posS;
        const t = s.teams.find(x => x.id === tid);
        if (!t || t.isFinished || t.isDisqualified) return false;
        if (s.gameState.ruleMode === 'AQL') return !t.aql.locked[pos];
        return !(t.suspendCount > 0);
    }
    function withLock(fn) {
        if (navigator.locks && navigator.locks.request) return navigator.locks.request('eq-buzz-lock', () => fn());
        return Promise.resolve().then(fn);
    }
    const nowMs = () => (performance.timeOrigin || (Date.now() - performance.now())) + performance.now();
    function press(seat) {
        const at = nowMs();
        return withLock(() => {
            const s = load(); const b = readBuzz();
            if (b.phase === 'idle') return;
            const key = seatToKey(seat, s);
            if (!key || b.queue.includes(key) || !canPress(key, s)) return;
            b.queue.push(key); b.times[key] = at;
            if (b.phase === 'open') {
                const cfg = readCfg();
                b.phase = 'locked'; b.answering = key; b.timeUp = false;
                b.timerEnd = cfg.time > 0 ? Date.now() + cfg.time * 1000 : 0;
            }
            writeBuzz(b);
        });
    }
    function openBuzz() { return withLock(() => { const b = readBuzz(); if (b.phase === 'locked') return; Object.assign(b, idle()); b.phase = 'open'; writeBuzz(b); }); }
    function resetBuzz() { return withLock(() => { const b = idle(); b.phase = 'open'; writeBuzz(b); }); }
    function stopBuzz() { return withLock(() => writeBuzz(idle())); }
    function judge(type) {
        const b = readBuzz();
        if (!b.answering) return false;
        const [tid, posS] = b.answering.split(':'); const pos = +posS;
        writeBuzz(idle());
        mutate(s => s.gameState.ruleMode === 'AQL' ? aql(s, tid, pos, type) : eqiden(s, tid, type));
        return true;
    }
    function diffLabel(b, key) {
        const first = b.times[b.queue[0]];
        if (b.times[key] == null || first == null) return '';
        if (key === b.queue[0]) return '1st';
        return '+' + ((b.times[key] - first) / 1000).toFixed(3) + 's';
    }
    // 問題番号の変化で解答権リセット・時間切れ判定（両画面で動作、冪等）
    function startWatchers() {
        setInterval(() => {
            const q = load().gameState.questionNum;
            const b = readBuzz();
            if (b.q !== q) withLock(() => { const x = readBuzz(); if (x.q === q) return; const n = idle(); if (readCfg().autoOpen) n.phase = 'open'; writeBuzz(n); });
            else if (b.phase === 'locked' && b.timerEnd && !b.timeUp && Date.now() >= b.timerEnd) withLock(() => { const x = readBuzz(); if (x.phase === 'locked' && !x.timeUp) { x.timeUp = true; writeBuzz(x); } });
        }, 150);
    }

    // ---- 入力（キーボード / ゲームパッド） ----
    const OP_KEYS = ['Space', 'KeyQ', 'KeyW', 'Escape'];
    let onAfterJudge = () => {};
    function matchSeat(bind) {
        const binds = readBinds();
        for (let i = 0; i < binds.length; i++) {
            const x = binds[i];
            if (x && x.type === bind.type && (bind.type === 'key' ? x.code === bind.code : (x.pad === bind.pad && x.btn === bind.btn))) return i;
        }
        return -1;
    }
    // ---- mp3効果音（押下音・正解音/不正解音は押している間ループ） ----
    const SND_FILES = { pon: 'buzz_pon.mp3', o: 'judge_ok.mp3', x: 'judge_ng.mp3' };
    const sndMuted = () => localStorage.getItem('quiz_se_muted') === 'true' || readCfg().sound === false;
    function playPon() { if (sndMuted()) return; try { new Audio(SND_FILES.pon).play().catch(() => {}); } catch (e) {} }
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
    function startInput(afterJudge) {
        onAfterJudge = afterJudge || onAfterJudge;
        document.addEventListener('keydown', e => {
            const t = e.target;
            if (e.repeat || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'))) return;
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); undo(); onAfterJudge(); return; }
            if (OP_KEYS.includes(e.code)) {
                e.preventDefault();
                if (e.code === 'Space') openBuzz();
                else if (e.code === 'KeyQ') { holdStart('o'); if (judge('correct')) onAfterJudge(); }
                else if (e.code === 'KeyW') { holdStart('x'); if (judge('wrong')) onAfterJudge(); }
                else if (e.code === 'Escape') resetBuzz();
                return;
            }
            const seat = matchSeat({ type: 'key', code: e.code });
            if (seat >= 0) { e.preventDefault(); press(seat); }
        });
        document.addEventListener('keyup', e => { if (e.code === 'KeyQ') holdStop('o'); else if (e.code === 'KeyW') holdStop('x'); });
        window.addEventListener('blur', () => { holdStop('o'); holdStop('x'); });
        document.addEventListener('pointerdown', e => {
            const t = e.target.closest && e.target.closest('.bo, .bx'); if (!t) return;
            const type = t.classList.contains('bo') ? 'o' : 'x'; holdStart(type);
            const end = () => { holdStop(type); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end); };
            document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
        }, true);
        const prev = {};
        setInterval(() => {
            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            for (const gp of pads) {
                if (!gp) continue;
                const p = prev[gp.index] || [];
                const now = gp.buttons.map(b => b.pressed || b.value > 0.5);
                now.forEach((v, bi) => { if (v && !p[bi]) { const seat = matchSeat({ type: 'pad', pad: gp.index, btn: bi }); if (seat >= 0) press(seat); } });
                prev[gp.index] = now;
            }
        }, 8);
    }

    return { REQ_WINS, load, save, mutate, undo, aqlTotal, eqiden, aql, nextQuestion, resetScoresIn, recheckTarget, currentQA,
        readBuzz, readCfg, readBinds, seatKey, seatToKey, openBuzz, resetBuzz, stopBuzz, judge, press, diffLabel, startWatchers, startInput, jget, playPon, holdStart, holdStop };
})();
