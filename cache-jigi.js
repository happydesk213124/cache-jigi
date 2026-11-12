//@name cache-jigi
//@display-name 캐시지기 · 암시적 캐시 최적화
//@api 3.0
//@version 1.0.0
//@update-url https://raw.githubusercontent.com/happydesk213124/cache-jigi/main/cache-jigi.js
//@link https://github.com/happydesk213124/cache-jigi GitHub

// 캐시지기: 모델에 보내는 요청을 "지난번 요청 + 뒤에만 덧붙임" 모양으로 정리해서
// Claude·Gemini·OpenAI·DeepSeek의 프롬프트 캐시가 대화 대부분을 다시 쓰게 만듭니다.
// 실제 채팅 기록은 건드리지 않고, 보내는 요청만 바꿉니다.

(async function () {
    'use strict';

    // =====================================================================
    // 0. 환경
    // =====================================================================
    const TEST = (typeof globalThis !== 'undefined' && globalThis.__CACHEJIGI_TEST__) || null;
    const API = TEST ? TEST.api
        : (typeof Risuai !== 'undefined' ? Risuai
            : (typeof risuai !== 'undefined' ? risuai : null));
    if (!API) {
        console.warn('[캐시지기] RisuAI 플러그인 API(3.0)를 찾지 못해 시작하지 않습니다.');
        return;
    }

    const VERSION = '1.0.0';
    const TAG = '[캐시지기]';
    const now = () => (TEST && TEST.now ? TEST.now() : Date.now());
    const RETRY_WINDOW_MS = 10 * 60 * 1000;
    const USAGE_WINDOW_MS = 5 * 60 * 1000;
    const MAX_STATS = 40;
    const MAX_EVENTS = 24;
    const MAX_CHATS = 40;
    const STABLE_TURNS = 2;          // 새 항목이 몇 턴 연속 같아야 장부에 고정할지
    const STALE_CAP_CHARS = 12000;   // 꺼진 채 남아 있는 글이 이만큼(또는 요청의 8%) 넘으면 다음 턴에 한 번 정리
    const STALE_CAP_RATIO = 0.08;
    const TAIL_STALE_MS = 30000;     // 맨 뒤 처리기가 이 시간 안에 안 불리면 실패로 봄
    const BIG_INSERT_CHARS = 4000;   // 최대 모드에서 이보다 긴 대화 사이 삽입은 꼬리 대신 장부로
    const TRAIL_MOVE_CHARS = 1000;   // 대화 기록과 마지막 입력 사이에 낀 프리셋 글 중 이보다 긴 것은 대화 앞으로
    const FLOAT_DEPTH = 6;           // 끝에서 이만큼 안쪽의 삽입은 매 턴 자리를 옮기는 것으로 봄

    // =====================================================================
    // 1. 설정
    // =====================================================================
    // 모드별 동작. 안전: 대화 자르기·캐시 지점만 / 균형: 바뀌는 것만 뒤로 / 최대: 깊이 삽입까지 뒤로
    const MODE_PRESETS = {
        safe: { head: false, ledger: false, moveInner: false, freeze: false },
        balanced: { head: true, ledger: true, moveInner: false, freeze: true },
        max: { head: true, ledger: true, moveInner: true, freeze: true },
    };
    const DEFAULT_CONFIG = {
        enabled: true,
        mode: 'max',
        cutRatio: 0.4,          // 정리 턴에 덜어낼 대화 비율
        keepRemoved: true,      // 꺼진 로어북 등은 다음 정리 턴까지 유지
        freeze: 'on',           // 과거 메시지 동결: auto(모드 따라) | on | off
        breakpoints: 'off',     // Claude 캐시 지점: auto | keep | off (기본은 끔: 오픈라우터 Gemini에서는 마지막 지점이 암시적 캐시를 방해할 수 있음)
        log: 'summary',         // 콘솔 로그: off | summary | verbose
    };
    const LABELS = {
        ko: {
            ph: '⟨→ 최신 정보⟩',
            latest: '[최신 정보] 위에서 "⟨→ 최신 정보⟩"로 표시한 자리의 지금 내용입니다.',
        },
        en: {
            ph: '⟨→ latest⟩',
            latest: '[Latest values] Current content of the places marked "⟨→ latest⟩" above.',
        },
    };

    let config = { ...DEFAULT_CONFIG };
    let configVersion = 0;

    function effective(cfg) {
        const preset = MODE_PRESETS[cfg.mode] || MODE_PRESETS.balanced;
        const freeze = cfg.freeze === 'on' ? true : cfg.freeze === 'off' ? false : preset.freeze;
        return { ...preset, freeze };
    }

    async function loadConfig() {
        try {
            const saved = await API.pluginStorage.getItem('cache-jigi:config');
            if (saved && typeof saved === 'object') {
                // 예전 버전에서 저장한, 지금은 없는 설정은 버림
                const known = Object.keys(DEFAULT_CONFIG).filter((k) => k in saved).map((k) => [k, saved[k]]);
                config = { ...DEFAULT_CONFIG, ...Object.fromEntries(known) };
            }
        } catch (_) { /* 저장소를 못 쓰면 기본값 */ }
        configVersion++;
        return config;
    }

    async function saveConfig(patch) {
        config = { ...config, ...patch };
        configVersion++;
        inflight = null;
        try { await API.pluginStorage.setItem('cache-jigi:config', config); } catch (e) { warn('설정 저장 실패', e); }
    }

    // =====================================================================
    // 2. 작은 도구들
    // =====================================================================
    function hash(text) { // cyrb53
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }
    const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
    function mmSig(m) {
        const mm = m && m.multimodals;
        if (!Array.isArray(mm) || !mm.length) return '';
        return mm.map((x) => `${(x && x.type) || '?'}:${x && x.base64 ? x.base64.length : 0}`).join(',');
    }
    const msgKey = (m) => hash(`${m.role || ''}\u0001${str(m.content)}\u0001${mmSig(m)}`);
    const msgLen = (m) => str(m.content).length + (m.multimodals ? 200 : 0);
    const squash = (v) => str(v).replace(/\s+/g, '');
    function clone(m) {
        const c = { ...m };
        if (Array.isArray(m.multimodals)) c.multimodals = m.multimodals.map((x) => ({ ...x }));
        if (Array.isArray(m.attr)) c.attr = m.attr.slice();
        if (Array.isArray(m.thoughts)) c.thoughts = m.thoughts.slice();
        return c;
    }
    function log(...args) { if (config.log !== 'off') console.log(TAG, ...args); }
    function vlog(...args) { if (config.log === 'verbose') console.log(TAG, ...args); }
    function warn(...args) { console.warn(TAG, ...args); }

    // Risu가 붙이는 메시지 표시: 대화는 memo = 채팅 ID, 나머지는 아래 이름들
    const NON_CHAT_MEMOS = new Set(['NewChat', 'NewChatExample', 'supaMemory', 'hypaMemory', 'supaPrompt']);
    const MEMORY_MEMOS = new Set(['supaMemory', 'hypaMemory', 'supaPrompt']);
    const isChatMemo = (m) => !!m && typeof m.memo === 'string' && m.memo.length > 0 && !NON_CHAT_MEMOS.has(m.memo);
    const isMemory = (m) => !!m && MEMORY_MEMOS.has(m.memo);
    const isExample = (m) => !!m && (m.name === 'example_user' || m.name === 'example_assistant' || m.memo === 'NewChatExample');

    // 두 목록의 최장 공통 부분열 (짝 지은 위치 목록). 앞뒤 공통 부분은 먼저 떼고 가운데만 비교
    function lcsPairs(a, b) {
        const n = a.length, m = b.length;
        if (!n || !m) return [];
        let pre = 0;
        while (pre < n && pre < m && a[pre] === b[pre]) pre++;
        let suf = 0;
        while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
        const pairs = [];
        for (let i = 0; i < pre; i++) pairs.push([i, i]);
        const an = n - pre - suf, bm = m - pre - suf;
        if (an > 0 && bm > 0 && an * bm <= 4000000) {
            const w = bm + 1;
            const dp = new Uint16Array((an + 1) * w);
            for (let i = an - 1; i >= 0; i--) {
                for (let j = bm - 1; j >= 0; j--) {
                    dp[i * w + j] = a[pre + i] === b[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
                }
            }
            let i = 0, j = 0;
            while (i < an && j < bm) {
                if (a[pre + i] === b[pre + j]) { pairs.push([pre + i, pre + j]); i++; j++; }
                else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
                else j++;
            }
        }
        for (let k = suf; k >= 1; k--) pairs.push([n - k, m - k]);
        return pairs;
    }

    // 줄 단위 비교: 같은 개수로 바뀐 줄만 짝지음. 개수가 다르면 큰 변경
    function lineDiff(oldText, newText) {
        const a = oldText.split('\n'), b = newText.split('\n');
        const pairs = lcsPairs(a, b);
        const changed = []; let unbalanced = false;
        let pa = -1, pb = -1;
        for (const [x, y] of [...pairs, [a.length, b.length]]) {
            const da = x - pa - 1, db = y - pb - 1;
            if (da !== db) unbalanced = true;
            else for (let k = 1; k <= da; k++) changed.push([a[pa + k], b[pb + k]]);
            pa = x; pb = y;
        }
        return { changed, unbalanced, lines: a.length };
    }

    // "현재 시각: 14:30" / "현재 시각: 14:45" → "현재 시각: " 처럼 값 앞까지만 고정 부분으로 봄
    function rulePrefix(a, b) {
        let i = 0;
        const n = Math.min(a.length, b.length);
        while (i < n && a[i] === b[i]) i++;
        if (i === 0) return null;
        let p = a.slice(0, i);
        const colon = p.search(/[:：=]/);
        if (colon >= 0) {
            let j = colon + 1;
            while (j < p.length && p[j] === ' ') j++;
            p = p.slice(0, j);
        } else {
            const m = p.match(/^[\s\S]*[\s\-|>\])]/);
            if (!m) return null;
            p = m[0];
        }
        if (p.trim().length < 2 || p.length >= Math.max(a.length, b.length)) return null;
        return p;
    }

    const lineHashes = (text) => {
        const set = new Set();
        for (const line of text.split('\n')) { const t = line.trim(); if (t) set.add(hash(t)); }
        return set;
    };
    // 지문 sig의 줄 가운데 set에 들어 있는 비율
    function contained(sig, set) {
        if (!sig || !sig.length) return 0;
        let hit = 0;
        for (const h of sig) if (set.has(h)) hit++;
        return hit / sig.length;
    }
    function jaccard(a, b) {
        if (!a.size && !b.size) return 1;
        let inter = 0;
        for (const x of a) if (b.has(x)) inter++;
        return inter / (a.size + b.size - inter);
    }

    // =====================================================================
    // 3. 요청 나누기: 머리 / 대화 기록 / 최신 입력 / 꼬리
    // =====================================================================
    function segment(msgs) {
        const n = msgs.length;
        let first = -1, last = -1;
        for (let i = 0; i < n; i++) if (isChatMemo(msgs[i])) { if (first < 0) first = i; last = i; }
        if (last < 0) return null;
        const nc = msgs.findIndex((m) => m && m.memo === 'NewChat');
        const from = (nc >= 0 && nc < first) ? nc + 1 : first;
        const chatLike = (i) => {
            const m = msgs[i];
            if (!m) return false;
            if (isChatMemo(m)) return true;
            if (i < from || i > last || isMemory(m) || isExample(m)) return false;
            return m.role === 'user' || m.role === 'assistant';
        };
        let L = -1; // 최신 입력 = 대화 안의 마지막 user 메시지 (그 뒤에 지시문이 붙어도 됨)
        for (let i = last; i >= from; i--) if (chatLike(i) && msgs[i].role === 'user') { L = i; break; }
        const head = [], hist = [], latest = [], post = [];
        for (let i = 0; i < n; i++) {
            const m = msgs[i];
            if (!m || typeof m !== 'object') continue;
            if (i < from) head.push({ i, m });
            else if (i > last) post.push({ i, m });
            else if (L >= 0 && i >= L) latest.push({ i, m });
            else if (isMemory(m)) head.push({ i, m });
            else hist.push({ i, m, chat: chatLike(i) });
        }
        return { head, hist, latest, post, L, last };
    }

    // =====================================================================
    // 4. 채팅방별 상태
    // =====================================================================
    function newState() {
        return {
            v: 1, ver: 2, turn: 0, epoch: 0,
            anchor: null,          // 남긴 대화의 첫 메시지 ID
            lang: null,            // 꼬리 안내문 언어 (채팅마다 한 번 정함)
            head: null,            // 고정 머리 [{k, role, content, name, memo, mod, lastMod}]
            ledger: [],            // 장부 [{after, k, role, content, name, turn}]
            pending: {},           // 장부 후보 {k: {streak, last, ...}}
            rules: [],             // 매번 바뀌는 줄 규칙 [{p, s:[줄 지문], role}]
            vol: [],               // 매번 크게 바뀌는 항목 [{role, s:[줄 지문]}]
            prevFront: null, prevExamples: -1, prevNewChat: false,
            bpPrev: null, lastTurnKey: null,
            prevOutSig: null, prevInSig: null,
            stats: [], events: [],
            forceRebuild: false, forceRefresh: false,
            pruneNext: false,      // 꺼진 채 남은 글이 많아서 다음 턴에 정리하기로 함
            mk: 0,                 // "자꾸 바뀌는 자리" 표시 번호
            seen: [],              // 최근 대화 메시지 ID (다른 채팅과 섞이지 않게 확인)
            prevPost: null, postVolatile: false, // 맨 뒤 지시문이 턴마다 바뀌는지
            lastSize: 0, keptCount: 0,
        };
    }
    const memStates = new Map();   // chatKey → 상태
    const frozenMem = new Map();   // chatKey → Map(채팅 ID → {h, content, r}) (이 세션만)
    let localStore = null;

    async function getStore() {
        if (localStore) return localStore;
        try { localStore = await API.getLocalPluginStorage(); } catch (_) { localStore = null; }
        return localStore;
    }

    async function loadState(key) {
        if (memStates.has(key)) return memStates.get(key);
        let st = null;
        try {
            const s = await getStore();
            const saved = s ? await s.getItem('cache-jigi:st:' + key) : null;
            if (saved && typeof saved === 'object' && saved.v === 1) {
                st = { ...newState(), ...saved };
                if (saved.ver !== 2) {
                    st.ver = 2;
                    st.vol = []; st.ledger = []; st.pending = {};
                    st.head = null; st.prevOutSig = null; st.prevStableEnd = null;
                    pushEvent(st, 'rebuild', '새 버전으로 바뀌어서 이 채팅의 학습을 한 번 새로 시작했어요');
                }
            }
        } catch (_) { /* 새로 시작 */ }
        if (!st) st = newState();
        memStates.set(key, st);
        return st;
    }

    let saveChain = Promise.resolve();
    function saveState(key, st) {
        const snapshot = JSON.parse(JSON.stringify(st));
        saveChain = saveChain.then(async () => {
            const s = await getStore();
            if (!s) return;
            await s.setItem('cache-jigi:st:' + key, snapshot);
            const index = (await s.getItem('cache-jigi:index')) || [];
            const next = [{ key, at: now() }, ...index.filter((x) => x && x.key !== key)];
            for (const old of next.slice(MAX_CHATS)) await s.removeItem('cache-jigi:st:' + old.key);
            await s.setItem('cache-jigi:index', next.slice(0, MAX_CHATS));
        }).catch((e) => vlog('상태 저장 실패', e));
        return saveChain;
    }

    async function resetState(key) {
        memStates.delete(key);
        frozenMem.delete(key);
        inflight = null;
        try { const s = await getStore(); if (s) await s.removeItem('cache-jigi:st:' + key); } catch (_) { /* 무시 */ }
    }

    function pushEvent(st, kind, text) {
        const last = st.events[0];
        if (last && last.kind === kind && last.text === text && now() - last.at < 60000) return;
        st.events.unshift({ at: now(), kind, text });
        if (st.events.length > MAX_EVENTS) st.events.length = MAX_EVENTS;
    }

    // 지금 채팅방 열쇠 (캐릭터 순번 + 채팅 ID)
    const chatKeyCache = new Map();
    async function getChatContext() {
        let ci = null, chi = null;
        try { ci = await API.getCurrentCharacterIndex(); } catch (_) { /* 무시 */ }
        try { chi = await API.getCurrentChatIndex(); } catch (_) { /* 무시 */ }
        if (typeof ci !== 'number' || typeof chi !== 'number') return { key: 'default', ci, chi };
        const slot = `${ci}#${chi}`;
        let key = chatKeyCache.get(slot);
        if (!key) {
            try {
                const chat = await API.getChatFromIndex(ci, chi);
                key = chat && chat.id ? `${ci}:${chat.id}` : slot;
            } catch (_) { key = slot; }
            chatKeyCache.set(slot, key);
        }
        return { key, ci, chi };
    }

    // =====================================================================
    // 5. 대화 기록: 앵커(시작점)와 정리 턴, 과거 메시지 동결
    // =====================================================================
    function pickAnchor(items, ratio) {
        const total = items.reduce((s, x) => s + msgLen(x.m), 0);
        const target = total * ratio;
        let acc = 0, idx = 0;
        while (idx < items.length - 4 && acc < target) { acc += msgLen(items[idx].m); idx++; }
        // 가능하면 user 메시지에서 시작
        for (let k = 0; k < 2 && idx < items.length - 4 && items[idx].m.role !== 'user'; k++) idx++;
        return idx;
    }

    async function processHistory(seg, st, eff, cfg, ctx, ev, opts) {
        const items = [];
        const innerAfter = new Map(); // 앞 대화 ID('' = 맨 앞) → 끼어 있던 항목들
        let prevId = '';
        for (const it of seg.hist) {
            if (it.chat) {
                const id = isChatMemo(it.m) ? it.m.memo : 'h:' + msgKey(it.m);
                items.push({ id, m: it.m });
                prevId = id;
            } else {
                if (!innerAfter.has(prevId)) innerAfter.set(prevId, []);
                innerAfter.get(prevId).push(it.m);
            }
        }
        const ids = items.map((x) => x.id);
        const exCount = seg.head.filter((h) => isExample(h.m)).length;
        const hasNewChat = seg.head.some((h) => h.m.memo === 'NewChat');
        const usesMemory = seg.head.some((h) => isMemory(h.m));
        const front = items.length ? items[0].id : null;
        // Risu가 오래된 것부터 잘라내기 시작했는지
        const trimming = (st.prevExamples > exCount)
            || (st.prevNewChat && !hasNewChat)
            || (!!st.prevFront && !!front && st.prevFront !== front && !ids.includes(st.prevFront));

        let anchorIdx = st.anchor ? ids.indexOf(st.anchor) : -1;
        let cut = false;
        // 지난번에 남긴 앞쪽 메시지 중 몇 개가 이번에 사라졌는지: 많으면 Risu 메모리가 덩어리로 요약한 것
        const lost = (st.prevKeptHead || []).filter((id) => !ids.includes(id)).length;
        const chunked = lost >= 6;
        if (!items.length) anchorIdx = 0;
        else if (anchorIdx < 0) {
            if (st.anchor && trimming && !chunked) {
                anchorIdx = pickAnchor(items, cfg.cutRatio);
                cut = true;
                pushEvent(st, 'cut', `정리 턴: 오래된 대화 ${anchorIdx}개를 한 번에 정리했어요 (다음 정리까지 여유 확보)`);
            } else {
                anchorIdx = 0;
                if (st.anchor) {
                    cut = true;
                    pushEvent(st, 'cut', chunked
                        ? 'Risu가 오래된 대화를 한꺼번에 덜어내서(요약 등) 시작점을 다시 잡았어요'
                        : '대화 시작 메시지가 바뀌어서 시작점을 다시 잡았어요');
                }
            }
        } else if ((trimming && anchorIdx === 0) || opts.forceCut) {
            const before = anchorIdx;
            anchorIdx = Math.max(anchorIdx, pickAnchor(items, cfg.cutRatio));
            cut = anchorIdx !== before || cut;
            if (cut) pushEvent(st, 'cut', `정리 턴: 오래된 대화 ${anchorIdx}개를 한 번에 정리했어요 (다음 정리까지 여유 확보)`);
        }
        if (items.length) st.anchor = items[anchorIdx].id;
        if (cut) {
            st.epoch++;
            ev.cut = true;
        }

        // 꺼졌거나 내용이 바뀐 장부 항목은 정리 턴에 뺌 (대화 구간은 어차피 캐시가 새로 시작됨)
        if (cut || ev.prune || !cfg.keepRemoved) {
            const before = st.ledger.length;
            st.ledger = st.ledger.filter((n) => opts.present.has(n.k));
            if (st.ledger.length < before) pushEvent(st, 'ledger', `꺼졌거나 내용이 바뀐 항목 ${before - st.ledger.length}개를 장부에서 뺐어요`);
        }

        const kept = items.slice(anchorIdx);
        const keptIds = new Set(kept.map((x) => x.id));
        const notesAfter = new Map();
        const orphanNotes = [];
        for (const n of (eff.ledger ? st.ledger : [])) {
            if (n.after && keptIds.has(n.after)) {
                if (!notesAfter.has(n.after)) notesAfter.set(n.after, []);
                notesAfter.get(n.after).push(n);
            } else orphanNotes.push(n);
        }
        // 잘려 나간 대화 뒤에 끼어 있던 항목은 남긴 대화 맨 앞으로
        const orphanInner = [];
        for (const [after, list] of innerAfter) if (after === '' || !keptIds.has(after)) orphanInner.push(...list);

        const out = [], ids2 = [], secs = [], inner = [];
        const pushInner = (list) => {
            for (const m of list) {
                if (eff.moveInner) inner.push({ i: m.__i, m: clone(m) });
                else { out.push(clone(m)); ids2.push(null); secs.push('inner'); }
            }
        };
        const pushNote = (n) => {
            const msg = { role: n.role, content: n.content };
            if (n.name) msg.name = n.name;
            out.push(msg); ids2.push('note:' + n.k); secs.push('note');
        };

        let frozen = frozenMem.get(ctx.key);
        if (!frozen) { frozen = new Map(); frozenMem.set(ctx.key, frozen); }
        // 정리 턴에는 어차피 기록 캐시가 새로 시작되므로, 그동안 미뤄 둔 글자 변화(정규식 등)를 한 번에 반영
        if (cut || st.forceRefresh) frozen.clear();
        st.forceRefresh = false;
        let rawMap = null, rawTried = false;
        const rawHashOf = async (id) => {
            if (id.startsWith('h:')) return null;
            if (!rawTried) {
                rawTried = true;
                try {
                    const chat = await API.getChatFromIndex(ctx.ci, ctx.chi);
                    rawMap = new Map();
                    for (const msg of (chat && chat.message) || []) {
                        if (msg && msg.chatId) rawMap.set(msg.chatId, hash(str(msg.data)));
                    }
                } catch (_) { rawMap = null; }
            }
            return rawMap ? (rawMap.get(id) || null) : null;
        };

        pushInner(orphanInner);
        for (let x = 0; x < kept.length; x++) {
            const { id, m } = kept[x];
            let msg = clone(m);
            if (eff.freeze) {
                const h = msgKey(msg);
                const f = frozen.get(id);
                if (!f) frozen.set(id, { h, content: msg.content, r: await rawHashOf(id) });
                else if (f.h !== h) {
                    const r = await rawHashOf(id);
                    // 원문이 그대로이거나(정규식·CBS 때문) 빈칸만 달라졌으면(이미지 토큰 삽입 등) 처음 글 유지
                    if ((r && f.r && r === f.r) || squash(f.content) === squash(msg.content)) {
                        msg.content = f.content;
                        if (r) f.r = r;
                        ev.frozenFix = (ev.frozenFix || 0) + 1;
                    } else {
                        frozen.set(id, { h, content: msg.content, r });
                        if (r && f.r) ev.edited = true;
                    }
                }
            }
            out.push(msg); ids2.push(id); secs.push('hist');
            if (x === 0) for (const n of orphanNotes) pushNote(n);
            if (innerAfter.has(id)) pushInner(innerAfter.get(id));
            if (notesAfter.has(id)) for (const n of notesAfter.get(id)) pushNote(n);
        }
        if (!kept.length) for (const n of orphanNotes) pushNote(n);
        // 동결 목록 정리: 남긴 대화만
        for (const k of [...frozen.keys()]) if (!keptIds.has(k)) frozen.delete(k);

        st.prevFront = front;
        st.prevExamples = exCount;
        st.prevNewChat = hasNewChat;
        st.prevKeptHead = kept.slice(0, 12).map((x) => x.id);
        st.keptCount = kept.length;
        // 장부 항목을 붙일 자리: 진짜 대화 메시지 뒤. 프리셋 머리글("# User's input" 같은 user 글)은 매 턴 끝에 있어서 거기 붙이면 매 턴 제값
        let lastHistId = null;
        for (let x = kept.length - 1; x >= 0; x--) if (!kept[x].id.startsWith('h:')) { lastHistId = kept[x].id; break; }
        if (!lastHistId && kept.length) lastHistId = kept[kept.length - 1].id;
        return { out, ids: ids2, secs, inner, lastHistId, trimming, usesMemory, cut };
    }

    // =====================================================================
    // 6. 머리: 고정 부분은 그대로, 바뀌는 줄·항목은 꼬리로, 새 항목은 장부로
    // =====================================================================
    function applyRules(content, role, rules, ph) {
        if (!rules.length || !content) return { text: content, vals: [] };
        const set = lineHashes(content);
        const tiny = set.size <= 2;
        const usable = rules.filter((r) => r.role === role && (r.s.length ? contained(r.s, set) >= 0.4 : tiny));
        if (!usable.length) return { text: content, vals: [] };
        const lines = content.split('\n');
        const vals = [];
        let changed = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const r of usable) {
                if (line.startsWith(r.p) && line !== r.p + ph) {
                    vals.push(line);
                    lines[i] = r.p + ph;
                    changed = true;
                    break;
                }
            }
        }
        return { text: changed ? lines.join('\n') : content, vals };
    }

    function formsOf(items, st, ph) {
        return items.map(({ m }) => {
            const f = applyRules(str(m.content), m.role, st.rules, ph);
            return {
                m, text: f.text, vals: f.vals,
                k: hash(`${m.role}\u0001${f.text}\u0001${mmSig(m)}`),
                set: lineHashes(f.text),
            };
        });
    }
    const toSnap = (c) => {
        const s = { k: c.k, role: c.m.role, content: c.text, mod: 0, lastMod: -99 };
        if (c.m.name) s.name = c.m.name;
        if (c.m.memo) s.memo = c.m.memo;
        if (c.m.multimodals) s.multimodals = c.m.multimodals;
        return s;
    };

    function similarity(s, sSet, c) {
        // Risu 메모리(요약)는 내용이 크게 바뀌어도 같은 자리로 봄
        if (s.memo && s.memo === c.m.memo && MEMORY_MEMOS.has(s.memo)) return 1;
        if (s.sk) { // 뼈대 항목: 뼈대의 줄이 지금 글에 얼마나 들어 있는지
            let hit = 0;
            for (const h of sSet) if (c.set.has(h)) hit++;
            return sSet.size ? hit / sSet.size : 0;
        }
        const sText = s.content;
        const sl = sText.split('\n').filter((l) => l.trim()), cl = c.text.split('\n').filter((l) => l.trim());
        if (sl.length <= 2 && cl.length <= 2) return rulePrefix(sl[0] || '', cl[0] || '') ? 0.6 : 0;
        return jaccard(sSet, c.set);
    }
    const isVolatile = (st, c) => st.vol.some((v) => v.role === c.m.role
        && ((v.memo && v.memo === c.m.memo) || contained(v.s, c.set) >= 0.5));

    function alignHead(S, C) {
        const pairs = lcsPairs(S.map((s) => s.k), C.map((c) => c.k));
        const usedS = new Set(pairs.map((p) => p[0])), usedC = new Set(pairs.map((p) => p[1]));
        const modified = [];
        let ps = -1, pc = -1;
        for (const [a, b] of [...pairs, [S.length, C.length]]) {
            for (let ci = pc + 1; ci < b; ci++) {
                let best = -1, bestScore = 0;
                for (let si = ps + 1; si < a; si++) {
                    if (usedS.has(si) || S[si].role !== C[ci].m.role) continue;
                    const sc = similarity(S[si], S[si]._set || (S[si]._set = lineHashes(S[si].content)), C[ci]);
                    if (sc > bestScore) { bestScore = sc; best = si; }
                }
                if (best >= 0 && bestScore >= 0.5) { modified.push([best, ci]); usedS.add(best); usedC.add(ci); }
            }
            ps = a; pc = b;
        }
        const removed = [], added = [];
        for (let i = 0; i < S.length; i++) if (!usedS.has(i)) removed.push(i);
        for (let i = 0; i < C.length; i++) if (!usedC.has(i)) added.push(i);
        return { pairs, modified, removed, added };
    }

    function learnRules(s, c, st) {
        const d = lineDiff(s.content, c.text);
        if (d.unbalanced || !d.changed.length) return 0;
        if (d.changed.length > Math.max(2, Math.ceil(d.lines * 0.3))) return 0;
        const found = [];
        for (const [a, b] of d.changed) {
            const p = rulePrefix(a, b);
            if (!p) return 0;
            found.push(p);
        }
        const stable = [...lineHashes(c.text)].slice(0, 60);
        let added = 0;
        for (const p of found) {
            if (st.rules.some((r) => r.p === p && r.role === c.m.role)) continue;
            st.rules.push({ p, role: c.m.role, s: d.lines <= 2 ? [] : stable });
            added++;
        }
        if (st.rules.length > 80) st.rules.splice(0, st.rules.length - 80);
        return added;
    }

    // ---- 뼈대: 긴 항목 안에서 자꾸 바뀌는 부분만 표시(⟨→ 최신 정보 #n⟩)로 바꾸고, 나머지 줄은 그대로 고정
    const MARK_RE = /^⟨→ .* #(\d+)⟩$/;
    const markLine = (ph, id) => `${ph.slice(0, -1)} #${id}⟩`;
    const markLabel = (ph, id) => `⟨${ph.slice(3, -1)} #${id}⟩`;
    const solid = (line) => !!line.trim() && !MARK_RE.test(line);

    // 뼈대 줄(sLines)과 지금 글(cLines)을 맞춰 봄. 빈 줄은 맞추는 기준에서 빼서 줄바꿈 개수 차이에 흔들리지 않게 함.
    // 돌려주는 값: lines(새 뼈대. 문자열 또는 {id} 표시), regions(표시 자리의 지금 내용), stable(그대로인 줄 수)
    function fitSkeleton(sLines, cLines, nextId) {
        const sIdx = [], cIdx = [];
        sLines.forEach((l, i) => { if (solid(l)) sIdx.push(i); });
        cLines.forEach((l, i) => { if (l.trim()) cIdx.push(i); });
        const pairs = lcsPairs(sIdx.map((i) => sLines[i]), cIdx.map((i) => cLines[i]));
        const lines = [], regions = [];
        let ps = 0, pc = 0;
        for (const [p, q] of [...pairs, [-1, -1]]) {
            const x = p < 0 ? sLines.length : sIdx[p], y = q < 0 ? cLines.length : cIdx[q];
            const keep = [];
            let id = 0, lost = false, spot = -1;
            for (let i = ps; i < x; i++) {
                const mk = MARK_RE.exec(sLines[i]);
                if (mk) { if (!id) { id = Number(mk[1]); keep.push({ id }); } }
                else if (!sLines[i].trim()) keep.push(sLines[i]);
                else { lost = true; if (spot < 0) spot = keep.length; }
            }
            const gap = cLines.slice(pc, y);
            while (gap.length && !gap[0].trim()) gap.shift();
            while (gap.length && !gap[gap.length - 1].trim()) gap.pop();
            if (!id && (lost || gap.length)) { id = nextId(); keep.splice(spot < 0 ? keep.length : spot, 0, { id }); }
            lines.push(...keep);
            if (id && gap.length) regions.push({ id, text: gap.join('\n') });
            if (x < sLines.length) lines.push(sLines[x]);
            ps = x + 1; pc = y + 1;
        }
        return { lines, regions, stable: pairs.length, sCount: sIdx.length, cCount: cIdx.length };
    }
    // 뼈대로 쓸 만큼 그대로인 줄이 많은지
    const fitOk = (r) => r.stable >= 3 && r.stable >= 0.5 * Math.max(1, Math.min(r.sCount, r.cCount));

    function processHead(seg, st, eff, cfg, ctx, ev, lastHistId) {
        const L = ctx.L;
        const res = { out: [], ids: [], vals: [], regs: [], toPre: [], promoted: [], absent: new Set() };
        if (!eff.head) {
            for (const { m } of seg.head) { res.out.push(clone(m)); res.ids.push('h:' + msgKey(m)); }
            return res;
        }
        const strip = (s) => { const o = { ...s }; delete o._set; return o; };
        const nextMark = () => { st.mk = (st.mk || 0) + 1; return st.mk; };
        const textOf = (lines) => lines.map((x) => (typeof x === 'string' ? x : markLine(L.ph, x.id))).join('\n');
        const setContent = (s, text) => { s.content = text; s.k = hash(`${s.role}\u0001${text}\u0001${mmSig(s)}`); delete s._set; };
        let C = formsOf(seg.head, st, L.ph);
        const rebuild = (why) => {
            const old = (st.head || []).filter((s) => s.sk);
            st.head = C.filter((c) => !isVolatile(st, c)).map(toSnap);
            // 이미 찾아 둔 "자꾸 바뀌는 자리"는 새 머리에도 이어 줌 (다시 배우느라 캐시를 깨지 않게)
            for (const o of old) {
                const oSet = lineHashes(o.content);
                let best = null, bestScore = 0.5;
                for (const s of st.head) {
                    if (s.sk || s.role !== o.role) continue;
                    const set = lineHashes(s.content);
                    let hit = 0;
                    for (const h of oSet) if (set.has(h)) hit++;
                    if (oSet.size && hit / oSet.size >= bestScore) { best = s; bestScore = hit / oSet.size; }
                }
                if (!best) continue;
                const r = fitSkeleton(o.content.split('\n'), best.content.split('\n'), nextMark);
                if (fitOk(r)) { setContent(best, textOf(r.lines)); best.sk = true; }
            }
            st.pending = {};
            st.forceRebuild = false;
            if (why) pushEvent(st, 'rebuild', why);
            ev.headChanged = true;
        };
        if (!st.head) rebuild('');
        else if (st.forceRebuild) rebuild('요청하신 대로 머리와 장부를 새로 정리했어요');

        let align = alignHead(st.head, C);
        for (let round = 0; round < 3 && align.modified.length; round++) {
            let learned = 0;
            for (const [si, ci] of align.modified) if (!st.head[si].sk) learned += learnRules(st.head[si], C[ci], st);
            if (!learned) break;
            for (const s of st.head) {
                const f = applyRules(s.content, s.role, st.rules, L.ph);
                if (f.text !== s.content) setContent(s, f.text);
            }
            C = formsOf(seg.head, st, L.ph);
            align = alignHead(st.head, C);
            ev.headChanged = true;
            pushEvent(st, 'learn', `매번 바뀌는 줄 ${learned}개를 찾아서 꼬리로 옮겼어요`);
        }

        const drop = new Set();
        const inHead = new Set(align.pairs.map((p) => p[1]));
        // 통째로 자꾸 바뀌는 항목 → 머리에서 빼고 매 턴 꼬리로
        const floatWhole = (si, c) => {
            st.vol.push({ role: c.m.role, memo: MEMORY_MEMOS.has(c.m.memo) ? c.m.memo : undefined, s: [...c.set].slice(0, 60) });
            if (st.vol.length > 30) st.vol.splice(0, st.vol.length - 30);
            drop.add(si);
            res.toPre.push({ i: c.m.__i, m: clone(c.m) });
            pushEvent(st, 'volatile', '매 턴 크게 바뀌는 항목을 찾아서 꼬리로 옮겼어요');
        };
        let newSpots = 0;
        for (const [si, ci] of align.modified) {
            const s = st.head[si], c = C[ci];
            const tryFit = () => { const r = fitSkeleton(s.content.split('\n'), c.text.split('\n'), nextMark); return fitOk(r) ? r : null; };
            if (s.sk) {
                const r = tryFit();
                if (r) {
                    const text = textOf(r.lines);
                    if (text !== s.content) {
                        // 뼈대가 또 줄어듦. 너무 잦으면 이 항목은 통째로 꼬리로
                        if (ctx.newTurn) { s.skc = (st.turn - (s.skt == null ? -99 : s.skt) <= 8) ? (s.skc || 0) + 1 : 1; s.skt = st.turn; }
                        ev.headChanged = true;
                        const small = s.content.length < Math.max(2000, (ctx.inChars || 0) * 0.03);
                        if (small && (s.skc || 0) >= 4) { floatWhole(si, c); continue; }
                        setContent(s, text);
                        newSpots++;
                    }
                    res.regs.push(...r.regions);
                    inHead.add(ci);
                    continue;
                }
            }
            if (ctx.newTurn) s.mod = (st.turn - s.lastMod <= 8) ? s.mod + 1 : 1;
            if (s.mod >= 2) {
                const r = s.sk ? null : tryFit();
                if (r) {
                    // 자꾸 바뀌는 항목이지만 대부분의 줄은 그대로 → 바뀌는 자리만 꼬리로
                    setContent(s, textOf(r.lines));
                    s.sk = true; s.skc = 1; s.skt = st.turn; s.lastMod = st.turn;
                    res.regs.push(...r.regions);
                    inHead.add(ci);
                    newSpots++;
                } else floatWhole(si, c);
            } else {
                // 처음 크게 바뀜 → 설정을 고친 것으로 보고 새 내용으로 교체 (캐시는 한 번 깨짐)
                Object.assign(s, toSnap(c), { mod: s.mod, lastMod: st.turn });
                delete s._set; delete s.sk; delete s.skc; delete s.skt;
                inHead.add(ci);
                pushEvent(st, 'edit', '머리 내용이 바뀌어서 새 내용으로 고정했어요');
            }
            ev.headChanged = true;
        }
        if (newSpots) pushEvent(st, 'learn', `긴 글 안에서 자꾸 바뀌는 부분 ${newSpots}곳을 찾아서 그 부분만 꼬리로 옮겼어요`);
        // 지금 안 켜져 있는 항목: 다음 정리 때까지는 그대로 보내고, 정리할 때 뺌
        const keptAbsent = new Set();
        let droppedAbsent = 0;
        for (const si of align.removed) {
            if (cfg.keepRemoved && !ev.cut && !ev.prune) keptAbsent.add(st.head[si]);
            else { drop.add(si); droppedAbsent++; ev.headChanged = true; }
        }
        if (droppedAbsent) pushEvent(st, 'ledger', `꺼진 항목 ${droppedAbsent}개를 머리에서 뺐어요`);
        if (drop.size) st.head = st.head.filter((_, i) => !drop.has(i));

        // 머리에 없는 새 항목: 바뀌는 항목이면 꼬리, 장부에 있으면 그대로, 아니면 후보 → 몇 턴 같으면 장부
        const seen = new Set();
        const curKeys = new Set(C.map((c) => c.k));
        const staleNotes = st.ledger.filter((n) => !curKeys.has(n.k));
        for (const ci of align.added) {
            const c = C[ci];
            if (isVolatile(st, c)) { res.toPre.push({ i: c.m.__i, m: clone(c.m) }); continue; }
            if (st.ledger.some((n) => n.k === c.k)) { inHead.add(ci); continue; }
            if (!eff.ledger) { res.toPre.push({ i: c.m.__i, m: clone(c.m) }); continue; }
            // 장부에 있는 항목의 새 버전: 옛 버전과 둘 다 쌓이지 않게 꼬리로 (옛 버전은 다음 정리 때 빠짐)
            if (staleNotes.some((n) => n.role === c.m.role && similarity(n, lineHashes(n.content), c) >= 0.5)) {
                res.toPre.push({ i: c.m.__i, m: clone(c.m) });
                continue;
            }
            let p = st.pending[c.k];
            if (!p) p = st.pending[c.k] = { k: c.k, streak: 0, last: -99 };
            if (ctx.newTurn && p.last !== st.turn) { p.streak = p.last === st.turn - 1 ? p.streak + 1 : 1; p.last = st.turn; }
            if (p.streak === 0) { p.streak = 1; p.last = st.turn; }
            seen.add(c.k);
            if (p.streak >= STABLE_TURNS) {
                const note = { after: lastHistId, k: c.k, role: c.m.role, content: c.text, turn: st.turn };
                if (c.m.name) note.name = c.m.name;
                st.ledger.push(note);
                res.promoted.push(note);
                delete st.pending[c.k];
                inHead.add(ci);
                ev.ledgerAdded = (ev.ledgerAdded || 0) + 1;
            } else {
                res.toPre.push({ i: c.m.__i, m: clone(c.m) });
            }
        }
        for (const k of Object.keys(st.pending)) if (!seen.has(k)) delete st.pending[k];
        if (ev.ledgerAdded) pushEvent(st, 'ledger', `새로 켜진 항목 ${ev.ledgerAdded}개를 장부에 고정했어요`);

        // 꺼진 채 남아 있는 글이 너무 많아지면 다음 턴에 한 번 정리 (대화가 예산에 안 차서 정리 턴이 안 오는 채팅용)
        const staleChars = [...keptAbsent].reduce((a, s) => a + s.content.length, 0)
            + staleNotes.reduce((a, n) => a + n.content.length, 0);
        st.pruneNext = staleChars > Math.max(STALE_CAP_CHARS, (ctx.inChars || 0) * STALE_CAP_RATIO);

        const cacheByKey = new Map();
        if (cfg.breakpoints === 'keep') for (const c of C) if (c.m.cachePoint && !cacheByKey.has(c.k)) cacheByKey.set(c.k, true);
        for (const s of st.head) {
            const msg = { role: s.role, content: s.content };
            if (s.name) msg.name = s.name;
            if (s.memo) msg.memo = s.memo;
            if (s.multimodals) msg.multimodals = s.multimodals;
            if (cacheByKey.has(s.k)) msg.cachePoint = true;
            if (keptAbsent.has(s)) res.absent.add(res.out.length);
            res.out.push(msg);
            res.ids.push('h:' + s.k);
        }
        // 머리·장부에 남은 항목의 바뀌는 줄 값은 꼬리로
        for (let i = 0; i < C.length; i++) if (inHead.has(i)) res.vals.push(...C[i].vals);
        st.head = st.head.map(strip);
        return res;
    }

    // =====================================================================
    // 7. Claude 캐시 지점 (cachePoint → Risu·Provider Manager가 cache_control로 바꿈)
    // =====================================================================
    function placeBreakpoints(out, ids, secs, st, cfg) {
        if (cfg.breakpoints === 'keep') return 0;
        for (const m of out) if (m.cachePoint) delete m.cachePoint;
        if (cfg.breakpoints === 'off') return 0;
        // Claude 변환: 맨 앞 system들은 system 문자열, 그 뒤 system은 user로 바뀌어 옆 user와 합쳐짐
        const mapped = [];
        let leading = true;
        for (const m of out) {
            if (leading && m.role === 'system') { mapped.push('sys'); continue; }
            leading = false;
            mapped.push(m.role === 'assistant' ? 'assistant' : 'user');
        }
        const stableEnd = secs.findIndex((s) => s === 'pre' || s === 'latest' || s === 'post');
        const end = stableEnd < 0 ? out.length : stableEnd;
        const ok = (i) => mapped[i] !== 'sys' && (i + 1 >= out.length || mapped[i + 1] !== mapped[i]) && i < end;
        const valid = [];
        for (let i = 0; i < end; i++) if (ok(i)) valid.push(i);
        if (!valid.length) return 0;
        const chosen = new Set();
        const last = valid[valid.length - 1];
        chosen.add(last);                                   // ③ 이번 턴 기록 끝
        if (st.bpPrev) {                                    // ② 지난 턴 기록 끝
            const i = ids.indexOf(st.bpPrev);
            if (i >= 0 && ok(i)) chosen.add(i);
        }
        // ① 머리 끝: 정리 턴에도 머리 캐시를 다시 쓸 수 있게 (머리에 자리가 없으면 첫 지점)
        const headValid = valid.filter((i) => secs[i] === 'head');
        chosen.add(headValid.length ? headValid[headValid.length - 1] : valid[0]);
        for (const i of chosen) out[i].cachePoint = true;
        st.bpPrev = ids[last] || null;
        return chosen.size;
    }

    // =====================================================================
    // 8. 진단: 지난 요청과 앞부분이 얼마나 같은지
    // =====================================================================
    const sigOf = (msgs) => msgs.map((m) => [msgKey(m), msgLen(m)]);
    function prefixCompare(prev, cur) {
        let total = 0;
        for (const [, len] of cur) total += len;
        if (!prev) return null;
        let common = 0, i = 0;
        for (; i < cur.length && i < prev.length; i++) {
            if (cur[i][0] !== prev[i][0]) break;
            common += cur[i][1];
        }
        return { ratio: total ? common / total : 1, diffAt: i < cur.length ? i : -1, total };
    }
    const SECTION_REASON = {
        head: '머리가 바뀜',
        hist: '대화 기록이 바뀜',
        inner: '대화 사이 삽입이 바뀜',
        note: '장부에 새 항목 추가',
        fixed: '맨 뒤 지시문이 바뀜',
        pre: '정상 (새 대화와 꼬리만 새로)',
        latest: '정상 (새 대화와 꼬리만 새로)',
        post: '정상 (새 대화와 꼬리만 새로)',
    };

    // =====================================================================
    // 9. 요청 처리 (beforeRequest, 메인 모델 요청만)
    // =====================================================================
    let inflight = null; // 같은 요청이 다시 들어올 때(재시도) 첫 시도와 똑같이 보내기 위한 기록
    let usageWait = null; // 응답의 실제 사용량을 붙일 통계 줄

    function detectLang(seg) {
        const text = seg.head.map((h) => str(h.m.content)).join('\n').slice(0, 20000);
        const ko = (text.match(/[가-힣]/g) || []).length;
        const en = (text.match(/[A-Za-z]/g) || []).length;
        return ko * 3 >= en ? 'ko' : 'en';
    }
    function labelsOf(st, seg) {
        if (!st.lang) st.lang = st.head ? 'ko' : detectLang(seg); // 예전 버전 머리는 한국어 표시로 만들어져 있음
        return LABELS[st.lang] || LABELS.ko;
    }

    // 고정 부분 밖의 system 글은 user로 보냄. 포켓리스 프리셋처럼 system을 위치와 상관없이
    // 전부 맨 앞으로 올리는 연결에서, 매 턴 바뀌는 글이 맨 앞으로 가 캐시를 깨지 않게 함
    const demote = (m) => ({ ...m, role: 'user', content: `system: ${str(m.content)}` });

    // user로 바꾼 글은 옆 user 메시지에 합침 (user가 연달아 나가지 않게)
    function foldDemoted({ out, ids, secs }, demoted) {
        for (let i = out.length - 1; i >= 0; i--) {
            const item = out[i];
            if (!demoted.has(item) || item.multimodals) continue;
            const next = out[i + 1], prev = out[i - 1];
            const mark = item.cachePoint ? { cachePoint: true } : {};
            let at;
            if (next && next.role === 'user') {
                at = i + 1;
                out[at] = { ...next, ...mark, content: `${item.content}\n\n${str(next.content)}` };
            } else if (prev && prev.role === 'user' && secs[i - 1] !== 'head') {
                at = i - 1;
                out[at] = { ...prev, ...mark, content: `${str(prev.content)}\n\n${item.content}` };
                if (demoted.has(prev)) demoted.add(out[at]);
            } else continue;
            if (secs[i] === 'inner' && secs[at] === 'hist') secs[at] = 'inner'; // 매 턴 자리를 옮기는 삽입이 붙은 메시지
            out.splice(i, 1); ids.splice(i, 1); secs.splice(i, 1);
        }
    }

    const isSubseq = (small, big) => {
        let i = 0;
        for (const x of big) if (i < small.length && x === small[i]) i++;
        return i === small.length;
    };

    // Risu는 요청이 실패하면 "이미 플러그인들이 바꾼 요청"을 다시 플러그인들에 넣어서 재시도함.
    // 그래서 (1) 처음 요청이 그대로 다시 오거나 (2) 우리가 내보낸 요청이 되돌아오거나
    // (3) 되돌아온 요청에 다른 플러그인이 몇 개 덧붙였으면, 새 턴으로 치지 않고 첫 시도와 똑같이 보냄
    function retryOf(chatKey, inKeys, inHash) {
        const f = inflight;
        if (!f || f.chat !== chatKey || now() - f.at > RETRY_WINDOW_MS || f.cfgVer !== configVersion) return null;
        if (inHash === f.inHash || inHash === f.outHash) return f;
        if (f.inHash !== f.outHash && inKeys.length - f.outKeys.length <= 4 && isSubseq(f.outKeys, inKeys)) return f;
        return null;
    }

    async function handle(input, cfg) {
        const t0 = now();
        let ctx = await getChatContext();
        const inSig = sigOf(input);
        const inKeys = inSig.map((x) => x[0]);
        const inHash = hash(inKeys.join());
        const again = retryOf(ctx.key, inKeys, inHash);
        if (again) {
            log('같은 요청이 다시 들어와서(재시도) 첫 시도와 똑같이 보냅니다');
            return again.out.map(clone);
        }
        input.forEach((m, i) => { if (m && typeof m === 'object') Object.defineProperty(m, '__i', { value: i, enumerable: false, configurable: true }); });
        const seg = segment(input);
        if (!seg) {
            vlog('대화가 없는 요청이라 그대로 보냅니다');
            return input;
        }
        let st = await loadState(ctx.key);
        // 채팅방 순번이 다른 채팅을 가리키게 됐으면(삭제·순서 바꿈) 진짜 채팅 ID로 다시 찾음
        const memoIds = input.filter(isChatMemo).map((m) => m.memo);
        if (Array.isArray(st.seen) && st.seen.length && memoIds.length >= 2 && !memoIds.some((id) => st.seen.includes(id))) {
            chatKeyCache.delete(`${ctx.ci}#${ctx.chi}`);
            const fresh = await getChatContext();
            if (fresh.key !== ctx.key) { ctx = fresh; st = await loadState(ctx.key); }
        }
        st.seen = memoIds.slice(-60);
        const eff = effective(cfg);
        const latestMsg = seg.L >= 0 ? input[seg.L] : null;
        const turnKey = latestMsg
            ? `${latestMsg.memo || ''}:${hash(str(latestMsg.content))}`
            : `x:${hash(str((input[seg.last] || {}).content))}`;
        const newTurn = turnKey !== st.lastTurnKey;
        if (newTurn) { st.turn++; st.lastTurnKey = turnKey; }
        ctx.newTurn = newTurn;
        ctx.inChars = inSig.reduce((s, x) => s + x[1], 0);
        // 꺼진 글 정리: 지난 턴에 "남은 게 너무 많다"고 표시해 뒀으면 이번에 뺌 (기록과 머리 양쪽에서 같은 턴에)
        const ev = { prune: !!st.pruneNext };
        st.pruneNext = false;
        // "지금 정리하기": 장부는 대화 기록을 만들기 전에 비워야 옛 항목이 이번 요청에 남지 않음
        if (st.forceRebuild && eff.head) { st.ledger = []; st.pending = {}; }
        else if (st.forceRebuild) st.forceRebuild = false;

        ctx.L = labelsOf(st, seg);
        // 최대 모드: 대화 사이의 긴 삽입은 매 턴 제값을 내지 않게 머리·장부 쪽 규칙으로 처리
        if (eff.moveInner) {
            seg.hist = seg.hist.filter((it) => {
                if (it.chat || msgLen(it.m) < BIG_INSERT_CHARS) return true;
                seg.head.push({ i: it.i, m: it.m });
                return false;
            });
        }
        // 균형·최대 모드: 대화 기록 끝과 마지막 입력 사이에 낀 긴 프리셋 글(규칙·로어북 등)은
        // 매 턴 새 대화에 밀려서 통째로 제값이 됨 → 대화 앞(머리)으로 옮겨서 캐시되게 함. 짧은 글은 제자리
        if (eff.head) {
            let lastChat = -1;
            for (let k = seg.hist.length - 1; k >= 0; k--) if (isChatMemo(seg.hist[k].m)) { lastChat = k; break; }
            if (lastChat >= 0) {
                const move = new Set(seg.hist.slice(lastChat + 1).filter((it) => msgLen(it.m) >= TRAIL_MOVE_CHARS));
                if (move.size) {
                    seg.hist = seg.hist.filter((it) => !move.has(it));
                    for (const it of move) seg.head.push({ i: it.i, m: it.m });
                }
            }
        }
        const present = new Set(formsOf(seg.head, st, ctx.L.ph).map((c) => c.k));
        let hist = await processHistory(seg, st, eff, cfg, ctx, ev, { present });
        const head = processHead(seg, st, eff, cfg, ctx, ev, hist.lastHistId);
        // 이번 턴에 장부에 오른 항목은 기록 끝(지난 AI 답장 바로 뒤)에 붙임
        for (const n of head.promoted) {
            const msg = { role: n.role, content: n.content };
            if (n.name) msg.name = n.name;
            hist.out.push(msg); hist.ids.push('note:' + n.k); hist.secs.push('note');
        }

        // 맨 뒤 지시문은 평소엔 system 그대로 두고, 턴마다 바뀌는 게 보이면 그때부터 user로 보냄
        if (eff.head) {
            const postKey = seg.post.filter((p) => p.m.role === 'system').map((p) => msgKey(p.m)).join();
            if (newTurn && st.prevPost != null && st.prevPost !== postKey) st.postVolatile = true;
            st.prevPost = postKey;
        }

        const L = ctx.L;
        const assemble = () => {
            const pre = [];
            // 꼬리 안내문: 머리에서 표시로 바꿔 둔 줄·자리의 지금 내용
            const fresh = [];
            if (head.vals.length) fresh.push(head.vals.join('\n'));
            for (const r of head.regs) fresh.push(`${markLabel(L.ph, r.id)}\n${r.text}`);
            if (fresh.length) pre.push({ i: -1, m: { role: 'system', content: `${L.latest}\n${fresh.join('\n')}` } });
            const items = [...head.toPre];
            if (eff.moveInner) items.push(...hist.inner);
            items.sort((a, b) => (a.i ?? 1e9) - (b.i ?? 1e9));
            for (const x of items) pre.push(x);
            const out = [], ids = [], secs = [];
            const demoted = new Set();
            const add = (m, id, sec, lower) => {
                let msg = m;
                if (lower && eff.head && m.role === 'system') {
                    msg = demote(m);
                    if (sec !== 'hist') demoted.add(msg);
                }
                out.push(msg); ids.push(id); secs.push(sec);
            };
            head.out.forEach((m, i) => add(m, head.ids[i], 'head'));
            hist.out.forEach((m, i) => add(m, hist.ids[i], hist.secs[i], true));
            for (const x of pre) add(clone(x.m), null, 'pre', true);
            for (const { m } of seg.latest) add(clone(m), null, 'latest', true);
            for (const { m } of seg.post) add(clone(m), null, 'post', st.postVolatile);
            foldDemoted({ out, ids, secs }, demoted);
            return { out, ids, secs };
        };
        let built = assemble();

        // 예산 보호: Risu가 자르고 있는데 우리가 더 커졌으면 지금 바로 정리
        const inChars = ctx.inChars;
        const outChars = () => built.out.reduce((s, m) => s + msgLen(m), 0);
        if (hist.trimming && !hist.cut && outChars() > inChars + Math.max(1500, inChars * 0.03)) {
            // 이번 턴 장부 항목은 이미 st.ledger에 들어 있어서 다시 만들 때 제자리에 들어감
            hist = await processHistory(seg, st, eff, cfg, ctx, ev, { forceCut: true, present });
            if (hist.cut && head.absent.size) {
                // 정리 턴이 됐으니 꺼진 항목도 지금 뺌
                const keep = (_, i) => !head.absent.has(i);
                st.head = st.head.filter(keep);
                head.out = head.out.filter(keep);
                head.ids = head.ids.filter(keep);
            }
            built = assemble();
            pushEvent(st, 'cut', '요청이 Risu 예산보다 커질 뻔해서 미리 정리했어요');
        }

        const bps = placeBreakpoints(built.out, built.ids, built.secs, st, cfg);

        // 진단: 지난 요청과 앞부분이 얼마나 같은지. 균형·최대 모드는 실제 본문 순서로 봄
        // (포켓리스 프리셋은 system 글을 전부 맨 앞으로 모으므로, 맨 뒤 system 글이 바뀌면 전체가 깨짐)
        const outKeys = built.out.map(msgKey);
        const order = [];
        if (eff.head) {
            built.out.forEach((m, i) => { if (m.role === 'system') order.push(i); });
            built.out.forEach((m, i) => { if (m.role !== 'system') order.push(i); });
        } else built.out.forEach((_, i) => order.push(i));
        const outSig = order.map((i) => [outKeys[i], msgLen(built.out[i])]);
        const wsecs = order.map((i) => (eff.head && built.secs[i] === 'post' && built.out[i].role === 'system' ? 'fixed' : built.secs[i]));
        const ours = prefixCompare(st.prevOutSig, outSig);
        const base = prefixCompare(st.prevInSig, inSig);
        if (ours) {
            // 지난 요청의 꼬리가 시작하던 자리 이후에서 달라졌으면 정상 (새 대화가 붙은 것)
            const normal = st.prevStableEnd != null && ours.diffAt >= st.prevStableEnd;
            let reason = ours.diffAt < 0 ? '완전히 같음 (리롤)'
                : normal ? SECTION_REASON.latest : (SECTION_REASON[wsecs[ours.diffAt]] || '');
            if (ev.cut) reason = '정리 턴 (오래된 대화 정리)';
            else if (ev.prune && !normal) reason = '꺼진 로어북 정리';
            else if (ev.edited) reason = '과거 메시지 수정 반영';
            st.stats.push({ at: now(), turn: st.turn, ours: ours.ratio, base: base ? base.ratio : null, size: ours.total, reason });
            if (st.stats.length > MAX_STATS) st.stats.splice(0, st.stats.length - MAX_STATS);
            log(`턴 ${st.turn} · 예상 캐시 ${Math.round(ours.ratio * 100)}%`
                + (base ? ` (플러그인 없이 ${Math.round(base.ratio * 100)}%)` : '')
                + ` · ${reason}${ev.frozenFix ? ` · 과거 메시지 ${ev.frozenFix}개 동결` : ''}`
                + ` · 캐시 지점 ${bps}개 · ${now() - t0}ms`);
        }
        st.prevOutSig = outSig;
        st.prevInSig = inSig;
        // 꼬리 바로 앞에서 매 턴 자리를 옮기는 삽입(작가 노트·옴니넥서스 상태 등)부터는 달라져도 정상
        const tailAt = wsecs.findIndex((s) => s === 'pre' || s === 'latest' || s === 'post');
        let stableEnd = tailAt < 0 ? wsecs.length : tailAt;
        for (let i = stableEnd - 1, chats = 0; i >= 0 && chats <= FLOAT_DEPTH; i--) {
            if (wsecs[i] === 'inner') stableEnd = i;
            else if (wsecs[i] === 'hist') chats++;
            else if (wsecs[i] !== 'note') break;
        }
        st.prevStableEnd = stableEnd;
        st.lastSize = outSig.reduce((s, x) => s + x[1], 0);
        saveState(ctx.key, st);
        lastChatKey = ctx.key;
        inflight = { chat: ctx.key, at: now(), cfgVer: configVersion, inHash, outHash: hash(outKeys.join()), outKeys, out: built.out.map(clone) };
        const lastStat = ours ? st.stats[st.stats.length - 1] : null;
        usageWait = lastStat ? { key: ctx.key, stat: lastStat, chars: st.lastSize, at: now() } : null;
        refreshUI();
        return built.out;
    }

    // =====================================================================
    // 10. 맨 마지막에 처리 (다른 플러그인이 다 바꾼 뒤 정리)
    // =====================================================================
    // 처리기를 두 개 씀. "앞 처리기"는 늘 등록돼 있고, 요청마다 "맨 뒤 처리기"를 목록 끝으로 다시 붙임.
    // 맨 뒤 처리기가 불리면 거기서 정리하고, 안 불리는 환경이면 앞 처리기가 직접 정리함.
    // (하나뿐인 처리기를 뗐다 붙이면, 다시 붙이기가 실패했을 때 플러그인이 조용히 멈춤)
    let tailMode = true;
    let tailMiss = 0;
    const armed = new Map(); // 요청 열쇠 → 앞 처리기가 맨 뒤로 넘긴 시각
    let lastChatKey = null;

    const eligible = (msgs, type) => type === 'model' && Array.isArray(msgs) && config.enabled && msgs.some(isChatMemo);
    const requestKey = (msgs) => {
        for (let i = msgs.length - 1; i >= 0; i--) if (isChatMemo(msgs[i])) return msgs[i].memo;
        return '';
    };
    const run = async (msgs) => {
        try { return await handle(msgs, config); }
        catch (e) {
            warn('처리 중 오류가 나서 원래 요청을 그대로 보냅니다', e);
            return msgs;
        }
    };

    const tailMissed = () => {
        if (++tailMiss >= 2 && tailMode) {
            tailMode = false;
            warn('맨 뒤에서 처리하기가 동작하지 않아 지금 위치에서 처리합니다');
        }
    };

    const tailReplacer = async (msgs, type) => {
        if (!eligible(msgs, type)) return msgs;
        const key = requestKey(msgs);
        if (!armed.has(key)) return msgs; // 앞 처리기가 이미 처리했거나 넘기지 않은 요청
        armed.delete(key);
        tailMiss = 0;
        return run(msgs);
    };

    const replacer = async (msgs, type) => {
        // 대화가 없는 요청(옴니넥서스 태거 같은 보조 호출)은 건드리지 않음
        if (!eligible(msgs, type)) return msgs;
        if (!tailMode) return run(msgs);
        const key = requestKey(msgs);
        const t = now();
        let missed = false;
        for (const [k, at] of [...armed]) if (k === key || t - at > TAIL_STALE_MS) { armed.delete(k); missed = true; }
        if (missed) {
            // 지난번에 맨 뒤 처리기가 불리지 않았음 → 이번 요청은 여기서 바로 처리
            tailMissed();
            return run(msgs);
        }
        armed.set(key, t);
        if (!TEST && typeof setTimeout === 'function') {
            // 맨 뒤 처리기가 끝내 안 불렸으면(이 환경에서 안 되는 것) 다음 요청을 기다리지 않고 알아챔
            setTimeout(() => { if (armed.get(key) === t) { armed.delete(key); tailMissed(); } }, TAIL_STALE_MS);
        }
        try {
            await API.removeRisuReplacer('beforeRequest', tailReplacer);
            await API.addRisuReplacer('beforeRequest', tailReplacer);
        } catch (e) {
            armed.delete(key);
            return run(msgs);
        }
        return msgs;
    };

    // =====================================================================
    // 11. 실제 캐시량 (Risu 기본 Gemini 연결의 응답에 들어 있는 사용량)
    // =====================================================================
    function readUsage(body, type) {
        if (type === 'meta_gemini') return body && body.usageMetadata;
        if (type !== 'meta_gemini_stream' || !body || !body.__usageMetadata) return null;
        try { return JSON.parse(body.__usageMetadata); } catch (_) { return null; }
    }

    async function onBody(body, type) {
        const usage = readUsage(body, type);
        const wait = usageWait;
        if (!usage || !wait) return undefined;
        const prompt = Number(usage.promptTokenCount) || 0;
        // 보조 호출의 사용량을 잘못 붙이지 않도록 이 요청과 크기가 비슷할 때만 기록
        if (!prompt || now() - wait.at > USAGE_WINDOW_MS || prompt * 10 < wait.chars || prompt > wait.chars * 2) return undefined;
        usageWait = null;
        const st = await loadState(wait.key);
        const stat = wait.stat;
        if (!st.stats.includes(stat)) return undefined;
        const cached = Number(usage.cachedContentTokenCount) || 0;
        stat.real = cached / prompt;
        stat.promptT = prompt;
        stat.cachedT = cached;
        log(`실제 캐시 ${Math.round(stat.real * 100)}% (${cached}/${prompt} 토큰)`);
        saveState(wait.key, st);
        refreshUI();
        return undefined;
    }

    // =====================================================================
    // 11-2. 실제 확인: Risu 요청 기록에서 진짜로 보낸 본문과 진짜 캐시 토큰을 읽음 (버튼을 눌렀을 때만)
    // =====================================================================
    function lastNum(text, re) {
        let m, v = null;
        re.lastIndex = 0;
        while ((m = re.exec(text))) v = Number(m[1]);
        return v;
    }
    // 응답 글에서 입력 토큰과 캐시된 토큰을 찾음 (Gemini · OpenAI 호환 · Claude)
    function usageOfResponse(text) {
        if (!text) return null;
        let prompt = lastNum(text, /"promptTokenCount"\s*:\s*(\d+)/g);
        if (prompt) return { prompt, cached: lastNum(text, /"cachedContentTokenCount"\s*:\s*(\d+)/g) || 0 };
        prompt = lastNum(text, /"prompt_tokens"\s*:\s*(\d+)/g);
        if (prompt) return { prompt, cached: lastNum(text, /"cached_tokens"\s*:\s*(\d+)/g) || 0 };
        const input = lastNum(text, /"input_tokens"\s*:\s*(\d+)/g);
        if (input == null) return null;
        const read = lastNum(text, /"cache_read_input_tokens"\s*:\s*(\d+)/g);
        const made = lastNum(text, /"cache_creation_input_tokens"\s*:\s*(\d+)/g) || 0;
        if (read == null) return input ? { prompt: input, cached: lastNum(text, /"cached_tokens"\s*:\s*(\d+)/g) || 0 } : null;
        return input + read + made ? { prompt: input + read + made, cached: read } : null;
    }

    // 요청 본문 → 모델이 읽는 순서대로 나열한 글 조각 (시스템 지시문, 그다음 메시지들)
    function wireSegments(body) {
        let req = body;
        if (typeof body === 'string') { try { req = JSON.parse(body); } catch (_) { return null; } }
        if (!req || typeof req !== 'object') return null;
        const textOf = (v) => {
            if (typeof v === 'string') return v;
            if (Array.isArray(v)) return v.map(textOf).join('');
            if (v && typeof v === 'object') {
                if (typeof v.text === 'string') return v.text;
                if (v.inlineData || v.inline_data || v.image_url || v.source) return '[file]';
                if (v.parts) return textOf(v.parts);
                if (v.content != null) return textOf(v.content);
            }
            return '';
        };
        const segs = [];
        if (Array.isArray(req.contents)) { // Gemini
            const sys = req.systemInstruction || req.system_instruction;
            segs.push({ name: '시스템 지시문', role: 'system', text: sys ? textOf(sys) : '' });
            req.contents.forEach((c, i) => {
                const role = c && c.role === 'model' ? 'model' : 'user';
                segs.push({ name: `${i + 1}번째 메시지(${role === 'model' ? 'AI' : '사용자'})`, role, text: textOf(c) });
            });
        } else if (Array.isArray(req.messages)) { // OpenAI 호환 · Claude
            if (req.system != null) segs.push({ name: '시스템 지시문', role: 'system', text: textOf(req.system) });
            req.messages.forEach((m, i) => {
                const role = str(m && m.role);
                segs.push({ name: `${i + 1}번째 메시지(${role})`, role, text: textOf(m && m.content) });
            });
        } else return null;
        return segs;
    }

    // 두 요청의 앞부분이 얼마나 같은지 (글자 수 비율)와 처음 달라진 곳
    function compareWire(prev, cur) {
        let common = 0, total = 0, at = null;
        for (const s of cur) total += s.text.length;
        for (let i = 0; i < cur.length; i++) {
            const a = prev[i], b = cur[i];
            if (a && a.role === b.role && a.text === b.text) { common += b.text.length; continue; }
            let k = 0;
            if (a && a.role === b.role) {
                const n = Math.min(a.text.length, b.text.length);
                while (k < n && a.text.charCodeAt(k) === b.text.charCodeAt(k)) k++;
            }
            common += k;
            const cut = (t) => t.slice(Math.max(0, k - 30), k + 50).replace(/\s+/g, ' ');
            at = { index: i, name: b.name, offset: k, was: a ? (a.role === b.role ? cut(a.text) : `(역할이 ${a.role})`) : '(없음)', now: cut(b.text), fromEnd: prev.length - i };
            break;
        }
        return { ratio: total ? common / total : 1, at };
    }

    async function realCheck(key) {
        if (typeof API.getFetchLogs !== 'function') return { error: 'unsupported' };
        let logs = null;
        try { logs = await API.getFetchLogs(); } catch (e) { return { error: 'failed', detail: str((e && e.message) || e) }; }
        if (!logs) return { error: 'denied' };
        const st = key ? await loadState(key) : null;
        const first = st && st.head ? st.head.find((s) => s.role === 'system' && s.content) : null;
        const probe = first ? first.content.slice(0, 80) : '';
        const size = st ? st.lastSize : 0;
        let rows = [];
        for (const log of Array.isArray(logs) ? logs : []) {
            if (!log) continue;
            const segs = wireSegments(log.body);
            if (!segs || segs.length < 3) continue;
            const total = segs.reduce((s, x) => s + x.text.length, 0);
            if (size && (total < size * 0.4 || total > size * 2.5)) continue; // 보조 호출·다른 채팅 거르기
            if (probe && !segs.slice(0, 4).some((s) => s.text.includes(probe))) continue;
            const status = Number(log.status) || 0;
            const ok = !status || (status >= 200 && status < 300);
            const usage = ok ? usageOfResponse(typeof log.response === 'string' ? log.response : JSON.stringify(log.response || '')) : null;
            rows.push({ at: Number(log.timestamp) || 0, ok, segs, usage });
        }
        if (rows.some((r) => !r.at)) rows.reverse(); // 시각이 없으면 "최신이 먼저"인 목록으로 보고 뒤집음
        else rows.sort((a, b) => a.at - b.at);
        const failed = rows.filter((r) => !r.ok).length;
        rows = rows.filter((r) => r.ok);
        const out = rows.map((r, i) => {
            const cmp = i > 0 ? compareWire(rows[i - 1].segs, r.segs) : null;
            return {
                at: r.at,
                real: r.usage ? r.usage.cached / r.usage.prompt : null,
                cachedT: r.usage ? r.usage.cached : null,
                promptT: r.usage ? r.usage.prompt : null,
                same: cmp ? cmp.ratio : null,
                diff: cmp ? cmp.at : null,
                gapMin: i > 0 && r.at && rows[i - 1].at ? (r.at - rows[i - 1].at) / 60000 : null,
            };
        }).slice(-8);
        return { rows: out, failed, verdict: verdictOf(out), report: reportOf(st, out, failed) };
    }

    function verdictOf(rows) {
        const logTip = '포켓리스라면 설정 → 시스템 → 리퀘스트 로그에서 "리퀘스트 로그 기록"이 켜져 있어야 해요.';
        if (!rows.length) return { tone: 'info', text: '요청 기록에서 이 채팅의 요청을 못 찾았어요. 메시지를 두 번쯤 보낸 뒤 다시 눌러 주세요.', tips: [logTip] };
        const pairs = rows.filter((r) => r.same != null);
        if (!pairs.length) return { tone: 'info', text: '이 채팅의 요청이 기록에 한 번뿐이에요. 한 번 더 보낸 뒤 다시 눌러 주세요.', tips: [] };
        const avg = (list, f) => list.reduce((s, x) => s + f(x), 0) / list.length;
        const same = avg(pairs, (r) => r.same);
        const measured = pairs.filter((r) => r.real != null);
        if (!measured.length) {
            return { tone: same >= 0.6 ? 'good' : 'bad', text: `보낸 요청의 앞부분은 평균 ${pct(same)} 같았어요. 이 연결은 캐시된 토큰 수를 기록에 남기지 않아서, 실제로 깎인 양은 여기서 알 수 없어요.`, tips: [] };
        }
        const real = avg(measured, (r) => r.real);
        if (real >= 0.5) return { tone: 'good', text: `잘 되고 있어요. 최근 ${measured.length}번 요청에서 입력의 평균 ${pct(real)}가 실제로 캐시로 처리됐어요.`, tips: [] };
        const tips = [];
        if (measured.every((r) => r.promptT < 4096)) {
            return { tone: 'info', text: '요청이 아직 짧아서(4,096토큰 미만) Gemini가 캐시를 하지 않아요. 대화가 길어지면 캐시되기 시작해요.', tips };
        }
        if (same >= 0.6) {
            const gaps = measured.map((r) => r.gapMin).filter((g) => g != null).sort((a, b) => a - b);
            const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
            if (gap != null && gap >= 5) tips.push(`메시지 사이가 보통 ${Math.round(gap)}분쯤이에요. 구글 캐시는 오래 남지 않아서, 한참 쉬었다 보내면 사라져요.`);
            tips.push('API 키나 프로젝트를 여러 개 번갈아 쓰면 캐시가 이어지지 않아요.');
            tips.push('모델 쪽 문제일 수도 있어요. 다른 Gemini 모델로 몇 번 보내서 비교해 보세요.');
            return { tone: 'warn', text: `요청은 잘 맞춰 보내고 있어요 (앞부분 평균 ${pct(same)} 같음). 그런데 실제로 캐시된 건 평균 ${pct(real)}뿐이에요. 캐시지기보다는 구글 쪽 사정일 가능성이 커요.`, tips };
        }
        const worst = pairs.filter((r) => r.same < 0.6 && r.diff).pop();
        if (worst) tips.push(`달라진 곳: ${worst.diff.name}의 ${worst.diff.offset.toLocaleString()}번째 글자`, `전: …${worst.diff.was}…`, `지금: …${worst.diff.now}…`);
        return { tone: 'bad', text: `요청 앞부분이 턴마다 달라져서 캐시가 깨지고 있어요 (앞부분이 평균 ${pct(same)}만 같음). 아래 "진단 내용"을 복사해서 알려 주시면 원인을 찾을 수 있어요.`, tips };
    }

    // 문제를 알릴 때 붙여 넣을 수 있는 짧은 글 (달라진 곳 주변 80자만 들어감)
    function reportOf(st, rows, failed) {
        const lines = [`캐시지기 v${VERSION} · 모드 ${config.mode} · 실패한 요청 ${failed}번`];
        if (st) {
            const sk = (st.head || []).filter((s) => s.sk).length;
            lines.push(`턴 ${st.turn} · 정리 ${st.epoch}번 · 머리 ${(st.head || []).length}개(뼈대 ${sk}) · 장부 ${st.ledger.length} · 변동 줄 ${st.rules.length} · 통째 변동 ${st.vol.length} · 맨뒤변동 ${st.postVolatile ? 'O' : 'X'}`);
        }
        for (const r of rows) {
            lines.push(`${timeText(r.at)} 실제 ${r.real == null ? '-' : pct(r.real)} (${r.cachedT == null ? '-' : r.cachedT}/${r.promptT == null ? '-' : r.promptT}) · 일치 ${r.same == null ? '-' : pct(r.same)}`
                + (r.diff ? ` · ${r.diff.name} ${r.diff.offset}자 (끝에서 ${r.diff.fromEnd}번째)` : ''));
            if (r.diff && r.same != null && r.same < 0.9) lines.push(`   전: ${r.diff.was}`, `   지금: ${r.diff.now}`);
        }
        if (st) for (const e of st.events.slice(0, 6)) lines.push(`· ${timeText(e.at)} ${e.text}`);
        return lines.join('\n');
    }

    // =====================================================================
    // 12. 화면
    // =====================================================================
    let uiOpen = false;
    let uiKey = null;

    const MODE_INFO = [
        ['safe', '안전', '오래된 대화만 한 번에 정리해요. 순서는 그대로라서, 매 턴 바뀌는 글이 있으면 효과가 작아요.'],
        ['balanced', '균형', '매번 바뀌는 것만 뒤로 보내고 나머지는 고정해요.'],
        ['max', '최대', '대화 사이 삽입까지 뒤로 모아요. 캐시가 가장 좋아요. 기본'],
    ];

    function esc(text) {
        return str(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function timeText(at) {
        const d = new Date(at);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);

    async function themeVars() {
        const fallback = { bg: '#1e1f29', card: '#282a36', line: '#44475a', text: '#f8f8f2', sub: '#a7abc0', accent: '#8be9fd', btn: '#343746' };
        try {
            const res = await API.getColorScheme();
            const s = res && res.scheme;
            if (!s) return fallback;
            const light = s.type === 'light';
            return {
                bg: s.bgcolor || fallback.bg, card: s.darkbg || fallback.card, line: s.borderc || fallback.line,
                text: s.textcolor || fallback.text, sub: s.textcolor2 || fallback.sub,
                accent: light ? '#2f6fdd' : '#6ea8fe', btn: s.darkbutton || fallback.btn,
            };
        } catch (_) { return fallback; }
    }

    function styleText(v) {
        return `
:root{--bg:${v.bg};--card:${v.card};--line:${v.line};--text:${v.text};--sub:${v.sub};--accent:${v.accent};--btn:${v.btn};--good:#3fb950;--warn:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,'Pretendard','Noto Sans KR','Apple SD Gothic Neo',sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:16px 16px 48px}
header{display:flex;align-items:center;gap:10px;margin-bottom:4px}
header h1{font-size:18px;margin:0;flex:1}
header small{color:var(--sub);font-weight:400;font-size:12px;margin-left:6px}
button{font:inherit;color:inherit;cursor:pointer}
.x{background:none;border:0;font-size:22px;line-height:1;padding:4px 8px;color:var(--sub)}
.switch{flex:none;position:relative;width:52px;height:30px;border-radius:15px;border:1px solid var(--line);background:var(--btn);padding:0}
.switch::after{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:var(--sub);transition:left .15s,background .15s}
.switch.on{background:var(--good);border-color:var(--good)}
.switch.on::after{left:25px;background:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-top:12px}
.label{color:var(--sub);font-size:12px}
.big{font-size:42px;font-weight:700;line-height:1.1}
.row{display:flex;align-items:flex-end;gap:14px}
.bars{display:flex;align-items:flex-end;gap:3px;height:56px;margin-top:12px}
.bar{flex:1;position:relative;height:100%}
.bar i,.bar b{position:absolute;left:0;right:0;bottom:0;border-radius:3px 3px 0 0}
.bar i{background:var(--line)}
.bar b{background:var(--accent);opacity:.9}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;color:var(--sub);font-size:12px}
.legend span{white-space:nowrap}
.legend .avg{flex-basis:100%}
.legend span::before{content:'';display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px;background:var(--accent)}
.legend span.b::before{background:var(--line)}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.fact{background:var(--bg);border-radius:10px;padding:8px 10px}
.fact b{display:block;font-size:18px}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.mode{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px;text-align:left}
.mode b{display:block;font-size:15px}
.mode span{display:block;color:var(--sub);font-size:12px;margin-top:2px}
.mode.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.events{list-style:none;margin:8px 0 0;padding:0}
.events li{display:flex;gap:10px;padding:6px 0;border-top:1px solid var(--line)}
.events li:first-child{border-top:0}
.events time{color:var(--sub);font-size:12px;min-width:38px;padding-top:1px}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.btn{background:var(--btn);border:1px solid var(--line);border-radius:10px;padding:9px 14px}
details{margin-top:12px}
summary{cursor:pointer;color:var(--sub)}
.set{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.set:first-of-type{border-top:0}
.set p{margin:0}
.set small{display:block;color:var(--sub);font-size:12px}
select,input[type=range]{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px}
input[type=range]{padding:0;accent-color:var(--accent)}
.note{color:var(--sub);font-size:12px;margin:10px 0 0}
.note.warn{color:var(--warn)}
.verdict{margin:8px 0 0;font-size:15px;line-height:1.5}
.verdict.good{color:var(--good)}
.verdict.warn,.verdict.bad{color:var(--warn)}
.tips{margin:8px 0 0;padding-left:18px;color:var(--sub);font-size:12px}
.tips li{margin:3px 0;word-break:break-all}
textarea{display:block;width:100%;height:130px;margin-top:8px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;resize:vertical}
.empty{color:var(--sub);padding:6px 0}
@media (max-width:480px){.modes{grid-template-columns:1fr}.big{font-size:36px}}
`;
    }

    function statsHtml(st) {
        if (!st || !st.stats.length) {
            return '<div class="card"><div class="label">이 채팅</div><p class="empty">아직 이 채팅에서 결과가 없어요. 대화를 두 번 이상 보내면 여기에 캐시 예상치가 나와요.</p></div>';
        }
        const last = st.stats[st.stats.length - 1];
        const recent = st.stats.slice(-20);
        const mean = (list, f) => list.reduce((s, x) => s + f(x), 0) / list.length;
        const value = (x) => (x.real != null ? x.real : x.ours);
        const measured = recent.filter((x) => x.real != null);
        const isReal = last.real != null;
        const baseList = recent.filter((x) => x.base != null);
        const baseAvg = baseList.length ? mean(baseList, (x) => x.base) : null;
        const avgText = measured.length
            ? `실제 캐시 평균 ${pct(mean(measured, (x) => x.real))} (최근 ${measured.length}번)`
            : `최근 ${recent.length}번 평균 ${pct(mean(recent, (x) => x.ours))}${baseAvg != null ? ` (없을 때 ${pct(baseAvg)})` : ''}`;
        const noHits = measured.length >= 3 && measured.every((x) => !x.real) && mean(measured, (x) => x.ours) > 0.3;
        const bars = recent.map((x) => `<div class="bar" title="턴 ${x.turn}: ${pct(value(x))}${x.real != null ? ' (실제)' : ' (예상)'} · 없을 때 ${pct(x.base)} · ${esc(x.reason)}"><i style="height:${Math.round((x.base || 0) * 100)}%"></i><b style="height:${Math.max(2, Math.round(value(x) * 100))}%"></b></div>`).join('');
        const side = isReal
            ? `${last.cachedT.toLocaleString()} / ${last.promptT.toLocaleString()} 토큰<br>${esc(last.reason)}`
            : `플러그인 없을 때 ${pct(last.base)}<br>${esc(last.reason)}`;
        return `<div class="card">
  <div class="label">${isReal ? '구글이 지난 요청에서 실제로 캐시해 준 비율' : '지난 요청에서 캐시로 읽을 수 있는 앞부분 (예상)'}</div>
  <div class="row"><div class="big">${pct(value(last))}</div><div class="label" style="padding-bottom:6px">${side}</div></div>
  <div class="bars">${bars}</div>
  <div class="legend"><span>캐시지기</span><span class="b">플러그인 없을 때</span><div class="avg">${avgText}</div></div>
  ${noHits ? '<p class="note warn">앞부분은 같게 보내고 있는데 구글이 아직 캐시를 안 해 줬어요. 요청이 4,096토큰보다 짧거나, 구글 쪽 상태 때문일 수 있어요.</p>' : ''}
  <div class="facts">
    <div class="fact"><span class="label">남긴 대화</span><b>${st.keptCount || 0}개</b></div>
    <div class="fact"><span class="label">장부 항목</span><b>${st.ledger.length}개</b></div>
    <div class="fact"><span class="label">찾은 변동 줄</span><b>${st.rules.length}개</b></div>
  </div>
</div>`;
    }

    let uiReal = null; // 실제 확인 결과 (없음 | {loading} | 결과)
    function realHtml() {
        const head = '<div class="label">진짜로 캐시됐는지 확인</div>';
        const btn = `<div class="actions"><button class="btn" data-act="real">${uiReal ? '다시 확인' : '실제 캐시 확인'}</button></div>`;
        if (!uiReal) {
            return `<div class="card">${head}${btn}<p class="note">Risu의 요청 기록을 읽어서, 방금 보낸 요청들이 실제로 얼마나 캐시됐는지 보여 줘요. 처음 누르면 기록을 읽어도 되는지 물어봐요.</p></div>`;
        }
        if (uiReal.loading) return `<div class="card">${head}<p class="note">요청 기록을 읽는 중이에요…</p></div>`;
        if (uiReal.error) {
            const text = {
                unsupported: '이 Risu에는 플러그인이 요청 기록을 읽는 기능이 없어요.',
                denied: '요청 기록 읽기를 허용하지 않아서 확인할 수 없어요. Risu 설정의 플러그인 권한에서 다시 허용할 수 있어요.',
                failed: '요청 기록을 읽지 못했어요.',
            }[uiReal.error] || '확인하지 못했어요.';
            return `<div class="card">${head}<p class="verdict warn">${text}</p>${btn}</div>`;
        }
        const v = uiReal.verdict;
        const rows = uiReal.rows.slice(-5).map((r) => `<li><time>${r.at ? timeText(r.at) : ''}</time><span>${r.real == null ? '캐시 숫자 없음' : `실제 캐시 <b>${pct(r.real)}</b> (${r.cachedT.toLocaleString()} / ${r.promptT.toLocaleString()} 토큰)`}${r.same == null ? '' : ` · 앞부분 일치 ${pct(r.same)}`}</span></li>`).join('');
        const tips = v.tips.length ? `<ul class="tips">${v.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
        return `<div class="card">${head}<p class="verdict ${v.tone}">${esc(v.text)}</p>${tips}
${rows ? `<ul class="events">${rows}</ul><p class="note">앞부분 일치: 바로 전 요청과 앞에서부터 똑같은 글의 비율이에요. 이만큼까지 캐시될 수 있어요.</p>` : ''}
${btn}
<details><summary>진단 내용 (문제를 알릴 때 복사)</summary><textarea readonly>${esc(uiReal.report)}</textarea><p class="note">숫자와, 요청이 달라진 곳 주변 글자 80자쯤이 들어 있어요.</p></details></div>`;
    }

    function eventsHtml(st) {
        if (!st || !st.events.length) return '';
        const items = st.events.slice(0, 6).map((e) => `<li><time>${timeText(e.at)}</time><span>${esc(e.text)}</span></li>`).join('');
        return `<div class="card"><div class="label">최근에 한 일</div><ul class="events">${items}</ul></div>`;
    }

    function settingsHtml(cfg) {
        const opt = (value, current, label) => `<option value="${value}"${String(current) === String(value) ? ' selected' : ''}>${label}</option>`;
        const toggle = (key, on) => `<button class="switch${on ? ' on' : ''}" data-toggle="${key}" aria-pressed="${on}" aria-label="${key}"></button>`;
        return `<details${uiAdvancedOpen ? ' open' : ''} id="adv"><summary>자세한 설정</summary>
  <div class="set"><p>정리 턴에 덜어낼 양<small>클수록 정리 턴이 드물어지고, 대신 AI가 기억하는 대화가 줄어요. 지금 ${Math.round(cfg.cutRatio * 100)}%</small></p><input type="range" min="20" max="60" step="5" value="${Math.round(cfg.cutRatio * 100)}" data-range="cutRatio"></div>
  <div class="set"><p>꺼진 로어북 유지<small>켜면 다음 정리 턴까지 그대로 보내서 캐시를 지켜요. 끄면 바로 빼는 대신 그때마다 캐시가 깨져요</small></p>${toggle('keepRemoved', cfg.keepRemoved)}</div>
  <div class="set"><p>과거 메시지 동결<small>정규식·CBS 때문에 옛 메시지 글자가 바뀌어도 처음 보낸 글자를 유지해요. 직접 고친 메시지는 반영돼요</small></p><select data-select="freeze">${opt('auto', cfg.freeze, '모드에 따라')}${opt('on', cfg.freeze, '켜기')}${opt('off', cfg.freeze, '끄기')}</select></div>
  <div class="set"><p>Claude 캐시 지점<small>Claude에서만 쓰여요. 다른 캐시 플러그인을 같이 쓰면 '그대로 두기'</small></p><select data-select="breakpoints">${opt('auto', cfg.breakpoints, '자동')}${opt('keep', cfg.breakpoints, '그대로 두기')}${opt('off', cfg.breakpoints, '모두 끄기')}</select></div>
</details>`;
    }

    let uiAdvancedOpen = false;
    let uiStyleText = '';

    async function renderUI() {
        if (!uiOpen || typeof document === 'undefined') return;
        const st = uiKey ? (memStates.get(uiKey) || await loadState(uiKey)) : null;
        const cfg = config;
        const modes = MODE_INFO.map(([id, name, desc]) => `<button class="mode${cfg.mode === id ? ' on' : ''}" data-mode="${id}"><b>${name}</b><span>${desc}</span></button>`).join('');
        document.body.innerHTML = `<style>${uiStyleText}</style><div class="wrap">
<header><h1>캐시지기<small>v${VERSION}</small></h1><button class="switch${cfg.enabled ? ' on' : ''}" data-toggle="enabled" aria-pressed="${cfg.enabled}" aria-label="켜기"></button><button class="x" data-act="close" aria-label="닫기">×</button></header>
<div class="label">${cfg.enabled ? '켜져 있어요. 보내는 요청만 정리하고 채팅 기록은 그대로 둬요.' : '꺼져 있어요. 요청을 그대로 보내요.'}</div>
${statsHtml(st)}
${realHtml()}
<div class="card"><div class="label">모드</div><div class="modes">${modes}</div>
<div class="actions"><button class="btn" data-act="rebuild">지금 정리하기</button><button class="btn" data-act="reset">이 채팅 학습 지우기</button></div>
<p class="note">지금 정리하기: 꺼진 로어북과 밀린 변경을 다음 요청에 바로 반영해요. 대화는 지우지 않고, 캐시는 그 턴에 한 번 깨져요.</p></div>
${eventsHtml(st)}
<div class="card">${settingsHtml(cfg)}
<p class="note">포켓리스 프리셋이나 Provider Manager로 보내면 맨 위 숫자는 예상치예요. 진짜 값은 "실제 캐시 확인"을 눌러서 보세요.</p></div>
</div>`;
        bindUI();
    }

    function bindUI() {
        const root = document.body;
        root.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('click', async () => {
            const key = el.getAttribute('data-toggle');
            await saveConfig({ [key]: !config[key] });
            renderUI();
        }));
        root.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', async () => {
            await saveConfig({ mode: el.getAttribute('data-mode') });
            renderUI();
        }));
        root.querySelectorAll('[data-select]').forEach((el) => el.addEventListener('change', async () => {
            await saveConfig({ [el.getAttribute('data-select')]: el.value });
            renderUI();
        }));
        root.querySelectorAll('[data-range]').forEach((el) => el.addEventListener('change', async () => {
            await saveConfig({ cutRatio: Number(el.value) / 100 });
            renderUI();
        }));
        const adv = root.querySelector('#adv');
        if (adv) adv.addEventListener('toggle', () => { uiAdvancedOpen = adv.open; });
        root.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', async () => {
            const act = el.getAttribute('data-act');
            if (act === 'close') { uiOpen = false; await API.hideContainer(); return; }
            if (act === 'real') {
                uiReal = { loading: true };
                await renderUI();
                uiReal = await realCheck(uiKey);
                renderUI();
                return;
            }
            if (!uiKey) return;
            if (act === 'rebuild') await requestRebuild(uiKey);
            else if (act === 'reset') await resetState(uiKey);
            renderUI();
        }));
    }

    // 꺼진 항목·밀린 변경만 다음 요청에 반영 (대화는 줄이지 않음)
    async function requestRebuild(key) {
        const st = await loadState(key);
        st.forceRebuild = true;
        st.forceRefresh = true;
        inflight = null;
        pushEvent(st, 'rebuild', '다음 요청에서 꺼진 로어북과 밀린 변경을 한 번에 반영할게요');
        await saveState(key, st);
    }

    async function openUI() {
        try {
            uiOpen = true;
            const ctx = await getChatContext();
            uiKey = ctx.key || lastChatKey;
            uiReal = null;
            uiStyleText = styleText(await themeVars());
            await API.showContainer('fullscreen');
            await renderUI();
        } catch (e) { warn('화면을 열지 못했어요', e); }
    }

    let uiTimer = null;
    function refreshUI() {
        if (!uiOpen) return;
        if (uiTimer) clearTimeout(uiTimer);
        uiTimer = setTimeout(() => { uiTimer = null; renderUI(); }, 300);
    }

    // =====================================================================
    // 13. 시작
    // =====================================================================
    await loadConfig();

    if (TEST) {
        TEST.exports = {
            replacer, handle, segment, lineDiff, rulePrefix, applyRules, lcsPairs, alignHead, formsOf, learnRules,
            getState: (key) => memStates.get(key), saveConfig, resetState, requestRebuild, onBody, openUI,
            realCheck, wireSegments, compareWire, usageOfResponse, fitSkeleton, lineHashes,
            onOutput: () => { inflight = null; },
            // 새로고침 흉내: 기억해 둔 것(메모리)을 모두 잊음. 저장소에 쓴 것만 남음
            forget: async () => { await saveChain; memStates.clear(); frozenMem.clear(); chatKeyCache.clear(); armed.clear(); inflight = null; usageWait = null; },
            config: () => config,
        };
        return;
    }

    try {
        await API.addRisuReplacer('beforeRequest', replacer);
    } catch (e) {
        warn('요청 처리기를 등록하지 못했어요. RisuAI 권한 창에서 허용했는지 확인하세요.', e);
    }
    if (typeof API.addRisuChatListener === 'function') {
        try {
            await API.addRisuChatListener('output', (arg) => {
                inflight = null; // 답장이 끝났으니 다음 요청은 새 턴
                // 채팅방 순번이 바뀌었을 수 있으니 열쇠를 실제 채팅 ID로 맞춤
                if (arg && arg.chat && arg.chat.id && typeof arg.characterIndex === 'number' && typeof arg.chatIndex === 'number') {
                    chatKeyCache.set(`${arg.characterIndex}#${arg.chatIndex}`, `${arg.characterIndex}:${arg.chat.id}`);
                }
            });
        } catch (_) { /* 선택 기능 */ }
    }
    // 요청 본문은 건드리지 않고, Gemini 응답의 사용량만 읽음
    if (typeof API.registerBodyIntercepter === 'function') {
        try { await API.registerBodyIntercepter(onBody); } catch (_) { /* 선택 기능 */ }
    }
    try { await API.registerSetting('캐시지기', openUI, '⚡', 'html', 'cache-jigi-setting'); } catch (_) { /* 선택 기능 */ }
    try { await API.registerButton({ name: '캐시지기', icon: '⚡', iconType: 'html', location: 'hamburger', id: 'cache-jigi-menu' }, openUI); } catch (_) { /* 선택 기능 */ }
    if (typeof API.onUnload === 'function') {
        await API.onUnload(async () => {
            try { await API.removeRisuReplacer('beforeRequest', replacer); } catch (_) { /* 무시 */ }
            try { await API.removeRisuReplacer('beforeRequest', tailReplacer); } catch (_) { /* 무시 */ }
        });
    }
    log(`v${VERSION} 시작. 모드: ${config.mode}, ${config.enabled ? '켜짐' : '꺼짐'}`);
})();
