// 캐시지기 모의 시험: Risu처럼 프롬프트를 조립해서 여러 턴을 돌리고,
// 연속 요청의 앞부분이 얼마나 같은지(암시적 캐시가 다시 쓸 수 있는 양)를 비교한다.
// 요청을 보내는 흐름(재시도 포함)과 Gemini 본문 변환은 Risu·포켓리스 원본 코드를 그대로 옮겼다.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = process.env.CACHEJIGI_PLUGIN || path.join(here, '..', 'cache-jigi.js');

// ---------------------------------------------------------------- 옵션
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const TURNS = Number(args.turns || 60);
const MODE = args.mode || 'balanced';
const BUDGET = Number(args.budget || 14000);       // Risu maxContext (글자 수로 흉내)
const WITH_OBF = args.obf === '1' || args.obf === '2'; // Risu64 같은 단어 바꾸기 플러그인 (1: 앞에, 2: 뒤에 등록)
const WITH_MEMORY = args.memory === '1';            // HypaV3 같은 무작위 요약 선택
const SEED = Number(args.seed || 7);
const NO_TIME = args.notime === '1';               // 시각·호감도 줄이 없는 깔끔한 프리셋
const LONG = args.long === '1';                     // 실제처럼 긴 답장 (약 900자)
const OMNI = args.omni === '1' || args.omni === '2'; // 옴니넥서스 스트리밍 태그 (1: 캐시지기보다 나중에 등록, 2: 먼저 등록)
const OMNI_BIG = args.omnibig === '1';              // 옴니넥서스 상태 메시지가 긴 경우 (에셋 외형 포함)
const VAR_LORE = args.varlore === '1';              // 대화 중간에 켜지고 값이 바뀌는 로어북
const PRESS_BTN = args.btn === '1';                 // 8턴째 "지금 정리하기"
const CONV = ['pm', 'pocket'].includes(args.conv) ? args.conv : 'risu'; // Gemini 본문 변환: Risu 기본 / Provider Manager / 포켓리스 프리셋
const VAR_POST = args.varpost === '1';              // 맨 뒤 지시문이 턴마다 바뀌는 경우
const RETRY = Number(args.retry || 0);              // 이 확률로 요청이 실패해서 Risu가 재시도 (바뀐 요청이 다시 플러그인에 들어옴)
const BLOCK = args.block === '1';                   // 긴 메인 프롬프트 한가운데에 매 턴 통째로 바뀌는 여러 줄 블록
const MERGED = args.merged === '1';                 // Risu가 연달은 system 글을 하나로 합쳐 주는 경우 (gpt·claude·프록시 모델 설정)
const BIG_LORE = args.biglore === '1';              // 길고 많은 로어북이 자주 켜졌다 꺼짐
const RELOAD = Number(args.reload || 0);            // N턴마다 새로고침 (플러그인이 기억을 잃음)
const NO_TAIL = args.notail === '1';                // 처리기를 다시 붙이는 것이 안 되는 환경 (맨 뒤 처리기가 등록되지 않음)
const MIGRATE = args.migrate === '1';              // 20턴째: 예전 버전(1.1.x)이 잘못 배워 둔 상태로 바꿔 놓고 이어 감
const BIG_HEAD = args.bighead === '1';              // 실제 프리셋처럼 긴 메인 프롬프트 (약 2만 6천 자)
const TRAIL = args.trail === '1';                   // 긴 규칙과 로어북이 대화 기록과 마지막 입력 사이에 있는 프리셋 (약 3만 자)

let seed = SEED;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// ---------------------------------------------------------------- 가짜 Risu API
const replacers = new Set();
const mem = new Map();
const local = new Map();
let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
const raw = { id: 'chat-1', message: [] };   // Risu 채팅 원문 (data)
const fetchLogs = [];                        // 포켓리스 요청 기록 흉내 (최신 20개)

const api = {
    addRisuReplacer: async (name, fn) => { if (!NO_TAIL) replacers.add(fn); },
    removeRisuReplacer: async (name, fn) => { replacers.delete(fn); },
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => 0,
    getChatFromIndex: async () => structuredClone(raw),
    getFetchLogs: async () => structuredClone(fetchLogs.slice(-20).reverse()),
    pluginStorage: { getItem: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : null), setItem: async (k, v) => { mem.set(k, structuredClone(v)); } },
    getLocalPluginStorage: async () => ({
        getItem: async (k) => (local.has(k) ? structuredClone(local.get(k)) : null),
        setItem: async (k, v) => { local.set(k, structuredClone(v)); },
        removeItem: async (k) => { local.delete(k); },
        keys: async () => [...local.keys()],
    }),
};
globalThis.__CACHEJIGI_TEST__ = { api, now: () => clock };

// Risu request.ts의 requestChatData를 그대로 옮김: 원본을 한 번 복사해 두고, 시도할 때마다
// replacer들을 차례로 부른다. 실패해서 재시도하면 "이미 바뀐 요청"이 다시 replacer들에 들어간다.
// (replacer 목록은 Set이라서, 도는 도중에 뗐다 붙인 것은 끝에서 다시 불린다)
async function requestChatData(formated, retries = 0) {
    let cur = structuredClone(formated);
    const attempts = [];
    for (let n = 0; n <= retries; n++) {
        for (const r of replacers) cur = structuredClone(await r(structuredClone(cur), 'model'));
        attempts.push(structuredClone(cur));
    }
    return attempts;
}

