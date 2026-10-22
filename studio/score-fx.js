/*
 * score-fx.js — 表示画面(display.html)の得点演出
 *  ・得点変化時のカウントアップ（表示値が目標値へ素早く追従）
 *  ・数字のパンチ（約1.5倍→戻る、0.3秒）
 *  ・パネルの色フラッシュ（正解=緑 / 誤答=赤、0.4秒でフェード）
 *  ・誤答時のパネルシェイク（0.4秒、減衰）
 *  ・「+1」「-1」ポップアップ（上に浮かびながらフェード、0.8秒）
 *  ・解答権を持つプレイヤーのパネルを青系でハイライト（buzzer.js の buzz-answering を上書き）
 * update() は毎回 innerHTML で作り直すので、演出は毎フレーム最新のDOMに当て直す。
 * 得点の変化は #main-screen の再描画を MutationObserver で捉え、
 * QuizCore.readState() の前回値と比べて検出する（○×・特殊ルールの加減点・Undo すべて対象）。
 */
(function () {
    'use strict';
    if (typeof QuizCore === 'undefined') return;
    const screen = document.getElementById('main-screen');
    if (!screen) return;

    const css = document.createElement('style');
    css.textContent = `
    .player-column.buzz-answering .name-card{border:4px solid #2f8cff !important;transform:translateY(-1.5vh) scale(1.04);animation:sfx-buzz-glow .5s ease-in-out infinite alternate !important;z-index:5}
    @keyframes sfx-buzz-glow{from{box-shadow:0 0 18px 4px rgba(47,140,255,.6),inset 0 0 30px rgba(47,140,255,.25)}to{box-shadow:0 0 50px 18px rgba(47,140,255,1),inset 0 0 60px rgba(47,140,255,.45)}}
    .player-column.buzz-answering .name-area{color:#fff !important;text-shadow:0 0 8px #2f8cff,0 0 18px #2f8cff,1px 1px 2px #000 !important}
    .player-column.buzz-answering .rank-ribbon{box-shadow:0 0 18px 6px rgba(47,140,255,.9)}
    .sfx-flash{position:absolute;inset:0;z-index:22;pointer-events:none;opacity:0}
    .stat-number{display:inline-block;transform-origin:50% 60%;will-change:transform}
    .sfx-pop{position:fixed;z-index:170;pointer-events:none;transform:translate(-50%,-50%);font-family:'Agency FB','Rajdhani',sans-serif;font-weight:900;font-size:4.2vw;line-height:1;white-space:nowrap;text-shadow:0 0 .5vw #000,0 0 .2vw #000}
    .sfx-pop.up{color:#3dff8a}.sfx-pop.down{color:#ff4040}.sfx-pop.x{color:#ff4040}`;
    document.head.appendChild(css);

    const FLASH_MS = 400, SHAKE_MS = 400, PUNCH_MS = 300, POP_MS = 800;
    const fx = {};        // pid -> { shown, target, targetStr, punchT, flashT, flashColor, shakeT }
    let prev = null;      // pid -> { num, score, circles, crosses }

    function snapshot() {
        const { players, rules } = QuizCore.readState();
        const stage = players.filter(p => p.pool !== 'waiting');
        const total = stage.reduce((s, p) => s + p.circles, 0);
        const out = { __rule: rules.ruleType + '|' + rules.winLimit + '|' + rules.loseLimit };
        stage.forEach(p => {
            let score = 0;
            try { score = QuizCore.getStatus(p, rules, total).score; } catch (e) {}
            out[p.id] = { score: Number(score) || 0, circles: p.circles || 0, crosses: p.crosses || 0 };
        });
        return out;
    }
    const colOf = id => screen.querySelector(`.player-column[data-pid="${id}"]`);
    const numEl = col => col && col.querySelector('.stat-number:not(.stat-rank)');
    function numText(el) { const t = el && el.firstChild; return t && t.nodeType === 3 ? t : null; }
    function decimals(s) { const m = String(s).match(/\.(\d+)/); return m ? m[1].length : 0; }

    function popup(id, text, cls) {
        const col = colOf(id); if (!col) return;
        const anchor = numEl(col) || col.querySelector('.stat-block') || col;
        const r = anchor.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'sfx-pop ' + cls; el.textContent = text;
        el.style.left = (r.left + r.width / 2) + 'px'; el.style.top = (r.top) + 'px';
        document.body.appendChild(el);
        const t0 = performance.now();
        (function step(now) {
            const k = Math.min(1, (now - t0) / POP_MS);
            const ease = 1 - Math.pow(1 - k, 2);
            el.style.transform = `translate(-50%,calc(-50% - ${ease * 8}vh)) scale(${k < 0.15 ? 0.7 + k * 3 : 1.15 - k * 0.15})`;
            el.style.opacity = String(k < 0.5 ? 1 : 1 - (k - 0.5) / 0.5);
            if (k < 1) requestAnimationFrame(step); else el.remove();
        })(t0);
    }

    function onRender() {
        const cur = snapshot();
        if (!prev || prev.__rule !== cur.__rule) { prev = cur; return; } // ルール変更時は演出なし
        const now = performance.now();
        Object.keys(cur).forEach(id => {
            if (id === '__rule') return;
            const a = prev[id], b = cur[id];
            if (!a) return;
            const dScore = +(b.score - a.score).toFixed(4), dC = b.circles - a.circles, dX = b.crosses - a.crosses;
            if (!dScore && !dC && !dX) return;
            const col = colOf(id), el = numEl(col), tn = numText(el);
            const f = fx[id] || (fx[id] = {});
            // 新しい目標値（表示中の数字）
            if (tn) {
                const tStr = tn.nodeValue.trim(), tVal = parseFloat(tStr);
                if (!isNaN(tVal)) {
                    if (f.shown == null || isNaN(f.shown)) {
                        // 前回表示値：得点表示ルールなら score、○数表示なら circles
                        const was = tVal - (Math.abs(tVal - b.score) < 1e-6 ? b.score - a.score : b.circles - a.circles);
                        f.shown = was;
                    }
                    f.target = tVal; f.targetStr = tStr;
                }
            }
            f.punchT = now;
            const reset = dC < 0 && dX < 0;              // 全体リセット等
            const undo = !reset && (dC < 0 || dX < 0);    // 取り消し
            const wrong = !reset && !undo && (dX > 0 || (dScore < 0 && dC <= 0));
            const right = !reset && !undo && !wrong && (dC > 0 || dScore > 0);
            if (wrong) { f.flashT = now; f.flashColor = '255,40,40'; f.shakeT = now; }
            else if (right) { f.flashT = now; f.flashColor = '40,230,110'; }
            if (!reset && !undo) {
                const d = dScore || (dC ? dC : 0);
                if (d) popup(id, (d > 0 ? '+' : '') + (Number.isInteger(d) ? d : d.toFixed(2)), d > 0 ? 'up' : 'down');
                else if (dX > 0) popup(id, '×', 'x');
            }
        });
        prev = cur;
    }

    let pending = false;
    new MutationObserver(() => {
        if (pending) return; pending = true;
        queueMicrotask(() => { pending = false; onRender(); });
    }).observe(screen, { childList: true });

    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000); last = now;
        Object.keys(fx).forEach(id => {
            const f = fx[id], col = colOf(id);
            if (!col) return;
            // カウントアップ
            const el = numEl(col), tn = numText(el);
            if (tn && f.target != null) {
                if (Math.abs(f.target - f.shown) < 0.02) { f.shown = f.target; tn.nodeValue = f.targetStr; f.target = null; }
                else {
                    f.shown += (f.target - f.shown) * Math.min(1, dt * 14);
                    const dec = decimals(f.targetStr);
                    tn.nodeValue = dec ? f.shown.toFixed(dec) : String(Math.round(f.shown));
                }
            }
            // パンチ
            if (el) {
                const k = f.punchT != null ? (now - f.punchT) / PUNCH_MS : 1;
                if (k < 1) { const s = 1 + 0.5 * Math.sin(Math.PI * k); el.style.transform = `scale(${s.toFixed(3)})`; }
                else if (el.style.transform) el.style.transform = '';
            }
            // フラッシュ
            const card = col.querySelector('.name-card');
            if (card) {
                const k = f.flashT != null ? (now - f.flashT) / FLASH_MS : 1;
                let fl = card.querySelector('.sfx-flash');
                if (k < 1) {
                    if (!fl) { fl = document.createElement('div'); fl.className = 'sfx-flash'; card.appendChild(fl); }
                    fl.style.background = `rgba(${f.flashColor},1)`;
                    fl.style.opacity = String(0.75 * (1 - k));
                } else if (fl) fl.remove();
            }
            // シェイク（列ごと揺らす。カードの transform は解答権ハイライトが使うため）
            const ks = f.shakeT != null ? (now - f.shakeT) / SHAKE_MS : 1;
            if (ks < 1) { const amp = 1.1 * (1 - ks); col.style.transform = `translateX(${(Math.sin(ks * Math.PI * 9) * amp).toFixed(3)}vw)`; }
            else if (col.style.transform) col.style.transform = '';
            if (f.target == null && (f.punchT == null || now - f.punchT > PUNCH_MS) && (f.flashT == null || now - f.flashT > FLASH_MS) && ks >= 1) {
                if (el) el.style.transform = '';
                delete fx[id];
            }
        });
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // 初期値を記録
    try { prev = snapshot(); } catch (e) {}
})();
