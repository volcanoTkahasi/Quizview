/*
 * tournament-core.js — 大会運営のデータと組合せロジック（画面に依存しない純粋な関数）
 * 保存先: localStorage 'qt_tournament'（大会運営画面だけが書き込む）
 *
 * 大会 = エントリー一覧 + ラウンドの並び
 *   エントリー: { id, name, affiliation, grade, paper(ペーパー点|null), startRound(0=1R から), checkedIn, withdrawn, note }
 *   ラウンド  : { id, name, groupCount, advance(各組の勝ち抜け人数), pairing, rule, groups:[] }
 *   組        : { id, name, members:[entryId], res:{ entryId:{ rank, adv(true/false/未指定=undefined) } }, status:'pending'|'playing'|'done' }
 *
 * pairing:
 *   snake   … 成績順にサーペンタイン（1組→N組→N組→1組…）
 *   bracket … 1Rはトーナメント表のシード位置に配置、2R以降は「隣の組の勝者どうし」が当たる（トーナメント形式）
 *   order   … 成績順に上から詰める（1組に1〜k位）
 *   random  … ランダム
 *   rulepick … ルール決め（勝ち抜け者が順番にルール＝組を選ぶ。round.pick.order が選ぶ順、チェックした人から組に入る）
 */
(function (root) {
    let KEY = 'qt_tournament';
    const TEAM_KEY = 'qt_tournament_team';
    const COLORS = ["#ff1a1a", "#1a75ff", "#ffeb3b", "#28a745", "#9c27b0", "#ff9800", "#00bcd4", "#e91e63", "#795548", "#607d8b", "#8bc34a", "#3f51b5", "#ff5722", "#009688", "#cddc39", "#9e9e9e"];
    const uid = p => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    function blank() {
        return { name: '新しい大会', date: '', entries: [], rounds: [], current: null, onlyCheckedIn: false, updatedAt: Date.now() };
    }
    function load(storage) {
        const s = storage || root.localStorage;
        try { const t = JSON.parse(s.getItem(KEY)); if (t && Array.isArray(t.entries) && Array.isArray(t.rounds)) return ensure(t); } catch (e) { }
        return null;
    }
    function save(t, storage) {
        const s = storage || root.localStorage;
        t.updatedAt = Date.now();
        s.setItem(KEY, JSON.stringify(t));
    }

    function newEntry(o) {
        return {
            id: uid('e'), name: (o.name || '').trim(), affiliation: (o.affiliation || '').trim(), grade: (o.grade || '').trim(),
            paper: (o.paper === '' || o.paper == null || isNaN(Number(o.paper))) ? null : Number(o.paper),
            startRound: Math.max(0, parseInt(o.startRound, 10) || 0), checkedIn: !!o.checkedIn, withdrawn: false, note: (o.note || '').trim(), members: (o.members || '').trim()
        };
    }
    // ---- ルール（試合画面の ruleType / N / M / X と同じ） ----
    const RULE_TYPES = {
        normal: 'N○M×', nxm: 'n○m休', ny: 'NY Style', updown: 'Up Down', freeze: 'Freeze', swedish: 'Swedish', by: 'by',
        hitcombo: 'Hit Combo', backstream: 'Backstream', attacksurvival: 'Attack Survival', tripleseven: 'Triple Seven', divide: 'divide',
        melonpan: 'メロンパン', luckyshot: 'ラッキーショット', kobanzame: 'コバンザメ', runrate: 'ランプレート', timerace: 'Time Race'
    };
    const TEAM_RULE_TYPES = { AQL: 'AQL（積算・誤答Lock）', EQIDEN: 'EQIDEN（駅伝）' };
    function newRule(o) {
        o = o || {};
        return { id: uid('u'), ruleType: (RULE_TYPES[o.ruleType] || TEAM_RULE_TYPES[o.ruleType]) ? o.ruleType : 'normal', winLimit: o.winLimit != null ? Number(o.winLimit) : 7, loseLimit: o.loseLimit != null ? Number(o.loseLimit) : 3, extraLimit: o.extraLimit != null ? Number(o.extraLimit) : 1, label: o.label || '', qlimit: Number(o.qlimit) || 0 };
    }
    function ruleLabel(u) {
        if (!u) return '';
        if (u.label) return u.label;
        const N = u.winLimit, M = u.loseLimit;
        switch (u.ruleType) {
            case 'normal': return `${N}○${M}×`;
            case 'nxm': return `${N}○${M}休`;
            case 'ny': return `${N}pt NY`;
            case 'updown': return `${N}○${M}× Up Down`;
            case 'swedish': return `Swedish ${N}○${M}×`;
            case 'freeze': return `${N}○ Freeze`;
            case 'by': return `${N}by${N}`;
            case 'kobanzame': return `コバンザメ ${N}pt`;
            case 'melonpan': return `メロンパン L${N}`;
            case 'divide': return `divide ${N}pt`;
            case 'timerace': return 'Time Race';
            case 'AQL': return `AQL ${N}pt`;
            case 'EQIDEN': return 'EQIDEN';
            default: return `${RULE_TYPES[u.ruleType]} ${N}`;
        }
    }
    function newRound(o) {
        const rules = (o.rules && o.rules.length ? o.rules : [{ ruleType: 'normal', winLimit: 7, loseLimit: 3 }]).map(newRule);
        return {
            id: uid('r'), name: o.name || 'ラウンド', groupCount: Math.max(1, parseInt(o.groupCount, 10) || 1),
            advance: Math.max(0, parseInt(o.advance, 10) || 0), pairing: o.pairing || 'snake', rules, groups: [], ex: !!o.ex
        };
    }
    // 古いデータ（ルールが文字のメモだった頃）を新しい形に揃える
    function ensure(t) {
        (t.rounds || []).forEach(r => {
            if (!Array.isArray(r.rules) || !r.rules.length) { r.rules = [newRule({ label: r.rule || '' })]; }
            delete r.rule;
            (r.groups || []).forEach((g, i) => { if (!g.ruleId || !r.rules.some(u => u.id === g.ruleId)) g.ruleId = r.rules[i % r.rules.length].id; });
        });
        return t;
    }
    function groupRule(r, g) { return (r.rules || []).find(u => u.id === g.ruleId) || (r.rules || [])[0] || null; }

    // ---- 貼り付け／CSVの取り込み（スプレッドシートやGoogleフォームの回答をコピペ） ----
    function splitLine(line, sep) {
        if (sep === '\t') return line.split('\t');
        const out = []; let cur = '', q = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
            else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
        }
        out.push(cur); return out;
    }
    const HEAD = {
        name: /^(名前|氏名|なまえ|エントリー名|name|ハンドル|プレイヤー名|チーム名|チーム|team)/i,
        affiliation: /^(所属|学校|学校名|団体|affiliation|school)/i,
        grade: /^(学年|grade)/i,
        paper: /^(ペーパー|ペーパー点|paper|点数|得点|score)/i,
        startRound: /^(シード|開始|seed)/i,
        note: /^(備考|メモ|note)/i,
        members: /^(メンバー|members|選手|構成員)/i
    };
    function parseEntries(text, opts) {
        opts = opts || {};
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() !== '');
        if (!lines.length) return [];
        const sep = lines[0].includes('\t') ? '\t' : ',';
        let rows = lines.map(l => splitLine(l, sep).map(c => c.trim()));
        let map = opts.team ? { name: 0, affiliation: 1, members: 2, paper: 3 } : { name: 0, affiliation: 1, grade: 2, paper: 3 };
        const head = rows[0];
        const found = {};
        head.forEach((h, i) => { for (const k in HEAD) if (found[k] == null && HEAD[k].test(h)) found[k] = i; });
        if (found.name != null) { map = found; rows = rows.slice(1); }
        return rows.filter(r => (r[map.name] || '').trim()).map(r => newEntry({
            name: r[map.name], affiliation: map.affiliation != null ? r[map.affiliation] : '', grade: map.grade != null ? r[map.grade] : '',
            paper: map.paper != null ? r[map.paper] : null, startRound: map.startRound != null ? r[map.startRound] : 0, note: map.note != null ? r[map.note] : '', members: map.members != null ? r[map.members] : ''
        }));
    }

    // ---- 並べ替え ----
    function byPaper(a, b) {
        const pa = a.paper == null ? -Infinity : a.paper, pb = b.paper == null ? -Infinity : b.paper;
        return pb - pa;
    }
    function paperRanks(t) {
        const list = t.entries.filter(e => !e.withdrawn && e.paper != null).slice().sort(byPaper);
        const r = {}; let prev = null, rank = 0;
        list.forEach((e, i) => { if (e.paper !== prev) { rank = i + 1; prev = e.paper; } r[e.id] = rank; });
        return r;
    }
    function shuffle(a, rnd) { rnd = rnd || Math.random; a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
    // トーナメント表の標準シード順（例: 8 → 1,8,4,5,2,7,3,6）
    function seedOrder(n) {
        let order = [1];
        while (order.length < n) { const m = order.length * 2; order = order.flatMap(s => [s, m + 1 - s]); }
        return order.filter(s => s <= n);
    }

    // ---- 組の結果 ----
    function isAdv(g, eid, advance) {
        const r = (g.res || {})[eid] || {};
        if (r.adv === true || r.adv === false) return r.adv;
        return r.rank > 0 && r.rank <= advance;
    }
    function advancers(round, g) {
        return g.members.filter(id => isAdv(g, id, round.advance))
            .sort((a, b) => (((g.res[a] || {}).rank || 999) - ((g.res[b] || {}).rank || 999)));
    }

    function eligible(t, e) { return !e.withdrawn && (!t.onlyCheckedIn || e.checkedIn); }

    // ラウンド ri に出場する人を「強い順」に並べて返す（シード → 前ラウンド勝ち抜け）
    function participants(t, ri) {
        const ent = Object.fromEntries(t.entries.map(e => [e.id, e]));
        const seeds = t.entries.filter(e => eligible(t, e) && (e.startRound || 0) === ri).sort(byPaper).map(e => e.id);
        if (ri === 0) return { ordered: seeds, seeds: seeds, fromPrev: [] };
        const R = t.rounds[ri], prev = t.rounds[ri - 1];
        const advOf = rd => { const out = []; const per = rd.groups.map(g => advancers(rd, g).filter(id => ent[id] && !ent[id].withdrawn)); per.forEach((ids, gi) => ids.forEach((id, k) => out.push({ id, rank: k + 1, gi }))); out.sort((a, b) => a.rank - b.rank || byPaper(ent[a.id], ent[b.id]) || a.gi - b.gi); return out.map(x => x.id); };
        // 敗者復活の最初のラウンド：ここまでに敗退した人（ペーパー順）
        if (R.ex && !prev.ex) {
            const keep = new Set(advOf(prev)), played = new Set();
            for (let k = 0; k < ri; k++) t.rounds[k].groups.forEach(g => g.members.forEach(id => played.add(id)));
            const ids = t.entries.filter(e => played.has(e.id) && !keep.has(e.id) && !e.withdrawn).sort(byPaper).map(e => e.id);
            return { ordered: ids, seeds: [], fromPrev: ids, fromPrevByGroup: [ids] };
        }
        // 敗者復活の直後：復活前の本線ラウンドの勝ち抜け＋復活した人
        if (!R.ex && prev.ex) {
            let k = ri - 1; while (k > 0 && t.rounds[k].ex) k--;
            const main = t.rounds[k].ex ? [] : advOf(t.rounds[k]), rev = advOf(prev);
            const fp = main.concat(rev.filter(id => !main.includes(id)));
            return { ordered: seeds.concat(fp), seeds, fromPrev: fp, fromPrevByGroup: [main, rev] };
        }
        const fromPrevByGroup = prev.groups.map(g => advancers(prev, g).filter(id => ent[id] && !ent[id].withdrawn));
        // 前ラウンドの順位 → ペーパー → 組順
        const flat = [];
        fromPrevByGroup.forEach((ids, gi) => ids.forEach((id, k) => flat.push({ id, rank: k + 1, gi })));
        flat.sort((a, b) => a.rank - b.rank || byPaper(ent[a.id], ent[b.id]) || a.gi - b.gi);
        const fromPrev = flat.map(x => x.id);
        // シード（後のラウンドから登場）は強い扱いで先頭
        return { ordered: seeds.concat(fromPrev), seeds, fromPrev, fromPrevByGroup };
    }

    function makeGroups(t, ri, opts) {
        opts = opts || {};
        const round = t.rounds[ri];
        const n = round.groupCount;
        const P = participants(t, ri);
        const buckets = Array.from({ length: n }, () => []);
        round.pick = null;
        if (round.pairing === 'rulepick') {
            round.pick = { order: P.ordered.slice(), sel: {} };   // 組はからっぽで作る
        } else if (round.pairing === 'bracket' && ri > 0 && P.fromPrevByGroup && P.fromPrevByGroup.length >= n) {
            // 隣り合う前ラウンドの組の勝者どうし（1組+2組 → 新1組 …）
            const per = P.fromPrevByGroup.length / n;
            P.fromPrevByGroup.forEach((ids, gi) => { buckets[Math.min(n - 1, Math.floor(gi / per))].push(...ids); });
            // シードは空きの多い組へ順番に
            P.seeds.forEach(id => { let k = 0; buckets.forEach((b, i) => { if (b.length < buckets[k].length) k = i; }); buckets[k].push(id); });
        } else if (round.pairing === 'random') {
            shuffle(P.ordered, opts.rnd).forEach((id, i) => buckets[i % n].push(id));
        } else if (round.pairing === 'order') {
            const size = Math.ceil(P.ordered.length / n);
            P.ordered.forEach((id, i) => buckets[Math.min(n - 1, Math.floor(i / size))].push(id));
        } else {
            // snake（bracket の1Rも snake で組を作ってからシード位置に並べ替え）
            P.ordered.forEach((id, i) => { const lap = Math.floor(i / n), pos = i % n; buckets[lap % 2 === 0 ? pos : n - 1 - pos].push(id); });
            if (round.pairing === 'bracket') {
                const order = seedOrder(n); // order[k] = k番目の位置に入るシード番号
                const re = order.map(s => buckets[s - 1]);
                re.forEach((b, i) => buckets[i] = b);
            }
        }
        const prefix = round.name || ('R' + (ri + 1));
        round.groups = buckets.map((members, i) => ({ id: uid('g'), name: n === 1 ? prefix : `${prefix}-${i + 1}`, members, res: {}, status: 'pending', ruleId: round.rules[i % round.rules.length].id }));
        if (t.current && t.current.ri === ri) t.current = null;
        return round.groups;
    }

    // ルール決め：eid を gid の組へ（gid=null で未決定に戻す）
    function pickSet(t, ri, eid, gid) {
        const r = t.rounds[ri]; if (!r) return;
        r.groups.forEach(g => { if (g.members.includes(eid)) { g.members = g.members.filter(x => x !== eid); delete g.res[eid]; } });
        if (gid) { const g = r.groups.find(x => x.id === gid); if (g) g.members.push(eid); }
    }
    function pickedGroup(r, eid) { return r.groups.find(g => g.members.includes(eid)) || null; }
    function capacity(r) { const n = r.pick ? r.pick.order.length : 0; return Math.ceil(n / Math.max(1, r.groups.length)); }

    // ---- 問題CSV（1列目:問題 / 2列目:答え / 3列目:組（一括読込のとき）） ----
    function csvRows(text) {
        text = String(text || '').replace(/^\uFEFF/, '');
        const sep = (text.split(/\r?\n/)[0] || '').includes('\t') && !(text.split(/\r?\n/)[0] || '').includes(',') ? '\t' : ',';
        const rows = []; let row = [], cur = '', q = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
            if (c === '"' && cur === '') { q = true; continue; }
            if (c === sep) { row.push(cur); cur = ''; continue; }
            if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; continue; }
            cur += c;
        }
        if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
        return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
    }
    function parseQuestions(text) {
        const rows = csvRows(text);
        let m = { q: 0, a: 1, g: 2, alt: -1 };
        const H = { q: /^(問題|問|q|question|問題文)$/i, a: /^(答え|解答|正解|a|answer)$/i, alt: /^(別解|許容|別答|alt)/i, g: /^(組|グループ|group)$/i, n: /^(no|番号|#|問題番号)$/i };
        if (rows.length && rows[0].some(c => H.q.test(String(c).trim()))) {
            const h = rows.shift().map(c => String(c).trim()); m = { q: -1, a: -1, g: -1, alt: -1 };
            h.forEach((c, i) => { for (const k of ['q', 'a', 'alt', 'g']) if (m[k] < 0 && H[k].test(c)) m[k] = i; });
            if (m.a < 0) m.a = m.q + 1;
        }
        const at = (r, i) => i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '';
        return rows.filter(r => at(r, m.q)).map(r => ({ q: at(r, m.q), a: at(r, m.a), g: at(r, m.g), alt: at(r, m.alt) }));
    }
    // 一括読込：3列目（組番号 1,2… / 組名 / 「A」など）で組ごとに振り分ける。3列目が空の行は全組共通
    function splitQuestionsByGroup(round, list) {
        const out = round.groups.map(() => []);
        list.forEach(x => {
            const key = String(x.g || '').trim();
            if (!key) { out.forEach(a => a.push({ q: x.q, a: x.a, alt: x.alt || '' })); return; }
            let gi = round.groups.findIndex(g => g.name === key || g.name.endsWith('-' + key));
            if (gi < 0 && /^\d+$/.test(key)) gi = parseInt(key, 10) - 1;
            if (gi < 0 && /^[A-Za-z]$/.test(key)) gi = key.toUpperCase().charCodeAt(0) - 65;
            if (gi >= 0 && gi < out.length) out[gi].push({ q: x.q, a: x.a, alt: x.alt || '' });
        });
        return out;
    }

    // ---- 企画書（PDFから取り出したテキスト）→ ラウンド構成 ----
    const KANJI_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    const z2h = t => String(t || '').normalize('NFKC').replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ').replace(/[〇◯⭕]/g, '○').replace(/[✕✖╳ｘＸ]/g, '×').replace(/[→⇒➡]/g, '→');
    const RULE_ALIAS = [
        ['melonpan', /メロンパン/], ['kobanzame', /コバンザメ/], ['luckyshot', /ラッキー\s*ショット/i], ['runrate', /ラン\s*(プ)?レート/],
        ['swedish', /swedish|スウェーデン|スウェディッシュ/i], ['freeze', /freeze|フリーズ/i], ['updown', /up[\s\-]*down|アップ[\s\-・]*ダウン/i],
        ['attacksurvival', /attack\s*survival|アタック\s*サバイバル|アタサバ/i], ['tripleseven', /triple\s*seven|トリプル\s*セブン/i],
        ['hitcombo', /hit\s*combo|ヒット\s*コンボ/i], ['backstream', /back\s*stream|バック\s*ストリーム/i], ['divide', /divide|ディバイド/i],
        ['timerace', /time\s*race|タイム\s*レース/i], ['ny', /\bNY\b|ニューヨーク/i], ['by', /\bby\b|バイ方式/i],
        ['AQL', /\bAQL\b/i], ['EQIDEN', /EQIDEN|駅伝/i]
    ];
    const ROUND_HEAD = /^\s*(?:■|◆|●|◎|【|\[)?\s*(第\s*[0-9一二三四五六七八九十]+\s*(?:ラウンド|R|回戦)|[0-9]+\s*(?:st|nd|rd|th)\s*round|[0-9]+\s*(?:R|ラウンド|Round|回戦)(?![a-z])|Round\s*[0-9]+|Quarter\s*Final(?:\s*Round)?|Semi\s*Final(?:\s*Round)?|Final(?:\s*Round)?|Extra\s*Round|EX\s*Round|Step\s*[0-9]+|準々決勝|準決勝|決勝|敗者復活(?:戦)?|ファイナル|セミファイナル|予選)/i;
    // 「7by7」「Swedish7」「10HitCombo」「Attack Survival20」「アド付き5○2×」などルール名から
    function ruleFromName(str, team) {
        const t = String(str || '').replace(/【[^】]*】?/g, ' ').trim(); if (!t) return null;
        let m;
        if ((m = t.match(/([0-9]+)\s*by\s*([0-9]+)?/i))) return { ruleType: 'by', winLimit: +m[1], loseLimit: 3 };
        const alias = RULE_ALIAS.find(([k, rx]) => ((k === 'AQL' || k === 'EQIDEN') === !!team) && k !== 'by' && rx.test(t));
        if (alias) {
            const k = alias[0], rx = alias[1];
            const after = (t.split(rx)[1] || '').match(/^\s*([0-9]+)/), before = (t.split(rx)[0] || '').match(/([0-9]+)\s*$/);
            const n = after ? +after[1] : before ? +before[1] : null;
            const nm = t.match(/([0-9]+)\s*○\s*([0-9]+)\s*×/);
            const D = { AQL: [200, 0], swedish: [10, 10], melonpan: [10, 3], updown: [10, 2], attacksurvival: [20, 1], hitcombo: [10, 3] }[k] || [5, 3];
            const w = nm ? +nm[1] : n != null ? n : D[0];
            const r = { ruleType: k, winLimit: w, loseLimit: nm ? +nm[2] : k === 'swedish' && n != null ? n : D[1] };
            if (k === 'attacksurvival') r.extraLimit = 2;
            return r;
        }
        if ((m = t.match(/([0-9]+)\s*○\s*([0-9]+)\s*(×|休)/))) return { ruleType: m[3] === '休' ? 'nxm' : 'normal', winLimit: +m[1], loseLimit: +m[2] };
        if (/筆記|ペーパー/.test(t)) return { ruleType: 'normal', winLimit: 10, loseLimit: 10, label: t.replace(/^[0-9+]+問\s*/, '') };
        return null;
    }
    // 本文で勝ち抜け・失格の数を確かめる
    function refineRule(r, body) {
        let m; const b = body;
        if (r.ruleType === 'attacksurvival') {
            if ((m = b.match(/初期[点値]?\s*(?:として)?\s*([0-9]+)\s*(?:ポイント|pt|点)/))) r.winLimit = +m[1];
            if ((m = b.match(/正解で[^。]*?自分以外[^。]*?-\s*([0-9]+)/))) r.loseLimit = +m[1];
            if ((m = b.match(/誤答で[^。]*?自(?:ら|分)[^。]*?-\s*([0-9]+)/))) r.extraLimit = +m[1];
            return r;
        }
        if (r.ruleType === 'by') { if ((m = b.match(/([0-9]+)\s*回の?誤答で失格/))) r.loseLimit = +m[1]; return r; }
        if ((m = b.match(/([0-9]+)\s*(?:○|◯|問正解|問の?正解)\s*(?:到達)?\s*で勝ち?抜け/)) || (m = b.match(/累計\s*([0-9]+)\s*(?:○|◯)\s*到達で勝ち?抜け/))) r.winLimit = +m[1];
        if ((m = b.match(/([0-9]+)\s*(?:×|✕|問誤答|回の誤答|回目の誤答)\s*で失格/))) r.loseLimit = +m[1];
        return r;
    }
    function rulesIn(seg, team) {
        const out = [];
        seg.split(/[\/／\n、。]|\s{2,}/).forEach(chunk => {
            if (!chunk.trim()) return;
            const nm = chunk.match(/([0-9]+)\s*○\s*([0-9]+)\s*(×|休)/), no = chunk.match(/([0-9]+)\s*○(?!\s*[0-9])/);
            const pt = chunk.match(/([0-9]+)\s*(?:pt|ポイント|点|p)\b/i) || chunk.match(/([0-9]+)\s*(?:pt|ポイント|点)/i), life = chunk.match(/(?:L|ライフ)\s*([0-9]+)/i);
            const alias = RULE_ALIAS.find(([k, rx]) => ((k === 'AQL' || k === 'EQIDEN') === !!team) && rx.test(chunk));
            if (alias) {
                const k = alias[0];
                const def = { AQL: [200, 0], swedish: [10, 10], melonpan: [10, 3] }[k] || [5, 3];
                out.push({ ruleType: k, winLimit: life ? +life[1] : nm ? +nm[1] : pt ? +pt[1] : no ? +no[1] : def[0], loseLimit: nm ? +nm[2] : def[1] });
            } else if (nm) out.push({ ruleType: nm[3] === '休' ? 'nxm' : 'normal', winLimit: +nm[1], loseLimit: +nm[2] });
        });
        return out;
    }
    function roundName(raw) {
        let name = raw.replace(/\s+/g, ' ').trim(), m;
        if ((m = name.match(/^第\s*([0-9一二三四五六七八九十]+)\s*(ラウンド|R|回戦)$/))) return (KANJI_NUM[m[1]] || m[1]) + 'R';
        if ((m = name.match(/^([0-9]+)\s*(?:st|nd|rd|th)?\s*(?:R|ラウンド|Round|回戦)$/i)) || (m = name.match(/^Round\s*([0-9]+)$/i))) return m[1] + 'R';
        if (/^quarter\s*final/i.test(name)) return '準々決勝';
        if (/^semi\s*final|^セミファイナル/i.test(name)) return '準決勝';
        if (/^final|^ファイナル/i.test(name)) return '決勝';
        if (/^(extra|ex)\s*round|^敗者復活/i.test(name)) return '敗者復活';
        if ((m = name.match(/^step\s*([0-9]+)/i))) return 'Step' + m[1];
        return name.replace(/\s+/g, '');
    }
    function parsePlan(text, opts) {
        opts = opts || {};
        const lines = z2h(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const plan = { name: '', date: '', rounds: [] };
        const ttl = lines.slice(0, 8).find(l => /(企画書|要項|企画案)/.test(l) && l.length <= 50);
        const nm = ttl || lines.find(l => /(杯|大会|オープン|カップ|Cup|選手権|例会|クイズ)/i.test(l) && l.length <= 40 && !ROUND_HEAD.test(l) && !/^[<＜【・]/.test(l));
        if (nm) plan.name = nm.replace(/^(大会名|名称)[:：\s]*/, '').replace(/\s*(企画書|要項|実施要項|企画案)\s*$/, '').trim();
        const dm = z2h(text).match(/(20[0-9]{2})\s*[年\/.\-]\s*([0-9]{1,2})\s*[月\/.\-]\s*([0-9]{1,2})/);
        if (dm) plan.date = `${dm[1]}/${+dm[2]}/${+dm[3]}`;
        // ラウンドごとに区切る（見出し行の残り＝タイトル。次の行が【…】ならそれもタイトル）
        const segs = []; let cur = null, exParent = null;
        lines.forEach(l => {
            const m = l.match(ROUND_HEAD);
            if (m && !/^[・※]/.test(l)) {
                let name = roundName(m[1]); const title = l.slice(m[0].length).trim();
                if (/^Step/.test(name) && exParent) { name = 'EX ' + name; exParent.hasSteps = true; }
                const same = segs.find(s => s.name === name);
                if (same) { cur = same; cur.lines.push(title); return; }
                cur = { name, title, lines: [], ex: name.startsWith('敗者復活') || name.startsWith('EX ') }; segs.push(cur);
                if (name === '敗者復活') exParent = cur; else if (!cur.ex) exParent = null;
            } else if (cur) {
                if (!cur.lines.length && /^【/.test(l)) cur.title += ' ' + l; else cur.lines.push(l);
            }
        });
        const entryNames = (opts.names || []).map(n => n.replace(/\s/g, ''));
        segs.filter(sg => !sg.hasSteps).forEach(sg => {
            const seg = sg.lines.join('\n'), title = sg.title || '';
            const r = { name: sg.name, groupCount: 1, advance: 1, pairing: 'snake', rules: [], groups: [], note: '', ex: !!sg.ex, make: true, qlimit: 0 };
            let m, fromBracket = false;
            const br = (title.match(/【([^】]*)】?/) || [])[1] || '';
            if ((m = br.match(/\(\s*([0-9]+)\s*→\s*([0-9]+)\s*\)\s*[×x*]\s*([0-9]+)/))) { r.groupCount = +m[3]; r.advance = +m[2]; fromBracket = true; }
            else if (/ALL\s*→\s*ALL/i.test(br)) { r.make = false; r.advance = 0; r.note = 'ペーパー（全員通過）。ペーパーの点はエントリーに入れてください'; fromBracket = true; }
            else if ((m = br.match(/([0-9]+)\s*→\s*([0-9]+)/))) { r.advance = +m[2]; fromBracket = true; }
            else if (/champion|優勝/i.test(br)) { r.advance = 1; fromBracket = true; }
            // コース・ルール別（CourseA 7by7 …）
            const course = []; let cc = null;
            sg.lines.forEach(l => { const c = l.match(/^(?:Course|コース)\s*([A-Z0-9])(?![、,，A-Za-z])\s*[:：]?\s*([^、,，].*)$/i); if (c) { cc = { key: c[1].toUpperCase(), name: c[2].trim(), body: [] }; course.push(cc); } else if (cc) cc.body.push(l); });
            if (course.length >= 2) {
                course.forEach(c => { const u = ruleFromName(c.name, opts.team) || { ruleType: 'normal', winLimit: 7, loseLimit: 3 }; refineRule(u, c.body.join('\n')); u.label = `Course${c.key} ${c.name}`; r.rules.push(u); });
                if (/選択|選ぶ|希望/.test(seg)) r.pairing = 'rulepick';
            } else {
                const u = ruleFromName(title, opts.team);
                if (u) { refineRule(u, seg); const lb = title.replace(/【[^】]*】?/g, '').trim(); if (lb && !/^[0-9]+\s*○\s*[0-9]+\s*×$/.test(lb)) u.label = lb; r.rules.push(u); }
                else r.rules = rulesIn(seg, opts.team);
            }
            if (!fromBracket) {
                if ((m = seg.match(/([0-9]+)\s*人\s*[×x*]\s*([0-9]+)\s*組/))) r.groupCount = +m[2];
                else if ((m = seg.match(/([0-9]+)\s*組に分け/)) || (m = seg.match(/([0-9]+)\s*組/))) r.groupCount = +m[1];
                if ((m = seg.match(/勝ち?抜け定員は\s*(?:各組|1組)?\s*([0-9]+)\s*(?:人|名|チーム)/))) r.advance = +m[1];
                else if ((m = seg.match(/(?:各組|上位|各)\s*(?:上位)?\s*([0-9]+)\s*(?:人|名|チーム)/))) r.advance = +m[1];
                else if ((m = seg.match(/([0-9]+)\s*(?:人|名|チーム)\s*(?:が)?\s*(?:勝ち?抜け|通過|抜け|進出)/))) r.advance = +m[1];
                else if ((m = seg.match(/([0-9]+)\s*→\s*([0-9]+)/))) r.advance = Math.max(1, Math.round(+m[2] / r.groupCount));
                if (/決勝/.test(sg.name) && !/準/.test(sg.name) && !/(勝ち?抜け|通過)/.test(seg)) r.advance = 1;
            }
            if (course.length >= 2 && r.groupCount < course.length) r.groupCount = course.length;
            if ((m = seg.match(/限定問題数\s*(?:は|:)?\s*([0-9]+)\s*問/))) { r.qlimit = +m[1]; r.rules.forEach(u => u.qlimit = +m[1]); }
            if (r.pairing !== 'rulepick') {
                if (/ルール決め|ルールを選|ルール選択|コース(?:を)?選/.test(seg)) r.pairing = 'rulepick';
                else if (/トーナメント/.test(seg)) r.pairing = 'bracket';
                else if (/ランダム|抽選|くじ/.test(seg)) r.pairing = 'random';
            }
            // 組分けの名前（「1組: 山田、佐藤…」）がエントリーと一致したら、その組合せを使う
            sg.lines.forEach(l => {
                const g = l.match(/^(?:([0-9]+|[A-Z])\s*組|Group\s*([0-9A-Z]+))\s*[:：)）]?\s*(.+)$/i); if (!g || !entryNames.length) return;
                const names = g[3].split(/[、,，\/／・\s]+/).map(x => x.trim()).filter(Boolean);
                const hit = names.filter(n => entryNames.includes(n.replace(/\s/g, '')));
                if (hit.length >= 1) r.groups.push(hit);
            });
            if (r.groups.length > r.groupCount) r.groupCount = r.groups.length;
            if (!r.rules.length && r.make) r.note = 'ルールが読み取れませんでした';
            if (r.ex && !r.note) r.note = /筆記|ペーパー/.test(title) ? '敗者復活・筆記（結果は手入力）' : '敗者復活';
            plan.rounds.push(r);
        });
        return plan;
    }

    function roundDone(round) { return round.groups.length > 0 && round.groups.every(g => g.status === 'done'); }

    // 最終順位（最後まで残った人ほど上。同じラウンドで敗退した人はその組の順位→ペーパー）
    function standings(t) {
        const ent = Object.fromEntries(t.entries.map(e => [e.id, e]));
        const seen = {}; const out = [];
        for (let ri = t.rounds.length - 1; ri >= 0; ri--) {
            const round = t.rounds[ri];
            const rows = [];
            round.groups.forEach(g => g.members.forEach(id => {
                if (seen[id] || !ent[id]) return;
                const r = (g.res || {})[id] || {};
                rows.push({ id, ri, group: g.name, rank: r.rank || 0, adv: isAdv(g, id, round.advance), done: g.status === 'done' });
            }));
            rows.sort((a, b) => (a.rank || 999) - (b.rank || 999) || byPaper(ent[a.id], ent[b.id]));
            rows.forEach(x => { seen[x.id] = 1; out.push(x); });
        }
        return out;
    }

    // ---- サンプル大会（初回起動時に入っている例） ----
    function sample() {
        const names = ['青木 蒼真', '石川 結衣', '上田 陸', '遠藤 美咲', '大野 颯太', '加藤 葵', '木村 蓮', '小林 芽依', '斎藤 悠斗', '佐々木 陽菜',
            '清水 湊', '鈴木 さくら', '高橋 大和', '田中 凛', '中村 樹', '西村 楓', '橋本 晴', '林 ひなた', '藤田 奏', '松本 心春',
            '森 律', '山口 紬', '山本 朝陽', '渡辺 莉子'];
        const schools = ['名古屋北高', '名古屋南高', '栄東高', '千種高', '熱田高', '瑞穂高', '昭和学園', '中川高'];
        const t = blank();
        t.name = 'サンプル杯 高校生早押しクイズ大会'; t.date = '2026/11/23';
        t.entries = names.map((n, i) => newEntry({ name: n, affiliation: schools[(i * 3) % schools.length], grade: String(i % 3 + 1), paper: 96 - i * 3 - (i % 4), checkedIn: true, startRound: i < 4 ? 1 : 0 }));
        t.rounds = [
            newRound({ name: '1R', groupCount: 5, advance: 2, pairing: 'snake', rules: [{ ruleType: 'normal', winLimit: 5, loseLimit: 2 }, { ruleType: 'nxm', winLimit: 5, loseLimit: 2 }, { ruleType: 'kobanzame', winLimit: 7 }] }),
            newRound({ name: '準決勝', groupCount: 2, advance: 3, pairing: 'rulepick', rules: [{ ruleType: 'normal', winLimit: 7, loseLimit: 3 }, { ruleType: 'melonpan', winLimit: 10, loseLimit: 3, extraLimit: 2 }] }),
            newRound({ name: '決勝', groupCount: 1, advance: 1, pairing: 'snake', rules: [{ ruleType: 'swedish', winLimit: 10, loseLimit: 10, label: '10○10× Swedish' }] })
        ];
        makeGroups(t, 0);
        // 1R はすべて試合済み、準決勝はルール決めの途中（3人決定）という例
        t.rounds[0].groups.forEach((g, gi) => { g.members.forEach((id, k) => g.res[id] = { rank: (k + gi) % 4 === 1 ? 1 : (k + gi) % 4 === 2 ? 2 : 0 }); g.status = 'done'; });
        makeGroups(t, 1);
        const sf = t.rounds[1];
        sf.pick.order.slice(0, 3).forEach((id, k) => { const gid = sf.groups[k % 2 === 0 ? 0 : 1].id; sf.pick.sel[id] = gid; pickSet(t, 1, id, gid); });
        return t;
    }

    function sampleTeam() {
        const t = blank();
        t.name = 'サンプル杯 高校対抗AQL'; t.date = '2026/12/20';
        const sc = [['愛知総合工科A', '愛知総合工科高'], ['名古屋北', '名古屋北高'], ['千種', '千種高'], ['熱田', '熱田高'], ['瑞穂', '瑞穂高'], ['栄東A', '栄東高'], ['昭和学園', '昭和学園'], ['中川', '中川高']];
        const fam = ['青木', '石川', '上田', '遠藤', '加藤', '木村', '佐藤', '鈴木', '高橋', '田中', '中村', '林', '藤田', '森', '山口', '渡辺'];
        sc.forEach(([n, a], i) => t.entries.push(newEntry({ name: n, affiliation: a, paper: 90 - i * 7, checkedIn: true, members: [0, 1, 2, 3, 4].map(k => fam[(i * 5 + k) % fam.length]).join('/') })));
        t.rounds = [
            newRound({ name: '1R', groupCount: 4, advance: 1, pairing: 'bracket', rules: [{ ruleType: 'AQL', winLimit: 200, loseLimit: 0 }] }),
            newRound({ name: '準決勝', groupCount: 2, advance: 1, pairing: 'bracket', rules: [{ ruleType: 'AQL', winLimit: 200, loseLimit: 0 }] }),
            newRound({ name: '決勝', groupCount: 1, advance: 1, pairing: 'bracket', rules: [{ ruleType: 'AQL', winLimit: 300, loseLimit: 0 }] })
        ];
        makeGroups(t, 0);
        return t;
    }
    function colorFor(i) { return COLORS[i % COLORS.length]; }

    // ---- 選手紹介：ここまでの戦績（ラウンドごとに正解した問題・勝ち抜けた問題） ----
    // liveLog: 押した記録（quiz_press_log）。組に保存された g.log が無いときに使う
    function history(t, eid, uptoRi, liveLog) {
        const e = t.entries.find(x => x.id === eid); if (!e) return [];
        const out = []; const pr = paperRanks(t); let first = true;
        for (let k = 0; k < Math.min(uptoRi, t.rounds.length); k++) {
            const r = t.rounds[k], g = r.groups.find(x => x.members.includes(eid));
            if (!g) {
                if (first && (e.startRound || 0) > k && e.paper != null) { out.push({ kind: 'paper', round: r.name, rank: pr[eid] || null, score: e.paper, seed: true }); first = false; }
                continue;
            }
            first = false;
            const log = (g.log && g.log.length ? g.log : (liveLog || []).filter(x => x.gid === g.id)).filter(x => x.eid === eid);
            const ok = log.filter(x => x.type === 'o'), ng = log.filter(x => x.type === 'x');
            const adv = isAdv(g, eid, r.advance), res = (g.res || {})[eid] || {};
            const corrects = ok.map(x => ({ q: x.q || null, qText: x.qText || '', aText: x.aText || '' }));
            out.push({ kind: 'match', round: r.name, ri: k, group: g.name, rule: ruleLabel(groupRule(r, g)), rank: res.rank || 0, adv, done: g.status === 'done', ex: !!r.ex,
                o: ok.length, x: ng.length, corrects, win: adv && corrects.length ? corrects[corrects.length - 1] : null });
        }
        return out;
    }
    function introSlides(t, ri, gid, liveLog) {
        const r = t.rounds[ri]; const g = r && r.groups.find(x => x.id === gid); if (!g) return null;
        const pr = paperRanks(t);
        const players = g.members.map(id => t.entries.find(e => e.id === id)).filter(Boolean).map(e => ({
            id: e.id, name: e.name, affiliation: e.affiliation, grade: e.grade, members: e.members || '', paper: e.paper, paperRank: pr[e.id] || null, hist: history(t, e.id, ri, liveLog)
        }));
        return { round: r.name, group: g.name, rule: ruleLabel(groupRule(r, g)), advance: r.advance, title: t.name || '', players };
    }

    const api = { history, introSlides, KEY, TEAM_KEY, sampleTeam, TEAM_RULE_TYPES, setKey(k) { KEY = k; api.KEY = k; }, COLORS, RULE_TYPES, parsePlan, z2h, csvRows, parseQuestions, splitQuestionsByGroup, pickSet, pickedGroup, capacity, newRule, ruleLabel, ensure, groupRule, sample, blank, load, save, newEntry, newRound, parseEntries, paperRanks, seedOrder, isAdv, advancers, participants, makeGroups, roundDone, standings, colorFor, byPaper, uid };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TournamentCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