// ---------------------------------------------------------------- Risu64 흉내 (결정적 단어 바꾸기 + 지침 + 재시도 지문)
function fp(v) { const s = JSON.stringify(v); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h + ':' + s.length; }
const obfReturned = [];
const obfuscator = async (msgs, type) => {
    if (type !== 'model') return msgs;
    if (obfReturned.includes(fp(msgs))) return msgs;
    let replaced = 0;
    const out = msgs.map((m) => {
        const c = String(m.content || '');
        const n = c.replaceAll('칼', '[B64:7Lm8]');
        if (n !== c) replaced++;
        return { ...m, content: n };
    });
    if (replaced) out.unshift({ role: 'system', content: '[B64:...] 표시는 base64입니다. 풀어서 읽으세요.' });
    obfReturned.push(fp(out)); if (obfReturned.length > 16) obfReturned.shift();
    return out;
};
if (WITH_OBF && args.obf !== '2') replacers.add(obfuscator);

// ---------------------------------------------------------------- 옴니넥서스 1.4.5 스트리밍 태그 흉내 (실제 코드의 Pce·UP 순서 그대로)
const OMNI_RULES_HEAD = '# Omni Nexus - image shots in your reply';
const omniRules = `${OMNI_RULES_HEAD}\n` + Array.from({ length: 60 }, (_, i) => `- 규칙 ${i + 1}: 장면마다 [[inxN]] 블록을 쓰고 태그는 쉼표로 구분합니다. 등록된 인물의 외형을 우선합니다.`).join('\n');
const omniCast = ['리나'];
const omniBig = Array.from({ length: 90 }, (_, i) => `- asset ${i}: 1girl, silver hair, long hair, red eyes, armor, looking at viewer`).join('\n');
const omniState = () => `# Omni Nexus - image state for this chat\n${omniCast.map((c) => `- ${c} - looks saved`).join('\n')}${OMNI_BIG ? `\n${omniBig}` : ''}`;
const omni = async (msgs, type) => {
    if (type !== 'model' || !msgs.some((m) => m.memo)) return msgs; // 태거 자체 호출은 통과
    if (msgs.some((m) => String(m.content).includes(OMNI_RULES_HEAD))) return msgs;
    const a = [...msgs];
    a.splice(Math.min(1, a.length), 0, { role: 'system', content: omniRules });
    let r = -1;
    for (let s = a.length - 1; s >= 0; s--) if (a[s].role === 'user') { r = s; break; }
    a.splice(r >= 0 ? r : a.length, 0, { role: 'system', content: omniState() });
    return a;
};
if (OMNI && args.omni === '2') replacers.add(omni);
// 옴니넥서스 editprocess 정규식: 요청에서 이미지 표시를 지움 (블록은 뒤 줄바꿈까지, 토큰은 줄바꿈은 남김)
const omniStrip = (t) => t
    .replace(/\[\[@inray(?:spinner|wait)?::[^\[\]\n]{1,4096}\]\][ \t]*/g, '')
    .replace(/\[\[inx(\d{1,3})\]\][\s\S]{0,12000}?\[\[\/inx\1\]\][ \t]*\n?/g, '');

