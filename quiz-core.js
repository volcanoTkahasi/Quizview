/*
 * quiz-core.js
 * -----------------------------------------------------------------------
 * Shared state engine for the 2-screen quiz system (setup.html / display.html).
 *
 * WHY THIS FILE EXISTS
 * Previously, setup.html and display.html each kept their own copy of the
 * "push history" / "undo" / "apply answer" logic and both wrote directly to
 * localStorage. Because the two pages run in separate OS-level processes
 * (separate tabs/windows), their JavaScript can execute at the same real-world
 * instant. That made it possible for one page to read the score data, then a
 * moment later overwrite it with a stale copy after the other page had
 * already written a newer version — silently erasing the other page's change
 * or history entry. This is what caused "Undo sometimes does nothing" and
 * "the ○/× buttons stop responding" (a player's win/lose/freeze flags could
 * get corrupted by a lost update, which hides their buttons).
 *
 * This file fixes that by:
 *   1. Funneling every state change through QuizCore.mutate(), which uses the
 *      Web Locks API (navigator.locks) to guarantee only one tab can read
 *      -modify-write quiz_players/quiz_rules/quiz_history at a time, even
 *      across tabs/windows.
 *   2. Keeping exactly ONE implementation of the scoring rules, history and
 *      undo logic, instead of two copies that could drift apart.
 */