// ---------------------------------------------------------------- 최종 Gemini 본문 (원본 코드 그대로 옮김)
function toGeminiRisu(input) { // Risu google.ts
    const f = structuredClone(input);
    let system = '';
    if (f[0].role === 'system') { system = f[0].content; f.shift(); }
    const out = [];
    for (const c of f) {
        const prev = out[out.length - 1];
        if (c.role === 'system') {
            if (prev?.role === 'user') prev.text += '\nsystem:' + c.content;
            else out.push({ role: 'user', text: 'system:' + c.content });
        } else out.push({ role: c.role === 'user' ? 'user' : 'model', text: c.content });
    }
    for (let i = out.length - 1; i >= 1; i--) if (out[i].role === out[i - 1].role) { out[i - 1].text += '\n\n' + out[i].text; out.splice(i, 1); }
    return { system, contents: out };
}
function toGeminiPM(input) { // Provider Manager v1.19.2 Ya·Wg·Fg
    let e = 0;
    while (e < input.length && input[e].role === 'system') e++;
    const system = input.slice(0, e).map((m) => m.content).join('\n\n');
    const list = input.slice(e).map((m) => (m.role === 'system' ? { role: 'user', text: `system: ${m.content}` } : { role: m.role === 'assistant' ? 'model' : 'user', text: m.content }));
    const out = [];
    for (const m of list) { const p = out[out.length - 1]; if (p && p.role === m.role) p.text += `\n\n${m.text}`; else out.push({ ...m }); }
    if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', text: 'Start' });
    return { system, contents: out };
}
function toGeminiPocket(input) { // PocketRisu 모델 프리셋 googleGemini 어댑터 (collectSystemAndChat·toGeminiContents): system은 위치와 상관없이 전부 systemInstruction으로, 나머지는 합치지 않고 차례대로
    const systems = [], chat = [];
    for (const m of input) (m.role === 'system' ? systems : chat).push(m);
    return { system: systems.map((m) => m.content).join('\n\n'), contents: chat.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', text: m.content })) };
}
const toBody = (msgs) => (CONV === 'pm' ? toGeminiPM : CONV === 'pocket' ? toGeminiPocket : toGeminiRisu)(msgs);
const serBody = (msgs) => { const b = toBody(msgs); return `${b.system}\u0000${b.contents.map((c) => `${c.role}:${c.text}`).join('\u0000')}`; };
const jsonBody = (msgs) => { const b = toBody(msgs); return JSON.stringify({ systemInstruction: { parts: [{ text: b.system }] }, contents: b.contents.map((c) => ({ role: c.role, parts: [{ text: c.text }] })), generationConfig: { maxOutputTokens: 32768 } }); };
// Gemini 4 규칙: 4,096토큰 이상만 캐시, 2,050토큰 미만으로 늘면 지난 요청 끝 2,050토큰은 제값 (한글 1토큰 = 약 2.5자로 근사)
const TOK = 2.5;
function gemini4Ratio(prev, cur) {
    if (prev == null || cur.length < 4096 * TOK) return 0;
    const n = Math.min(prev.length, cur.length);
    let common = 0;
    while (common < n && prev.charCodeAt(common) === cur.charCodeAt(common)) common++;
    const gate = cur.length - prev.length >= 2050 * TOK ? prev.length : prev.length - 2050 * TOK;
    return Math.max(0, Math.min(common, gate)) / cur.length;
}

// ---------------------------------------------------------------- 플러그인 불러오기
await import(pathToFileURL(PLUGIN).href);
for (let i = 0; i < 100 && !globalThis.__CACHEJIGI_TEST__.exports; i++) await new Promise((r) => setTimeout(r, 5));
const P = globalThis.__CACHEJIGI_TEST__.exports;
if (!P) throw new Error('plugin did not load');
await P.saveConfig({ mode: MODE, log: 'off' });
replacers.add(P.replacer);
// --obf=2: 단어 바꾸기 플러그인이 캐시지기보다 나중에 등록된 경우 (캐시지기가 맨 뒤에서 처리해야 함)
if (args.obf === '2') replacers.add(obfuscator);
if (OMNI && args.omni === '1') replacers.add(omni);
const KEY = '0:chat-1';

// ---------------------------------------------------------------- Risu 조립 흉내
const lore = [
    { key: '숲', text: '[숲] 북쪽 숲에는 늑대가 산다.\n숲 안쪽에는 오래된 신전이 있다.\n밤에는 안개가 짙다.' },
    { key: '성', text: '[성] 왕성은 언덕 위에 있다.\n성문은 해가 지면 닫힌다.\n경비대장 이름은 레온이다.' },
    { key: '칼', text: '[칼] 주인공의 칼은 은으로 만들었다.\n늑대에게 특히 잘 듣는다.' },
];
if (BIG_LORE) {
    // 긴 로어북 16개: 대화에 나온 낱말에 따라 켜졌다 꺼짐 (실제 큰 봇처럼 항목 하나가 1,500자쯤)
    const keys = ['숲', '성', '칼', '길', '지도', '물', '모닥불', '주위', '리나', '사과', '늑대', '신전', '안개', '경비', '시장', '상인'];
    lore.length = 0;
    keys.forEach((key, n) => lore.push({ key, text: `[${key}] 설정집 ${n + 1}번 항목.\n` + Array.from({ length: 24 }, (_, i) => `${key}에 대한 ${i + 1}번째 설명: 이 세계에서 ${key}은(는) 오래된 이야기와 얽혀 있고, 사람마다 다르게 기억한다.`).join('\n') }));
}
const randomLore = { text: '[소문] 요즘 시장에 이상한 상인이 나타난다는 소문이 돈다.\n그 상인은 밤에만 장사를 한다.' };
const constantLore = '[세계관] 이 세계에는 마법이 드물다.\n대부분의 사람은 검과 활을 쓴다.\n왕국의 이름은 에스텔이다.\n화폐 단위는 은화다.';
const summaries = Array.from({ length: 8 }, (_, i) => `요약 ${i + 1}: 주인공은 ${i + 1}번째 사건에서 단서를 찾았다. 동료와 함께 다음 목적지를 정했다.`);

const varLoreText = (t) => `[상황판] 마을 경계도: ${Math.floor(t / 7)}\n오늘의 소문은 아직 없다.\n장터는 해가 지면 닫힌다.\n성문 앞에는 경비병이 둘 서 있다.`;
function hhmm(t) { const d = new Date(t); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }

// 매 턴 통째로 바뀌는 여러 줄 블록 (줄 앞머리도, 줄 수도 달라짐)
const weathers = ['맑고 바람이 없다.', '비가 추적추적 내린다.', '안개가 자욱하다.', '눈발이 날린다.', '구름이 낮게 깔렸다.'];
const moods = ['리나는 말없이 앞장선다.', '동료들의 표정이 어둡다.', '모두 조금 들떠 있다.', '긴장이 감돈다.'];
function blockLines(turnIdx) {
    const out = [weathers[turnIdx % weathers.length], moods[(turnIdx * 3) % moods.length]];
    if (turnIdx % 3 === 0) out.push(`지금까지 ${turnIdx}번 대화했다.`);
    if (turnIdx % 4 === 1) out.unshift('멀리서 종소리가 들린다.');
    return out;
}

function assemble(turnIdx) {
    const affection = 10 + Math.floor(turnIdx / 3);
    const mainLines = [
        '당신은 판타지 롤플레이를 진행하는 작가입니다.',
        '항상 3인칭 과거형으로 씁니다.',
        '사용자의 행동을 대신 쓰지 않습니다.',
        NO_TIME ? '시점은 주인공 중심입니다.' : `현재 시각: ${hhmm(clock)}`,
        '묘사는 감각 위주로 구체적으로 씁니다.',
        '대화는 큰따옴표로 감쌉니다.',
    ];
    const rules = Array.from({ length: BIG_HEAD ? 400 : (BLOCK ? 30 : 0) }, (_, i) => `작법 ${i + 1}: 장면은 ${i + 1}번 원칙에 따라 차분하고 구체적으로 풀어 갑니다. 감각 묘사와 인물의 속마음을 균형 있게 다룹니다.`);
    if (BLOCK) mainLines.push(...rules.slice(0, rules.length / 2), '', '<지금 상황>', ...blockLines(turnIdx), '</지금 상황>', '', ...rules.slice(rules.length / 2));
    else mainLines.push(...rules);
    const main = mainLines.join('\n');
    const desc = [
        '이름: 리나', '나이: 23', '직업: 떠돌이 기사', '성격: 무뚝뚝하지만 정이 많다.',
        NO_TIME ? '호감도: 보통' : `호감도: ${affection}`, '좋아하는 것: 사과, 조용한 밤', '싫어하는 것: 거짓말',
    ].join('\n');
    const recent = raw.message.slice(-3).map((m) => m.data).join('\n');
    const head = [
        { role: 'system', content: main },
        { role: 'system', content: '사용자: 여행자. 검술을 조금 할 줄 안다.' },
        { role: 'system', content: desc },
        { role: 'system', content: constantLore },
    ];
    const loreOn = lore.filter((l) => recent.includes(l.key)).map((l) => ({ role: 'system', content: l.text }));
    if (!TRAIL) head.push(...loreOn);
    if (rand() < 0.5) head.push({ role: 'system', content: randomLore.text });
    if (VAR_LORE && turnIdx >= 10) head.push({ role: 'system', content: varLoreText(turnIdx) });
    if (WITH_MEMORY) {
        const picked = summaries.slice().sort(() => rand() - 0.5).slice(0, 3);
        head.push({ role: 'system', content: picked.join('\n'), memo: 'hypaMemory' });
    }
    const chats = [
        { role: 'system', content: '[Start a new chat]', memo: 'NewChatExample' },
        { role: 'user', content: '안녕?', name: 'example_user' },
        { role: 'assistant', content: '"...뭐야." 리나가 눈을 가늘게 떴다.', name: 'example_assistant' },
        { role: 'system', content: '[Start a new chat]', memo: 'NewChatExample' },
        { role: 'user', content: '같이 갈래?', name: 'example_user' },
        { role: 'assistant', content: '"마음대로 해." 리나는 대답 대신 짐을 챙겼다.', name: 'example_assistant' },
        { role: 'system', content: '[Start a new chat]', memo: 'NewChat' },
        { role: 'assistant', content: '모닥불 옆에서 리나가 칼을 닦고 있었다. "앉든지."' },
    ];
    const n = raw.message.length;
    raw.message.forEach((m, idx) => {
        let content = OMNI ? omniStrip(m.data) : m.data;
        // 정규식 흉내: 끝에서 6개보다 오래된 메시지는 상태창을 지움 (순번 기반)
        if (n - idx > 6) content = content.replace(/<상태>[\s\S]*?<\/상태>/g, '').trim();
        chats.push({ role: m.role === 'user' ? 'user' : 'assistant', content, memo: m.chatId });
    });
    // Risu 자르기: 넘치면 맨 앞부터 하나씩 (예시 → 표시 → 첫 메시지 → 오래된 대화)
    const size = (list) => list.reduce((s, m) => s + m.content.length, 0);
    // 대화 기록(마지막 입력 앞까지)과 마지막 입력 사이에 오는 프리셋 글: 머리글, 긴 규칙, 수락 답장, 로어북
    const trail = [];
    if (TRAIL) {
        const longRule = (name, count) => Array.from({ length: count }, (_, i) => `${name} ${i + 1}: 장면은 ${i + 1}번 원칙에 따라 구체적으로 씁니다. 인물의 속마음과 감각 묘사를 균형 있게 다룹니다.`).join('\n');
        trail.push(
            { role: 'user', content: '# Additional Information' },
            { role: 'system', content: '# AI 역할\n' + longRule('역할', 120) },
            { role: 'assistant', content: 'Understood. 계속하겠습니다.' },
            { role: 'user', content: '# 추가 지침\n' + longRule('지침', 200) },
            { role: 'system', content: '# 이미지 출력 설정\n' + longRule('이미지', 60) },
            ...loreOn,
            { role: 'user', content: '# User\'s input' },
        );
    }
    const fixed = size(head) + size(trail) + 400;
    while (fixed + size(chats) > BUDGET && chats.length > 2) chats.shift();
    // 작가 노트: 끝에서 2번째 위치(대화 사이)
    const an = { role: 'system', content: '[작가 노트] 긴장감을 유지하세요.' };
    const body = chats.slice();
    body.splice(Math.max(0, body.length - 2), 0, an);
    if (TRAIL) {
        // Risu 프리셋의 "대화(마지막 하나 빼고) → 프리셋 글 → 마지막 입력" 구성
        let li = -1;
        for (let k = body.length - 1; k >= 0; k--) if (body[k].role === 'user' && body[k].memo) { li = k; break; }
        if (li >= 0) body.splice(li, 0, ...trail);
    }
    const all = [...head, ...body, { role: 'system', content: `[지시] 다음 응답은 3문단 이내로. 사용자의 행동은 쓰지 마세요.${VAR_POST ? ` 지금 턴: ${turnIdx}` : ''}` }];
    if (!MERGED) return all;
    // Risu pushPrompts: 모델 이름이 gpt·claude·openrouter·reverse_proxy면 연달은 system 글(memo·name이 같은 것)을 "\n\n"로 합침
    const merged = [];
    for (const chat of all) {
        const endf = merged.at(-1);
        if (chat.role === 'system' && endf && endf.role === 'system' && endf.memo === chat.memo && endf.name === chat.name) endf.content += '\n\n' + chat.content;
        else merged.push({ ...chat });
    }
    return merged;
}

// ---------------------------------------------------------------- 지표
const ser = (msgs) => msgs.map((m) => `${m.role}:${m.content}`).join('\n\u0000');
function commonPrefix(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; }

const rows = [];
const rerollRatios = [];
let prevBase = null, prevOurs = null, prevBaseBody = null, prevOursBody = null;
let retryCount = 0, retryDiff = 0, knownTurn = 0, knownEpoch = 0;
const bakes = [];
const problems = [];
let chatSeq = 0;
const newId = (p) => `${p}-${++chatSeq}`;
const userLines = ['숲으로 가보자.', '성에 들어가 볼까?', '칼을 꺼내 들었다.', '조용히 주위를 살폈다.', '리나에게 말을 걸었다.', '모닥불을 피웠다.', '지도를 펼쳤다.', '물을 마셨다.'];
const replyWords = BIG_LORE ? ['숲', '성', '칼', '길', '사과', '늑대', '신전', '안개', '경비', '시장', '상인'] : ['숲', '성', '칼', '길'];
const pushLog = (entry) => { fetchLogs.push(entry); if (fetchLogs.length > 40) fetchLogs.shift(); };

for (let t = 1; t <= TURNS; t++) {
    clock += 7 * 60 * 1000; // 7분씩 흐름 (시각 줄이 매 턴 바뀜)
    const seedAt = seed;
    const text = userLines[Math.floor(rand() * userLines.length)] + ` (턴 ${t})`;
    raw.message.push({ role: 'user', chatId: newId('u'), data: text });

    // 40턴째: 사용자가 옛 메시지를 직접 고침 (원문 변경 → 반영돼야 함)
    if (t === 40) {
        const target = raw.message[raw.message.length - 5];
        target.data = target.data.replace(/\(턴/, '(수정됨, 턴');
    }

    // 옴니넥서스: 이미지가 끝나면 답장 속 블록을 이미지 토큰으로 바꿔 저장 (다음 요청 전일 수도, 뒤일 수도 있음)
    for (const b of bakes.filter((x) => x.at <= t)) {
        const m = raw.message.find((x) => x.chatId === b.id);
        if (m) m.data = m.data.replace(/\[\[inx1\]\][\s\S]*?\[\[\/inx1\]\]/, `[[@inray::job${t}::inxshot_1]]`);
    }
    bakes.splice(0, bakes.length, ...bakes.filter((x) => x.at > t));
    if (OMNI && t === 30) omniCast.push('레온');

    if (RELOAD && t % RELOAD === 0) await P.forget(); // 새로고침: 플러그인이 메모리에 둔 것을 모두 잊음
    if (MIGRATE && t === 20) {
        // 1.1.x가 남긴 상태 흉내: 버전 표시가 없고, 메인 프롬프트가 "통째로 바뀌는 항목"으로 잘못 올라가 머리에서 빠져 있음
        await P.forget();
        const saved = local.get('cache-jigi:st:' + KEY);
        const mainNow = assemble(t)[0].content;
        delete saved.ver;
        saved.vol.push({ role: 'system', s: [...P.lineHashes(mainNow)].slice(0, 60) });
        saved.head = saved.head.filter((s) => !s.content.includes('당신은 판타지 롤플레이를'));
        seed = seedAt; // assemble을 한 번 더 부른 만큼 난수를 되돌림
    }
    if (PRESS_BTN && t === 8) await P.requestRebuild(KEY);
    const epochBefore = knownEpoch;
    const formated = assemble(t);
    // 요청 보내기. 실패하면 Risu가 바뀐 요청을 다시 플러그인들에 넣어 재시도한다
    let retries = 0;
    while (RETRY && retries < 3 && rand() < RETRY) retries++;
    const attempts = await requestChatData(formated, retries);
    const finalReq = attempts.at(-1);
    for (let i = 1; i < attempts.length; i++) {
        retryCount++;
        if (ser(attempts[i]) !== ser(attempts[0])) { retryDiff++; problems.push(`턴 ${t}: 재시도 요청이 첫 시도와 다름`); }
        pushLog({ url: 'https://aiplatform.googleapis.com/v1/x:streamGenerateContent', body: jsonBody(attempts[i - 1]), status: 503, response: '{"error":{"code":503}}', timestamp: clock + i });
    }
    if ((P.getState(KEY)?.turn ?? 0) > knownTurn + 1) problems.push(`턴 ${t}: 재시도를 새 턴으로 셈`);
    knownTurn = P.getState(KEY)?.turn ?? knownTurn;
    knownEpoch = P.getState(KEY)?.epoch ?? knownEpoch;
    const cutNow = knownEpoch > epochBefore;

    // 대체 모델 흉내: 같은 원본 요청이 한 번 더 들어옴 (출력 전) → 똑같아야 함
    if (t % 15 === 0) {
        const again = (await requestChatData(formated)).at(-1);
        if (ser(again) !== ser(finalReq)) problems.push(`턴 ${t}: 같은 요청을 다시 보냈는데 결과가 다름`);
    }

    // 점검
    const latest = WITH_OBF ? text.replaceAll('칼', '[B64:7Lm8]') : text;
    const latestCount = finalReq.filter((m) => m.content.includes(latest)).length;
    if (latestCount !== 1) problems.push(`턴 ${t}: 최신 입력이 ${latestCount}번 들어감`);
    const special = ['NewChat', 'NewChatExample', 'hypaMemory'];
    const fIds = formated.filter((m) => m.memo && !special.includes(m.memo)).map((m) => m.memo);
    const oIds = finalReq.filter((m) => m.memo && !special.includes(m.memo)).map((m) => m.memo);
    const start = fIds.indexOf(oIds[0]);
    if (start < 0 || fIds.slice(start).join(',') !== oIds.join(',')) problems.push(`턴 ${t}: 대화 순서가 원본의 끝부분과 다름`);
    const cps = finalReq.filter((m) => m.cachePoint).length;
    if (cps > 4) problems.push(`턴 ${t}: 캐시 지점 ${cps}개`);
    if (!finalReq.at(-1).content.includes('[지시]')) problems.push(`턴 ${t}: 맨 끝 지시문이 사라짐`);
    if (CONV === 'pocket' && MODE !== 'safe') {
        // 프리셋 자체가 user 글을 연달아 두는 경우(머리글 + 입력 등)는 원본과 비교
        const pairs = (list) => { const c = toGeminiPocket(list).contents; let n = 0; for (let i = 1; i < c.length; i++) if (c[i].role === 'user' && c[i - 1].role === 'user') n++; return n; };
        if (pairs(finalReq) > pairs(formated)) problems.push(`턴 ${t}: user 메시지가 연달아 나감`);
    }
    const outText = ser(finalReq);
    if (!NO_TIME && !outText.includes(`현재 시각: ${hhmm(clock)}`)) problems.push(`턴 ${t}: 지금 시각이 요청에 없음`);
    if (MODE !== 'safe' && !WITH_OBF && t > 5 && !(NO_TAIL && t <= 4) && !finalReq[0].content.includes('당신은 판타지 롤플레이를 진행하는 작가입니다.')) problems.push(`턴 ${t}: 메인 프롬프트가 요청 맨 앞에서 밀려남`);
    // 머리(대화 앞)의 모든 줄이 요청 어딘가에 남아 있어야 함 (자리를 옮겨도 내용을 잃으면 안 됨)
    if (!WITH_OBF) {
        const firstChat = formated.findIndex((m) => m.memo && !special.includes(m.memo));
        const marker = formated.findIndex((m) => m.memo === 'NewChat');
        const headEnd = marker >= 0 ? marker : (firstChat < 0 ? formated.length : firstChat);
        let lostLines = 0, sample = '';
        for (const m of formated.slice(0, headEnd).filter((x) => x.role === 'system' && x.memo !== 'NewChatExample')) {
            for (const line of m.content.split('\n')) if (line.trim() && !outText.includes(line)) { lostLines++; sample = sample || line; }
        }
        if (lostLines) problems.push(`턴 ${t}: 머리의 줄 ${lostLines}개가 요청에서 사라짐 (예: ${sample.slice(0, 24)})`);
    }
    if (BLOCK) {
        for (const line of blockLines(t)) if (outText.split(line).length !== 2) problems.push(`턴 ${t}: 바뀌는 블록의 줄이 ${outText.split(line).length - 1}번 들어감 (${line.slice(0, 12)})`);
        const stale = blockLines(t - 1).filter((l) => !blockLines(t).includes(l) && outText.includes(l));
        if (t > 1 && stale.length) problems.push(`턴 ${t}: 지난 턴의 블록 내용이 남아 있음 (${stale[0].slice(0, 12)})`);
    }
    if (t === 40) {
        const edited = raw.message[raw.message.length - 5];
        const inReq = finalReq.find((m) => m.memo === edited.chatId);
        if (inReq && !inReq.content.includes('수정됨')) problems.push(`턴 ${t}: 사용자가 고친 메시지가 반영되지 않음`);
    }
    // 정리 턴에는 지금 안 켜진 로어북이 요청에 남아 있으면 안 됨
    if (cutNow) {
        for (const l of [...lore, randomLore]) if (!ser(formated).includes(l.text) && outText.includes(l.text)) problems.push(`턴 ${t}: 정리 턴인데 꺼진 로어북이 남음 (${l.text.slice(0, 8)})`);
    }
    if (VAR_LORE && t >= 10) {
        const count = finalReq.filter((m) => m.content.includes('[상황판]')).length;
        if (count > 2) problems.push(`턴 ${t}: 값이 바뀐 로어북이 ${count}개나 쌓임`);
        if (!outText.includes(`마을 경계도: ${Math.floor(t / 7)}`)) problems.push(`턴 ${t}: 로어북의 최신 값이 요청에 없음`);
    }
    if (PRESS_BTN && t === 8) {
        if (oIds.length !== fIds.length) problems.push(`턴 ${t}: 지금 정리하기가 대화 ${fIds.length - oIds.length}개를 지움`);
        if (P.getState(KEY).forceRebuild) problems.push(`턴 ${t}: 지금 정리하기가 처리되지 않음`);
        for (const l of [...lore, randomLore]) if (!ser(formated).includes(l.text) && outText.includes(l.text)) problems.push(`턴 ${t}: 지금 정리하기 뒤에도 꺼진 로어북이 남음 (${l.text.slice(0, 8)})`);
    }
    if (OMNI) {
        const rules = finalReq.filter((m) => m.content.includes(OMNI_RULES_HEAD)).length;
        const state = finalReq.filter((m) => m.content.includes('# Omni Nexus - image state')).length;
        if (rules !== 1) problems.push(`턴 ${t}: 옴니넥서스 규칙이 ${rules}번 들어감`);
        if (state < 1 || state > 2) problems.push(`턴 ${t}: 옴니넥서스 상태가 ${state}번 들어감`);
        if (!finalReq.some((m) => m.content.includes(omniState()))) problems.push(`턴 ${t}: 옴니넥서스 최신 상태가 요청에 없음`);
    }
    const sizeIn = ser(formated).length, sizeOut = outText.length;

    const bs = ser(formated), os = outText;
    const oursBody = serBody(finalReq);
    const g4ours = gemini4Ratio(prevOursBody, oursBody);
    if (prevBase != null) {
        rows.push({
            t,
            base: commonPrefix(prevBase, bs) / bs.length,
            ours: commonPrefix(prevOurs, os) / os.length,
            g4base: gemini4Ratio(prevBaseBody, serBody(formated)),
            g4ours,
            sizeIn, sizeOut,
        });
        // 실제 사용량 표시: 보조 호출의 작은 사용량은 무시하고 본 요청 사용량만 기록해야 함
        await P.onBody({ usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 5 } }, 'meta_gemini');
        const usage = { promptTokenCount: Math.round(os.length / TOK), cachedContentTokenCount: Math.round(commonPrefix(prevOurs, os) / TOK) };
        await P.onBody(t % 2 ? { usageMetadata: usage } : { __usageMetadata: JSON.stringify(usage) }, t % 2 ? 'meta_gemini' : 'meta_gemini_stream');
        const stat = P.getState(KEY)?.stats.at(-1);
        if ((!stat || stat.promptT !== usage.promptTokenCount) && !(NO_TAIL && t <= 4) && !(MIGRATE && t === 20)) problems.push(`턴 ${t}: 실제 사용량이 기록되지 않음`);
    }
    // 포켓리스 요청 기록 흉내: 진짜 본문과, 구글이 돌려줬을 사용량(스트리밍 응답 글)
    {
        const promptT = Math.round(oursBody.length / TOK), cachedT = Math.round(g4ours * oursBody.length / TOK);
        const sse = `data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}],"usageMetadata":{"promptTokenCount":${promptT}}}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"."}]}}],"usageMetadata":{"promptTokenCount":${promptT},"candidatesTokenCount":300${cachedT ? `,"cachedContentTokenCount":${cachedT}` : ''}}}\n\n`;
        pushLog({ url: 'https://aiplatform.googleapis.com/v1/x:streamGenerateContent', body: jsonBody(finalReq), status: 200, response: sse, timestamp: clock + 10 });
    }
    prevBase = bs; prevOurs = os;
    prevBaseBody = serBody(formated); prevOursBody = oursBody;

    // AI 답장 (상태창 포함) → 출력 알림
    const filler = LONG ? ' 바람이 불었고 모닥불이 흔들렸다. 리나는 잠시 말을 고르다가 칼자루를 고쳐 쥐었다. 멀리서 부엉이가 울었다.'.repeat(9) : '';
    const omniBlock = OMNI ? `\n[[inx1]]{"tags":"1girl, forest, night","turn":${t}}[[/inx1]]\n뒤이어 바람이 불었다.` : '';
    const reply = `리나가 고개를 끄덕였다. "${replyWords[Math.floor(rand() * replyWords.length)]}에 대해서라면 알아."${filler}${omniBlock} <상태>호감도 ${10 + t} / 시각 ${hhmm(clock)}</상태>`;
    raw.message.push({ role: 'assistant', chatId: newId('a'), data: reply });
    P.onOutput();
    if (OMNI) {
        bakes.push({ id: raw.message.at(-1).chatId, at: t + Math.floor(rand() * 3) });
        // 태거 보조 호출(메인 모델로 나가는 경우): 캐시지기는 그대로 통과시키고 턴도 안 늘어야 함
        const turnBefore = P.getState(KEY)?.turn;
        const tagger = [{ role: 'system', content: '# tagger' }, { role: 'user', content: reply }];
        const tagged = (await requestChatData(tagger)).at(-1);
        if ((!WITH_OBF && ser(tagged) !== ser(tagger)) || P.getState(KEY)?.turn !== turnBefore) problems.push(`턴 ${t}: 태거 호출을 건드림`);
        pushLog({ url: 'https://aiplatform.googleapis.com/v1/x:generateContent', body: JSON.stringify({ systemInstruction: { parts: [{ text: '# tagger' }] }, contents: [{ role: 'user', parts: [{ text: reply }] }] }), status: 200, response: '{"usageMetadata":{"promptTokenCount":400}}', timestamp: clock + 20 });
    }

    // 리롤 흉내: 답장을 지우고 같은 턴을 다시 요청 → 첫 요청과 앞부분이 거의 같아야 함
    if (t % 20 === 5) {
        const savedSeed = seed;
        raw.message.pop();
        const again = (await requestChatData(assemble(t))).at(-1);
        const ratio = commonPrefix(ser(finalReq), ser(again)) / ser(again).length;
        // 무작위 요약·안전 모드는 입력 자체가 리롤마다 달라서 차이가 날 수 있음 (기록만)
        if (ratio < 0.85 && MODE !== 'safe' && !WITH_MEMORY) problems.push(`턴 ${t}: 리롤 요청이 첫 요청과 많이 다름 (${(ratio * 100).toFixed(1)}%)`);
        rerollRatios.push(ratio);
        raw.message.push({ role: 'assistant', chatId: newId('a'), data: reply });
        P.onOutput();
        seed = savedSeed;
    }
    if (t === TURNS && args.bp === '1') {
        const marks = finalReq.map((m, i) => (m.cachePoint ? `${i}:${m.role}:${m.content.slice(0, 18).replace(/\n/g, ' ')}` : null)).filter(Boolean);
        console.log('마지막 요청 캐시 지점:', marks.join(' | '), `(총 ${finalReq.length}개 메시지)`);
    }
    if (t === TURNS && args.dump === '1') {
        const b = toBody(finalReq);
        console.log('--- 시스템 지시문 끝 400자 ---\n' + b.system.slice(-400));
        for (const c of b.contents.slice(-3)) console.log(`--- ${c.role} ---\n` + (c.text.length > 700 ? c.text.slice(0, 500) + '\n ... \n' + c.text.slice(-150) : c.text));
    }
}

// ---------------------------------------------------------------- 실제 확인 기능 점검 (요청 기록에서 진짜 본문과 캐시 토큰을 읽어 내는지)
let real = null;
if (P.realCheck) {
    real = await P.realCheck(KEY);
    const tail = rows.slice(-4);
    const expect = tail.length ? tail.reduce((s, x) => s + x.g4ours, 0) / tail.length : 0;
    const got = (real.rows || []).slice(-4).filter((r) => r.real != null);
    if (real.error) problems.push(`실제 확인: 오류 (${real.error})`);
    else if (TURNS >= 12 && MODE !== 'safe') {
        if (got.length < 3) problems.push(`실제 확인: 본 요청을 ${got.length}개만 찾음`);
        else {
            const avg = got.reduce((s, r) => s + r.real, 0) / got.length;
            if (Math.abs(avg - expect) > 0.02) problems.push(`실제 확인: 읽은 값 ${(avg * 100).toFixed(1)}%가 기대 ${(expect * 100).toFixed(1)}%와 다름`);
            if (expect >= 0.5 && real.verdict.tone !== 'good') problems.push(`실제 확인: 잘 되는데 판정이 ${real.verdict.tone}`);
        }
    }
}

// ---------------------------------------------------------------- 결과
const avg = (k, from = 0) => { const r = rows.filter((x) => x.t > from); return r.reduce((s, x) => s + x[k], 0) / r.length; };
const breaks = (k, lim = 0.5) => rows.filter((x) => x[k] < lim).length;
const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`모드=${MODE} 턴=${TURNS} 예산=${BUDGET} 단어바꾸기=${WITH_OBF ? '켬' : '끔'} 무작위요약=${WITH_MEMORY ? '켬' : '끔'}`);
console.log(`평균 재사용 가능 앞부분: 플러그인 없음 ${pct(avg('base'))} → 캐시지기 ${pct(avg('ours'))}`);
console.log(`앞부분 50% 미만으로 깨진 턴: 없음 ${breaks('base')}개 → 캐시지기 ${breaks('ours')}개 (총 ${rows.length}턴)`);
console.log(`요청 크기 평균: 원본 ${Math.round(avg('sizeIn'))}자 → 캐시지기 ${Math.round(avg('sizeOut'))}자`);
console.log(`Gemini 4 규칙 적용 (${{ risu: 'Risu 기본', pm: 'Provider Manager', pocket: '포켓리스 프리셋' }[CONV]} 변환 본문): 플러그인 없음 ${pct(avg('g4base'))} → 캐시지기 ${pct(avg('g4ours'))} · 캐시가 20% 밑으로 떨어진 턴 ${breaks('g4ours', 0.2)}개`);
if (RETRY) console.log(`재시도 ${retryCount}번 중 첫 시도와 다르게 나간 것: ${retryDiff}번`);
if (rerollRatios.length) console.log(`리롤 때 첫 요청과 같은 앞부분: ${rerollRatios.map(pct).join(', ')}`);
if (real && !real.error) console.log(`실제 확인 기능: ${real.verdict.text}`);
if (args.rows === '1') for (const r of rows) console.log(`턴${String(r.t).padStart(3)}  없음 ${pct(r.base).padStart(6)}  캐시지기 ${pct(r.ours).padStart(6)}  G4 ${pct(r.g4ours).padStart(6)}  크기 ${r.sizeIn}→${r.sizeOut}`);
const st = P.getState([...local.keys()].find((k) => k.startsWith('cache-jigi:st:'))?.slice(14) || '0:chat-1');
if (st) {
    console.log(`장부 ${st.ledger.length}개 · 변동 줄 규칙 ${st.rules.length}개 · 매번 바뀌는 항목 ${st.vol.length}개 · 정리 횟수 ${st.epoch}`);
    if (args.events === '1') for (const e of st.events.slice().reverse()) console.log(`  · ${e.text}`);
}
if (args.report === '1' && real && real.report) console.log('--- 진단 내용 ---\n' + real.report);
if (problems.length) { console.log(`문제 ${problems.length}개:`); for (const p of problems.slice(0, 20)) console.log('  - ' + p); process.exitCode = 1; }
else console.log('점검: 문제 없음');