const QuizCore = (() => {
    const LOCK_NAME = 'quiz-state-lock';
    const HISTORY_LIMIT = 30;

    const DEFAULT_RULES = {
        ruleType: "normal", winLimit: 5, loseLimit: 3, extraLimit: 1, questionNum: 1, questionOffset: 0,
        showTimeRaceScore: false, rentouMode: "new", winEruptionEffect: true, isTopGlow: true,
        swe1_o: 1, swe1_x: 2, swe2_o: 3, swe2_x: 3, swe3_o: 6, swe3_x: 4, swe4_o: 10, swe4_x: 5,
        showAnswer: true, isTextHidden: false, qText: "", aText: "",
        timerRunning: false, timerRemaining: 300, timerLastUpdated: Date.now(), isDeliberation: false,
        ruleNameMode: "auto", customRuleName: "", chanceMode: "single"
    };

    const RULE_CONFIG = {
        'normal': { name: 'N〇M×', isPt: false },
        'ny': { name: 'NY Style', isPt: true },
        'timerace': { name: 'Time Race', isPt: true, isTimeRace: true },
        'freeze': { name: 'Freeze', isPt: false },
        'updown': { name: 'Up Down', isPt: false },
        'by': { name: 'by', isPt: true },
        'hitcombo': { name: 'Hit Combo', isPt: true },
        'backstream': { name: 'Backstream', isPt: true },
        'swedish': { name: 'Swedish', isPt: false },
        'attacksurvival': { name: 'Attack Survival', isPt: true },
        'tripleseven': { name: 'Triple Seven', isPt: false },
        'divide': { name: 'divide', isPt: true },
        'nxm': { name: 'n○m休', isPt: false },
        'melonpan': { name: 'メロンパン', isPt: true },
        'luckyshot': { name: 'ラッキーショット', isPt: true },
        'kobanzame': { name: 'コバンザメ', isPt: true },
        'runrate': { name: 'ランプレート', isPt: false }
    };

    // ---- 新ルール用ヘルパー ----
    // メロンパン: ライフ = 初期L(winLimit) - 被攻撃回数×A(loseLimit) - 誤答数×B(extraLimit)
    function melonLife(p, r) { return r.winLimit - (p.mpHit || 0) * r.loseLimit - (p.crosses || 0) * (r.extraLimit || 1); }
    // ラッキーショット / ランプレート：問題ごとの乱数（rules.rollに保存し、両画面で共有）
    function rollFor(r) { return (r.roll && r.roll.q === r.questionNum && r.roll.type === r.ruleType) ? r.roll.vals : null; }
    function luckyMax(r) { return Math.max(1, r.extraLimit || 1); }
    function ensureRoll(players, r) {
        if (r.ruleType !== 'luckyshot' && r.ruleType !== 'runrate') return false;
        const vals = rollFor(r) || {};
        let changed = !rollFor(r);
        const rnd = n => 1 + Math.floor(Math.random() * n);
        players.forEach(p => {
            if (vals[p.id]) return;
            changed = true;
            if (r.ruleType === 'luckyshot') vals[p.id] = { pt: rnd(luckyMax(r)), dmg: rnd(luckyMax(r)) };
            else { const lo = Math.min(100, Math.max(1, r.extraLimit || 10)); vals[p.id] = { rate: lo + Math.floor(Math.random() * (101 - lo)) }; }
        });
        if (changed) r.roll = { q: r.questionNum, type: r.ruleType, vals };
        return changed;
    }
    // ゲーム終了判定（メロンパン：生存者がgroupWinTarget人以下／その他の新ルール：勝ち抜けがgroupWinTarget人）
    function isGameOver(players, r) {
        const stage = players.filter(p => p.pool !== 'waiting');
        const k = r.groupWinTarget || 0;
        if (!['melonpan', 'luckyshot', 'kobanzame', 'runrate'].includes(r.ruleType) || k <= 0 || !stage.length) return false;
        const total = stage.reduce((a, p) => a + p.circles, 0);
        if (r.ruleType === 'melonpan') return stage.filter(p => !getStatus(p, r, total).isLoser).length <= k;
        return stage.filter(p => getStatus(p, r, total).isWinner).length >= k;
    }

    // ---- low level: lock helper -------------------------------------------------
    function withLock(fn) {
        if (window.navigator && navigator.locks && navigator.locks.request) {
            return navigator.locks.request(LOCK_NAME, () => fn());
        }
        // Very old browser without Web Locks API: best-effort, no cross-tab safety.
        console.warn('QuizCore: navigator.locks not available — falling back to unsynchronized mode.');
        return Promise.resolve().then(fn);
    }

    // ---- low level: raw read/write ----------------------------------------------
    function readState() {
        let players = [];
        let rules = { ...DEFAULT_RULES };
        try { players = JSON.parse(localStorage.getItem('quiz_players')) || []; } catch (e) { players = []; }
        try {
            const saved = JSON.parse(localStorage.getItem('quiz_rules'));
            if (saved) rules = { ...DEFAULT_RULES, ...saved };
        } catch (e) { /* keep defaults */ }
        if (rules.rentouMode === true) rules.rentouMode = "old";
        if (rules.rentouMode === false) rules.rentouMode = "none";
        if (rules.questionOffset === undefined) rules.questionOffset = 0;
        return { players, rules };
    }

    function writeState(players, rules) {
        localStorage.setItem('quiz_players', JSON.stringify(players));
        localStorage.setItem('quiz_rules', JSON.stringify(rules));
    }

    function pushHistoryEntry(players, rules) {
        let history = [];
        try { history = JSON.parse(localStorage.getItem('quiz_history')) || []; } catch (e) { history = []; }
        history.push({ players: JSON.parse(JSON.stringify(players)), rules: JSON.parse(JSON.stringify(rules)) });
        if (history.length > HISTORY_LIMIT) history.shift();
        localStorage.setItem('quiz_history', JSON.stringify(history));
    }

    function setAnnouncement(text) {
        localStorage.setItem('quiz_announcement', text);
    }

    // ---- public: atomic mutation --------------------------------------------------
    // mutator(players, rules) mutates the two objects in place (or returns nothing).
    // Runs the entire read -> history -> mutate -> write sequence while holding the
    // cross-tab lock, so no other tab's change can be lost in between.
    function mutate(mutator, { recordHistory = true } = {}) {
        return withLock(() => {
            const { players, rules } = readState();
            if (recordHistory) pushHistoryEntry(players, rules);
            const extra = mutator(players, rules) || {};
            writeState(players, rules);
            return { players, rules, ...extra };
        });
    }

    function undo() {
        return withLock(() => {
            let history = [];
            try { history = JSON.parse(localStorage.getItem('quiz_history')) || []; } catch (e) { history = []; }
            if (history.length === 0) return null;
            const prev = history.pop();
            localStorage.setItem('quiz_history', JSON.stringify(history));
            writeState(prev.players, prev.rules);
            setAnnouncement('↩ 1つ前の状態に戻しました');
            return prev;
        });
    }

    // ---- rule helpers (single source of truth, used by both screens) --------------
    function getSwedishPenalty(circles, r) {
        let pen = 1;
        if (circles >= r.swe4_o) pen = r.swe4_x;
        else if (circles >= r.swe3_o) pen = r.swe3_x;
        else if (circles >= r.swe2_o) pen = r.swe2_x;
        else if (circles >= r.swe1_o) pen = r.swe1_x;
        return pen;
    }

    // Current score + win/lose status for a player, given the full stage roster
    // (needed for attacksurvival, which depends on everyone else's score).
    function getStatus(p, rules, totalCircles) {
        const conf = RULE_CONFIG[rules.ruleType] || RULE_CONFIG['normal'];
        let score = 0, isWinner = false, isLoser = false;

        if (rules.ruleType === 'by') {
            score = p.circles * (rules.winLimit - p.crosses);
            isWinner = score >= (rules.winLimit * rules.winLimit);
        } else if (rules.ruleType === 'hitcombo') {
            score = p.circles; isWinner = score >= rules.winLimit;
        } else if (rules.ruleType === 'backstream') {
            score = p.circles - (p.crosses * (p.crosses + 1) / 2);
            isWinner = score >= rules.winLimit; isLoser = score <= -rules.loseLimit;
        } else if (rules.ruleType === 'swedish') {
            score = p.circles; isWinner = p.circles >= rules.winLimit; isLoser = p.crosses >= rules.loseLimit;
        } else if (rules.ruleType === 'attacksurvival') {
            const raw = rules.winLimit - rules.loseLimit * (totalCircles - p.circles) - (rules.extraLimit || 1) * p.crosses;
            // ライフは0で止める（0になった後に他の人が正解しても減らない）
            score = Math.max(0, raw);
            isLoser = raw <= 0;
        } else if (rules.ruleType === 'melonpan') {
            const raw = melonLife(p, rules);
            score = Math.max(0, raw); isLoser = raw <= 0;
        } else if (rules.ruleType === 'luckyshot') {
            score = p.lsPts || 0; isWinner = score >= rules.winLimit; isLoser = (p.lsDmg || 0) >= rules.loseLimit;
        } else if (rules.ruleType === 'kobanzame') {
            score = p.kbPts || 0; isWinner = score >= rules.winLimit;
        } else if (rules.ruleType === 'runrate') {
            score = p.circles; isWinner = score >= rules.winLimit; isLoser = p.crosses >= rules.loseLimit;
        } else if (rules.ruleType === 'tripleseven') {
            score = p.circles; isWinner = (p.setsWon || 0) >= 3; isLoser = p.crosses >= rules.loseLimit;
        } else if (rules.ruleType === 'divide') {
            score = p.divideScore !== undefined ? p.divideScore : 10;
            isWinner = score >= rules.winLimit; isLoser = score < 1;
        } else if (rules.ruleType === 'nxm') {
            score = p.circles; isWinner = score >= rules.winLimit;
        } else {
            score = conf.isPt ? (p.circles - p.crosses) : p.circles;
            isWinner = !conf.isTimeRace && score >= rules.winLimit;
            isLoser = (rules.ruleType !== 'ny' && rules.ruleType !== 'freeze' && !conf.isTimeRace) && p.crosses >= rules.loseLimit;
        }
        // Manually forced win (setup.html's "勝ち抜け" button) overrides the
        // rule's own calculation, regardless of rule type.
        if (p.manualWin) { isWinner = true; isLoser = false; }
        return { score, isWinner, isLoser };
    }

    // "Reach" = one more correct/wrong answer away from winning/losing.
    function getReach(p, rules, totalCircles) {
        let isWinReach = false, isLoseReach = false;
        const canLose = ['normal', 'updown', 'backstream', 'swedish', 'attacksurvival', 'tripleseven', 'divide', 'melonpan', 'luckyshot', 'runrate'].includes(rules.ruleType);

        if (rules.ruleType === 'melonpan') {
            // 誤答1回で失格 or 1回攻撃されたら失格
            const life = melonLife(p, rules);
            if (life > 0 && (life - (rules.extraLimit || 1) <= 0 || life - rules.loseLimit <= 0)) isLoseReach = true;
        } else if (rules.ruleType === 'luckyshot') {
            const v = (rollFor(rules) || {})[p.id];
            const pts = p.lsPts || 0, dmg = p.lsDmg || 0;
            if (v && pts < rules.winLimit && pts + v.pt >= rules.winLimit) isWinReach = true;
            if (v && dmg < rules.loseLimit && dmg + v.dmg >= rules.loseLimit) isLoseReach = true;
        } else if (rules.ruleType === 'kobanzame') {
            const pts = p.kbPts || 0;
            if (pts < rules.winLimit && pts + 1 >= rules.winLimit) isWinReach = true;
        } else if (rules.ruleType === 'runrate') {
            if (p.circles < rules.winLimit && p.circles + 1 >= rules.winLimit) isWinReach = true;
            if (p.crosses + 1 >= rules.loseLimit) isLoseReach = true;
        } else if (rules.ruleType === 'by') {
            const c = p.circles * (rules.winLimit - p.crosses);
            const n = (p.circles + 1) * (rules.winLimit - p.crosses);
            if (c < rules.winLimit * rules.winLimit && n >= rules.winLimit * rules.winLimit) isWinReach = true;
        } else if (rules.ruleType === 'hitcombo') {
            if (p.circles < rules.winLimit && p.circles + (p.combo || 0) + 1 >= rules.winLimit) isWinReach = true;
        } else if (rules.ruleType === 'backstream') {
            const s = p.circles - (p.crosses * (p.crosses + 1) / 2);
            if (s < rules.winLimit && s + 1 >= rules.winLimit) isWinReach = true;
            if (p.circles - ((p.crosses + 1) * (p.crosses + 2) / 2) <= -rules.loseLimit) isLoseReach = true;
        } else if (rules.ruleType === 'swedish') {
            if (p.circles < rules.winLimit && p.circles + 1 >= rules.winLimit) isWinReach = true;
            if (p.crosses + getSwedishPenalty(p.circles, rules) >= rules.loseLimit) isLoseReach = true;
        } else if (rules.ruleType === 'attacksurvival') {
            const s = rules.winLimit - rules.loseLimit * (totalCircles - p.circles) - (rules.extraLimit || 1) * p.crosses;
            if (s - (rules.extraLimit || 1) <= 0) isLoseReach = true;
        } else if (rules.ruleType === 'tripleseven') {
            if (p.circles < rules.winLimit && p.circles + 1 >= rules.winLimit) isWinReach = true;
            if (p.crosses + 1 >= rules.loseLimit) isLoseReach = true;
        } else if (rules.ruleType === 'divide') {
            const s = p.divideScore !== undefined ? p.divideScore : 10;
            if (s < rules.winLimit && s + 10 >= rules.winLimit) isWinReach = true;
            if (Math.floor(s / (p.crosses + 1)) < 1) isLoseReach = true;
        } else if (rules.ruleType === 'nxm') {
            if (p.circles < rules.winLimit && p.circles + 1 >= rules.winLimit) isWinReach = true;
        } else {
            const isPt = (rules.ruleType === 'ny' || rules.ruleType === 'timerace');
            const s = isPt ? (p.circles - p.crosses) : p.circles;
            if (s < rules.winLimit && s + 1 >= rules.winLimit) isWinReach = true;
            if (canLose && p.crosses + 1 >= rules.loseLimit) isLoseReach = true;
        }
        return { isWinReach, isLoseReach, canLose };
    }

    function buildAnnounceText(p, type, rules, totalCircles, setWonJustNow, gameWonJustNow) {
        if (setWonJustNow) {
            if (gameWonJustNow) return `${p.name} 3セット先取！ 優勝です！`;
            return `${p.name} セット獲得！ 現在 ${p.setsWon || 0} セット！`;
        }
        const { score } = getStatus(p, rules, totalCircles);
        const { isWinReach, isLoseReach, canLose } = getReach(p, rules, totalCircles);

        if (type === 'o') {
            let text = `${p.name}　${score} point!`;
            if (isWinReach && !p.winOrder) {
                text += (rules.ruleType === 'tripleseven' && (p.setsWon || 0) < 2)
                    ? " 次の正解でセット獲得となります。"
                    : " 次の正解で勝ち抜けとなります。";
            }
            return text;
        } else {
            let text = `${p.name}　${p.crosses} misses......`;
            if (canLose && isLoseReach) {
                text += (rules.ruleType === 'tripleseven') ? "　次の誤答でこのセットは失格となります。" : "　次の誤答で脱落となります。";
            }
            return text;
        }
    }

    // Applies one ○/× answer to player `id`. Mutates `players` in place.
    // Returns { text, setWonJustNow, gameWonJustNow } for the caller to announce.
    function applyAnswer(players, rules, id, type, opts) {
        opts = opts || {};
        const p = players.find(x => x.id === id);
        if (!p) return { text: '' };
        const NEW_RULES = ['melonpan', 'luckyshot', 'kobanzame', 'runrate'];
        if (NEW_RULES.includes(rules.ruleType)) return applyNewRule(players, rules, p, type, opts);

        if (type === 'o') {
            const hadVolcano = p.volcano;
            if (rules.ruleType === 'hitcombo') {
                p.combo = (p.combo || 0) + 1; p.circles += p.combo;
                players.forEach(pl => { if (pl.id !== id) pl.combo = 0; });
            } else if (rules.ruleType === 'divide') {
                p.divideScore = (p.divideScore !== undefined ? p.divideScore : 10) + 10;
                p.circles++;
            } else {
                p.circles++;
            }

            if (rules.rentouMode === 'new' || rules.rentouMode === 'old') {
                if (hadVolcano) {
                    if (rules.ruleType === 'divide') p.divideScore += 10; else p.circles++;
                    if (rules.rentouMode === 'new') players.forEach(pl => pl.volcano = false);
                    else players.forEach(pl => pl.volcano = (pl.id === id));
                } else {
                    players.forEach(pl => pl.volcano = (pl.id === id));
                }
            }
        } else {
            if (rules.ruleType === 'hitcombo') {
                p.combo = 0; p.crosses++; p.freeze = p.crosses + 1;
            } else if (rules.ruleType === 'divide') {
                p.crosses++;
                p.divideScore = Math.floor((p.divideScore !== undefined ? p.divideScore : 10) / p.crosses);
            } else if (rules.ruleType === 'by' || rules.ruleType === 'backstream' || rules.ruleType === 'attacksurvival') {
                p.crosses++;
            } else if (rules.ruleType === 'swedish') {
                p.crosses += getSwedishPenalty(p.circles, rules);
            } else if (rules.ruleType === 'nxm') {
                p.crosses++; p.freeze = rules.loseLimit + 1;
            } else {
                p.crosses++;
                if (rules.ruleType === 'updown') p.circles = 0;
                else if (rules.ruleType === 'freeze') p.freeze = p.crosses + 1;
            }
            if (rules.rentouMode === 'new' || rules.rentouMode === 'old') {
                if (p.volcano) p.volcano = false;
            }
        }

        let setWonJustNow = false, gameWonJustNow = false;
        if (rules.ruleType === 'tripleseven' && type === 'o' && p.circles >= rules.winLimit) {
            p.setsWon = (p.setsWon || 0) + 1;
            setWonJustNow = true;
            if (p.setsWon >= 3) gameWonJustNow = true;
        }

        // Announcement text is built from the POST-answer state, so the score
        // read out to the audience matches what was just scored, not the
        // score before this answer was entered.
        const stagePlayersAfter = players.filter(pl => pl.pool !== 'waiting');
        const totalCirclesAfter = stagePlayersAfter.reduce((sum, pl) => sum + pl.circles, 0);
        const finalText = buildAnnounceText(p, type, rules, totalCirclesAfter, setWonJustNow, gameWonJustNow);

        if (setWonJustNow && !gameWonJustNow) {
            players.forEach(pl => { pl.circles = 0; pl.crosses = 0; pl.freeze = 0; pl.combo = 0; pl.volcano = false; });
        }

        // Base-level "chance mode" (not tied to any particular rule):
        //  - single (default): every answer advances to the next question.
        //  - endless: the question stays put regardless of correct/incorrect,
        //    so several players can attempt the same question in turn.
        if (rules.chanceMode !== 'endless') {
            rules.questionNum++; rules.showAnswer = true; rules.isDeliberation = false;
            let quizList = [];
            try { quizList = JSON.parse(localStorage.getItem('quiz_csv_list')) || []; } catch (e) { quizList = []; }
            if (rules.questionNum <= 1) { rules.qText = ""; rules.aText = ""; }
            else {
                const offset = rules.questionOffset || 0;
                const index = rules.questionNum - 2 + offset;
                if (quizList.length > 0 && index >= 0 && index < quizList.length) { rules.qText = quizList[index].q; rules.aText = quizList[index].a; }
                else { rules.qText = quizList.length > 0 ? "(問題切れ)" : ""; rules.aText = ""; }
            }
        }

        players.forEach(pl => { if (pl.freeze > 0) pl.freeze--; });

        // Determine winOrder (rank in which players clinch victory) using the
        // now-updated state.
        // winOrder is also editable by the operator afterwards (setup.html's
        // 「順位」 input), to correct the on-screen rank ribbon after the fact.
        // clinchOrder is written once here and never touched again, so the
        // "1st/2nd..." badge that appears on a player's card at the moment
        // they win always reflects the real chronological win order, even if
        // winOrder gets edited later.
        const stagePlayersFinal = players.filter(pl => pl.pool !== 'waiting');
        const totalCirclesFinal = stagePlayersFinal.reduce((sum, pl) => sum + pl.circles, 0);
        const { isWinner } = getStatus(p, rules, totalCirclesFinal);
        const conf = RULE_CONFIG[rules.ruleType];
        if (!conf.isTimeRace && rules.ruleType !== 'attacksurvival' && isWinner && !p.winOrder) {
            p.winOrder = Math.max(0, ...players.map(pl => pl.winOrder || 0)) + 1;
        }
        if (!conf.isTimeRace && rules.ruleType !== 'attacksurvival' && isWinner && !p.clinchOrder) {
            p.clinchOrder = Math.max(0, ...players.map(pl => pl.clinchOrder || 0)) + 1;
        }
        if (p.winOrder > 0) p.volcano = false;

        setAnnouncement(finalText);
        return { text: finalText, setWonJustNow, gameWonJustNow };
    }

    // ---- 新ルール（メロンパン／ラッキーショット／コバンザメ／ランプレート） ----
    function advanceQuestion(rules) {
        if (rules.chanceMode === 'endless') return;
        rules.questionNum++; rules.showAnswer = true; rules.isDeliberation = false;
        let quizList = [];
        try { quizList = JSON.parse(localStorage.getItem('quiz_csv_list')) || []; } catch (e) { quizList = []; }
        const index = rules.questionNum - 2 + (rules.questionOffset || 0);
        if (rules.questionNum <= 1) { rules.qText = ''; rules.aText = ''; }
        else if (quizList.length > 0 && index >= 0 && index < quizList.length) { rules.qText = quizList[index].q; rules.aText = quizList[index].a; }
        else { rules.qText = quizList.length > 0 ? '(問題切れ)' : ''; rules.aText = ''; }
    }
    function assignWinOrders(players, rules) {
        const stage = players.filter(pl => pl.pool !== 'waiting');
        const total = stage.reduce((s, pl) => s + pl.circles, 0);
        stage.forEach(pl => {
            if (!getStatus(pl, rules, total).isWinner) return;
            if (!pl.winOrder) pl.winOrder = Math.max(0, ...players.map(x => x.winOrder || 0)) + 1;
            if (!pl.clinchOrder) pl.clinchOrder = Math.max(0, ...players.map(x => x.clinchOrder || 0)) + 1;
            pl.volcano = false;
        });
    }
    function finishTurn(players, rules, text) {
        players.forEach(pl => { if (pl.freeze > 0) pl.freeze--; });
        assignWinOrders(players, rules);
        if (isGameOver(players, rules)) {
            if (rules.ruleType === 'melonpan') {
                // 生き残った人が勝ち抜け（ライフの多い順）
                const stage = players.filter(pl => pl.pool !== 'waiting');
                stage.filter(pl => melonLife(pl, rules) > 0 && !pl.winOrder)
                    .sort((a, b) => melonLife(b, rules) - melonLife(a, rules))
                    .forEach(pl => { pl.manualWin = true; pl.winOrder = Math.max(0, ...players.map(x => x.winOrder || 0)) + 1; pl.clinchOrder = pl.winOrder; });
            }
            text += '　ゲーム終了！';
        }
        setAnnouncement(text);
        return { text };
    }
    function applyNewRule(players, rules, p, type, opts) {
        const stage = players.filter(pl => pl.pool !== 'waiting');
        let text = '';
        if (rules.ruleType === 'melonpan') {
            if (type === 'o') {
                p.circles++;
                // 攻撃先の指名待ち（applyAttack で確定して問題が進む）
                rules.mpPending = p.id;
                text = `${p.name} 正解！ 攻撃するプレイヤーを指名してください`;
                setAnnouncement(text);
                return { text, pendingAttack: true };
            }
            p.crosses++;
            const life = Math.max(0, melonLife(p, rules));
            rules.mpLast = { to: p.id, from: null, dmg: rules.extraLimit || 1, seq: Date.now() };
            text = `${p.name} 誤答… ライフ ${life}` + (life <= 0 ? '　失格' : '');
            advanceQuestion(rules);
            return finishTurn(players, rules, text);
        }
        if (rules.ruleType === 'luckyshot') {
            ensureRoll(players, rules);
            const v = rollFor(rules)[p.id] || { pt: 1, dmg: 1 };
            if (type === 'o') { p.circles++; p.lsPts = (p.lsPts || 0) + v.pt; text = `${p.name} +${v.pt}点！ 合計 ${p.lsPts}点`; }
            else { p.crosses++; p.lsDmg = (p.lsDmg || 0) + v.dmg; text = `${p.name} ${v.dmg}ダメージ… 累計 ${p.lsDmg}/${rules.loseLimit}`; }
            advanceQuestion(rules);
            return finishTurn(players, rules, text);
        }
        if (rules.ruleType === 'kobanzame') {
            const sec = opts.secondId != null ? stage.find(x => x.id === opts.secondId && x.id !== p.id) : null;
            const add = (pl, d) => { pl.kbPts = Math.max(0, (pl.kbPts || 0) + d); };
            if (type === 'o') {
                p.circles++;
                if (sec) { add(p, 1); add(sec, 1); text = `${p.name} 正解 +1、セカンド ${sec.name} +1`; }
                else { add(p, 2); text = `${p.name} 正解 +2`; }
            } else {
                p.crosses++;
                if (sec) { add(p, -1); add(sec, -2); text = `${p.name} 誤答 -1、セカンド ${sec.name} -2`; }
                else { add(p, -2); text = `${p.name} 誤答 -2`; }
            }
            advanceQuestion(rules);
            return finishTurn(players, rules, text);
        }
        // runrate
        if (type === 'o') { p.circles++; text = `${p.name} ${p.circles}〇`; }
        else { p.crosses++; text = `${p.name} ${p.crosses}×`; }
        advanceQuestion(rules);
        return finishTurn(players, rules, text);
    }
    // メロンパン：攻撃先を確定（targetId=null で攻撃なし）
    function applyAttack(players, rules, targetId) {
        const from = players.find(x => x.id === rules.mpPending);
        if (!from) { rules.mpPending = null; return { text: '' }; }
        const t = targetId != null ? players.find(x => x.id === targetId) : null;
        rules.mpPending = null;
        let text;
        if (t) {
            t.mpHit = (t.mpHit || 0) + 1;
            const life = Math.max(0, melonLife(t, rules));
            rules.mpLast = { to: t.id, from: from.id, dmg: rules.loseLimit, seq: Date.now() };
            text = `${from.name} ⚔ ${t.name}　残りライフ ${life}` + (life <= 0 ? '　失格' : '');
        } else text = `${from.name} 攻撃なし`;
        advanceQuestion(rules);
        return finishTurn(players, rules, text);
    }

    return {
        DEFAULT_RULES, RULE_CONFIG, melonLife, rollFor, ensureRoll, isGameOver, applyAttack,
        readState, writeState, mutate, undo,
        getSwedishPenalty, getStatus, getReach, buildAnnounceText, applyAnswer,
        setAnnouncement,
    };
})();
