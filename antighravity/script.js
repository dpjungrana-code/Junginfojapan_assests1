// ============================================================
//  JLPT Kanji Mastery — script.js
// ============================================================

// ── State ──────────────────────────────────────────────────
let currentLevel = '5';
let currentTab   = 'kanji';   // tracks which section is visible
let kanjiList    = [];
let currentIdx   = 0;
let favorites    = JSON.parse(localStorage.getItem('jlpt_favs') || '[]');
let isDark       = localStorage.getItem('jlpt_theme') === 'dark';
let hw           = null;
let currentAudio = null;
let currentListen = null;
let listenAnswered = false;
let readingData  = null;   // persists across tab switches; cleared on level change
let newsData     = null;   // persists across tab switches; cleared on level change
let furiganaOn   = true;

// ── Cached sessionStorage (LRU-lite: evict oldest on overflow) ──
const NS = 'jlpt3_';
function cGet(k) {
    try { return JSON.parse(sessionStorage.getItem(NS + k)); } catch { return null; }
}
function cSet(k, v) {
    try {
        sessionStorage.setItem(NS + k, JSON.stringify(v));
    } catch (e) {
        // QuotaExceededError — clear oldest entries then retry
        const keys = Object.keys(sessionStorage).filter(sk => sk.startsWith(NS));
        if (keys.length > 0) {
            sessionStorage.removeItem(keys[0]);
            try { sessionStorage.setItem(NS + k, JSON.stringify(v)); } catch {}
        }
    }
}

// ── Loading ─────────────────────────────────────────────────
function showLoad(t = 'Loading...') {
    document.getElementById('loading-text').textContent = t;
    document.getElementById('loading-overlay').classList.remove('hidden');
}
function hideLoad() { document.getElementById('loading-overlay').classList.add('hidden'); }

// ── Theme ───────────────────────────────────────────────────
function applyTheme() {
    document.body.classList.toggle('dark', isDark);
    document.getElementById('theme-btn').textContent = isDark ? '☀️' : '🌙';
}
document.getElementById('theme-btn').addEventListener('click', () => {
    isDark = !isDark;
    localStorage.setItem('jlpt_theme', isDark ? 'dark' : 'light');
    applyTheme();
    if (hw) hw.updateColor('strokeColor', isDark ? '#f1f5f9' : '#0f172a');
});
applyTheme();

// ── Speech ──────────────────────────────────────────────────
function speak(text) {
    if (!text || text === '—') return;
    stopAudio('stop');
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = 0.9;
    window.speechSynthesis.speak(u);
    currentAudio = { type: 'speech', obj: u };
}
function stopAudio(action = 'stop') {
    if (!currentAudio) return;
    if (currentAudio.type === 'html') {
        if (action === 'pause') currentAudio.obj.pause();
        else { currentAudio.obj.pause(); currentAudio.obj.currentTime = 0; }
    } else {
        if (action === 'pause') window.speechSynthesis.pause();
        else window.speechSynthesis.cancel();
    }
    if (action === 'stop') currentAudio = null;
}

// ── Proxy Fetch (sequential, noise-free) ─────────────────────
// Tries each proxy quietly; rejects only after all fail.
const PROXY_MS = 6000;

async function tryProxy(url) {
    const enc = encodeURIComponent(url);
    const ts  = Date.now();
    const proxies = [
        { url: `https://api.codetabs.com/v1/proxy?quest=${enc}`,             mode: 'raw'  },
        { url: `https://api.allorigins.win/get?url=${enc}&ts=${ts}`,          mode: 'wrap' },
        { url: `https://corsproxy.io/?${enc}`,                                mode: 'raw'  },
    ];
    for (const p of proxies) {
        try {
            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), PROXY_MS);
            const r    = await fetch(p.url, { signal: ctrl.signal });
            clearTimeout(tid);
            if (!r.ok) continue;
            const txt = await r.text();
            if (p.mode === 'wrap') {
                const wrapper = JSON.parse(txt);
                return JSON.parse(wrapper.contents);
            }
            return JSON.parse(txt);
        } catch { /* try next */ }
    }
    throw new Error('All proxies failed');
}

async function proxyFetch(url) { return tryProxy(url); }

// ── Shuffle ──────────────────────────────────────────────────
function shuffle(a) {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
}

// ── Navigation ──────────────────────────────────────────────
const SECTIONS = ['kanji','reading','news','listening','voice','search'];

/**
 * Normalize the JSON key for the current level.
 * Our JSON files use numeric string keys: '5','4','3','2','1'.
 * This helper also handles 'N5'-style keys in case of future edits.
 */
function getLevelKey(data, lvl) {
    if (lvl === 'favorites') lvl = '5';
    // Try bare number key first ('5'), then prefixed ('N5'), fallback to '5'
    return data[lvl] || data['N' + lvl] || data['5'] || [];
}

function switchTab(tab) {
    currentTab = tab; // ← track active tab
    SECTIONS.forEach(id => {
        document.getElementById(`sec-${id}`).classList.toggle('active', id === tab);
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    stopAudio('stop');
    if (tab === 'reading')   loadReading();
    if (tab === 'news')      loadNews();
    if (tab === 'listening') loadListening();
    if (tab === 'voice')     loadVoice();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ── Level Pills ─────────────────────────────────────────────
document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentLevel  = btn.dataset.level;
        currentListen = null;
        // NOTE: readingData/newsData hold ALL levels so we keep them cached.
        // getLevelKey() will re-filter to the new level on each render call.

        // Always reload kanji
        initKanji();

        // ── CRITICAL FIX: also reload whichever content tab is visible ──
        // Without this, switching N5→N4 while on Reading shows N5 content.
        switch (currentTab) {
            case 'reading':   loadReading();   break;
            case 'news':      loadNews();      break;
            case 'listening': loadListening(); break;
            case 'voice':     loadVoice();     break;
        }
    });
});

// ============================================================
//  KANJI
// ============================================================
async function initKanji() {
    showLoad(`Loading N${currentLevel}...`);
    try {
        if (currentLevel === 'favorites') {
            kanjiList = [...favorites];
        } else {
            let cached = cGet('list_n' + currentLevel);
            if (!cached) {
                const r = await fetch(`https://kanjiapi.dev/v1/kanji/jlpt-${currentLevel}`);
                if (!r.ok) throw new Error('API error');
                cached = await r.json();
                cSet('list_n' + currentLevel, cached);
            }
            kanjiList = cached;
        }
        kanjiList = shuffle(kanjiList);
        currentIdx = 0;
        if (kanjiList.length) await loadKanji(0);
        else document.getElementById('kanji-meanings').textContent =
            currentLevel === 'favorites' ? 'No favourites yet! ⭐' : 'No data';
    } catch (e) {
        console.error(e);
        document.getElementById('kanji-meanings').textContent = 'Network error — check connection';
    }
    hideLoad();
}

async function loadKanji(idx) {
    const char = kanjiList[idx];
    document.getElementById('progress-chip').textContent = `${idx + 1} / ${kanjiList.length}`;

    let data = cGet('kd_' + char);
    if (!data) {
        try {
            const r = await fetch(`https://kanjiapi.dev/v1/kanji/${char}`);
            data = await r.json();
            cSet('kd_' + char, data);
        } catch (e) { return; }
    }

    document.getElementById('kanji-meanings').textContent = (data.meanings || []).slice(0, 4).join(', ') || '—';
    document.getElementById('kanji-on').textContent  = (data.on_readings  || []).join(', ') || '—';
    document.getElementById('kanji-kun').textContent = (data.kun_readings || []).join(', ') || '—';
    updateStar(char);

    // HanziWriter — 200×200 matches the CSS exactly
    if (!hw) {
        hw = HanziWriter.create('hw-target', char, {
            width: 200, height: 200, padding: 10,
            strokeColor: isDark ? '#f1f5f9' : '#0f172a',
            strokeAnimationSpeed: 1,
            delayBetweenStrokes: 200,
            showHintAfterMisses: 3,
        });
    } else {
        hw.setCharacter(char);
    }
}

function updateStar(char) {
    const btn = document.getElementById('btn-star');
    const starred = favorites.includes(char);
    btn.textContent = starred ? '★' : '☆';
    btn.style.color = starred ? '#f59e0b' : '';
}

document.getElementById('btn-next').addEventListener('click', () => { if (currentIdx < kanjiList.length - 1) loadKanji(++currentIdx); });
document.getElementById('btn-prev').addEventListener('click', () => { if (currentIdx > 0) loadKanji(--currentIdx); });
document.getElementById('btn-hint').addEventListener('click', () => hw?.animateCharacter());
document.getElementById('btn-quiz').addEventListener('click', () => hw?.quiz());
document.getElementById('btn-speak-kanji').addEventListener('click', () => speak(kanjiList[currentIdx]));
document.getElementById('btn-star').addEventListener('click', () => {
    const char = kanjiList[currentIdx];
    const i = favorites.indexOf(char);
    if (i === -1) favorites.push(char); else favorites.splice(i, 1);
    localStorage.setItem('jlpt_favs', JSON.stringify(favorites));
    updateStar(char);
});

// ============================================================
//  READING
// ============================================================
async function loadReading() {
    const lvl = currentLevel === 'favorites' ? '5' : currentLevel;
    document.getElementById('reading-level-label').textContent = `JLPT N${lvl} Reading`;
    const area = document.getElementById('reading-content');
    // Show spinner immediately so user knows it's reloading on level switch
    area.innerHTML = '<div class="loading-stub"><div class="spinner"></div><span>Loading story…</span></div>';

    try {
        if (!readingData) {
            const r = await fetch('data/reading.json');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            readingData = await r.json();
        }
        // getLevelKey handles '5' and 'N5' key formats and always returns an array
        const pool  = getLevelKey(readingData, lvl);
        if (!pool.length) throw new Error(`No stories found for N${lvl}`);
        const story = pool[Math.floor(Math.random() * pool.length)];

        area.innerHTML = `
            <div class="section-title">${story.title}</div>
            <div class="passage" id="reading-text">${story.jap}</div>
            <div class="lookup-box" id="reading-lookup">Select/tap a word to look it up</div>
            <div class="translation-box" id="reading-eng" style="display:none">${story.eng}</div>
            <div class="btn-row">
                <button class="btn btn-primary btn-full" id="btn-show-trans">👁 Show Translation</button>
                <button class="btn btn-icon" id="btn-furigana-read" title="Toggle furigana">${furiganaOn ? '文' : '文'}</button>
            </div>
            <div class="grammar-list">${story.grammar.map(g => `<div class="grammar-item">• ${g}</div>`).join('')}</div>
        `;

        // Apply current furigana state
        applyFurigana('reading-text');

        // Translation toggle
        document.getElementById('btn-show-trans').addEventListener('click', function () {
            const el = document.getElementById('reading-eng');
            const vis = el.style.display !== 'none';
            el.style.display = vis ? 'none' : 'block';
            this.textContent = vis ? '👁 Show Translation' : '🙈 Hide Translation';
        });

        // Furigana toggle (reading)
        document.getElementById('btn-furigana-read').addEventListener('click', () => {
            furiganaOn = !furiganaOn;
            applyFurigana('reading-text');
        });

        // Hover/tap lookup
        attachLookup('reading-text', 'reading-lookup');

    } catch (e) {
        area.innerHTML = `<div class="error-state">❌ Could not load data/reading.json<br><small>Ensure the file exists.</small></div>`;
    }
}
document.getElementById('btn-next-story').addEventListener('click', loadReading);

// ============================================================
//  NEWS
// ============================================================
async function loadNews() {
    const lvl = currentLevel === 'favorites' ? '5' : currentLevel;
    document.getElementById('news-level-label').textContent = `JLPT N${lvl} News`;
    const area = document.getElementById('news-content');
    // Show spinner immediately so user knows it's reloading on level switch
    area.innerHTML = '<div class="loading-stub"><div class="spinner"></div><span>Loading news…</span></div>';

    try {
        if (!newsData) {
            const r = await fetch('data/news.json');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            newsData = await r.json();
        }
        // getLevelKey handles '5' and 'N5' key formats and always returns an array
        const items = getLevelKey(newsData, lvl);

        area.innerHTML = `
            <div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
                <button class="btn btn-icon" id="btn-furigana-news" title="Toggle furigana">文/よ</button>
            </div>
            ${items.map(n => `
                <div class="news-item" id="news-${n.id}">
                    <div class="news-meta">
                        ${n.category ? `<span class="news-cat">${n.category}</span>` : ''}
                        <span class="news-date">${n.date || ''}</span>
                    </div>
                    <div class="news-title">${n.title}</div>
                    <div class="news-text" id="news-text-${n.id}">${n.text}</div>
                    <div class="lookup-box" id="news-lookup-${n.id}">Select a word to look it up</div>
                </div>
            `).join('')}
        `;

        // Apply furigana state to all news texts
        items.forEach(n => {
            applyFurigana(`news-text-${n.id}`);
            attachLookup(`news-text-${n.id}`, `news-lookup-${n.id}`);
        });

        // Furigana toggle (news)
        document.getElementById('btn-furigana-news').addEventListener('click', () => {
            furiganaOn = !furiganaOn;
            items.forEach(n => applyFurigana(`news-text-${n.id}`));
            applyFurigana(`news-title`); // also re-run titles if needed
        });

    } catch (e) {
        area.innerHTML = `<div class="error-state">❌ Could not load data/news.json</div>`;
    }
}

// ── Furigana helpers ───────────────────────────────────────
function applyFurigana(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.classList.toggle('hide-furigana', !furiganaOn);
}

// ── Offline vocabulary dictionary (common JLPT words) ────────
// Used for instant hover/tap lookup without any network call.
const LOCAL_DICT = {
    '私':    { r:'わたし',    m:'I, me' },
    '学生':  { r:'がくせい',  m:'student' },
    '先生':  { r:'せんせい',  m:'teacher' },
    '電車':  { r:'でんしゃ',  m:'train' },
    '会社':  { r:'かいしゃ',  m:'company, office' },
    '家':    { r:'いえ',      m:'house, home' },
    '時間':  { r:'じかん',    m:'time, hour' },
    '毎日':  { r:'まいにち',  m:'every day' },
    '友達':  { r:'ともだち',  m:'friend' },
    '仕事':  { r:'しごと',    m:'work, job' },
    '日本':  { r:'にほん',    m:'Japan' },
    '日本語':{ r:'にほんご',  m:'Japanese language' },
    '食べ物':{ r:'たべもの',  m:'food' },
    '飲み物':{ r:'のみもの',  m:'drink, beverage' },
    '映画':  { r:'えいが',    m:'movie, film' },
    '音楽':  { r:'おんがく',  m:'music' },
    '本':    { r:'ほん',      m:'book' },
    '話':    { r:'はなし',    m:'story, talk' },
    '言葉':  { r:'ことば',    m:'word, language' },
    '名前':  { r:'なまえ',    m:'name' },
    '場所':  { r:'ばしょ',    m:'place, location' },
    '駅':    { r:'えき',      m:'station' },
    '店':    { r:'みせ',      m:'shop, store' },
    '病院':  { r:'びょういん',m:'hospital' },
    '学校':  { r:'がっこう',  m:'school' },
    '図書館':{ r:'としょかん',m:'library' },
    '公園':  { r:'こうえん',  m:'park' },
    '道':    { r:'みち',      m:'road, way' },
    '部屋':  { r:'へや',      m:'room' },
    '机':    { r:'つくえ',    m:'desk' },
    '窓':    { r:'まど',      m:'window' },
    '心':    { r:'こころ',    m:'heart, mind' },
    '体':    { r:'からだ',    m:'body' },
    '目':    { r:'め',        m:'eye' },
    '手':    { r:'て',        m:'hand' },
    '空':    { r:'そら',      m:'sky' },
    '海':    { r:'うみ',      m:'sea, ocean' },
    '山':    { r:'やま',      m:'mountain' },
    '花':    { r:'はな',      m:'flower' },
    '木':    { r:'き',        m:'tree' },
    '水':    { r:'みず',      m:'water' },
    '火':    { r:'ひ',        m:'fire' },
    '空気':  { r:'くうき',    m:'air, atmosphere' },
    '天気':  { r:'てんき',    m:'weather' },
    '雨':    { r:'あめ',      m:'rain' },
    '雪':    { r:'ゆき',      m:'snow' },
    '風':    { r:'かぜ',      m:'wind' },
    '夏':    { r:'なつ',      m:'summer' },
    '冬':    { r:'ふゆ',      m:'winter' },
    '春':    { r:'はる',      m:'spring' },
    '秋':    { r:'あき',      m:'autumn, fall' },
    '朝':    { r:'あさ',      m:'morning' },
    '昼':    { r:'ひる',      m:'noon, daytime' },
    '夜':    { r:'よる',      m:'night, evening' },
    '今日':  { r:'きょう',    m:'today' },
    '明日':  { r:'あした',    m:'tomorrow' },
    '昨日':  { r:'きのう',    m:'yesterday' },
    '今':    { r:'いま',      m:'now' },
    '先週':  { r:'せんしゅう',m:'last week' },
    '来週':  { r:'らいしゅう',m:'next week' },
    '来月':  { r:'らいげつ',  m:'next month' },
    '今年':  { r:'ことし',    m:'this year' },
    '子供':  { r:'こども',    m:'child' },
    '家族':  { r:'かぞく',    m:'family' },
    '父':    { r:'ちち',      m:'father (own)' },
    '母':    { r:'はは',      m:'mother (own)' },
    '兄':    { r:'あに',      m:'older brother (own)' },
    '妹':    { r:'いもうと',  m:'younger sister (own)' },
    '夢':    { r:'ゆめ',      m:'dream' },
    '将来':  { r:'しょうらい',m:'future' },
    '生活':  { r:'せいかつ',  m:'daily life, living' },
    '社会':  { r:'しゃかい',  m:'society' },
    '問題':  { r:'もんだい',  m:'problem, issue' },
    '経済':  { r:'けいざい',  m:'economy' },
    '政府':  { r:'せいふ',    m:'government' },
    '環境':  { r:'かんきょう',m:'environment' },
    '技術':  { r:'ぎじゅつ',  m:'technology, technique' },
    '情報':  { r:'じょうほう',m:'information' },
    '研究':  { r:'けんきゅう',m:'research, study' },
    '発展':  { r:'はってん',  m:'development, growth' },
    '影響':  { r:'えいきょう',m:'influence, effect' },
    '重要':  { r:'じゅうよう',m:'important' },
    '必要':  { r:'ひつよう',  m:'necessary, need' },
    '可能':  { r:'かのう',    m:'possible' },
    '理由':  { r:'りゆう',    m:'reason, cause' },
    '結果':  { r:'けっか',    m:'result, outcome' },
    '方法':  { r:'ほうほう',  m:'method, way' },
    '目的':  { r:'もくてき',  m:'purpose, objective' },
    '意見':  { r:'いけん',    m:'opinion, view' },
    '考え':  { r:'かんがえ',  m:'thought, idea' },
    '気持ち':{ r:'きもち',    m:'feeling, mood' },
    '普及':  { r:'ふきゅう',  m:'spread, popularization' },
    '変化':  { r:'へんか',    m:'change' },
    '増加':  { r:'ぞうか',    m:'increase' },
    '減少':  { r:'げんしょう',m:'decrease' },
    '解決':  { r:'かいけつ',  m:'solution, resolution' },
    '人々':  { r:'ひとびと',  m:'people' },
    '個人':  { r:'こじん',    m:'individual, personal' },
    '国':    { r:'くに',      m:'country, nation' },
    '世界':  { r:'せかい',    m:'world' },
    '文化':  { r:'ぶんか',    m:'culture' },
    '言語':  { r:'げんご',    m:'language' },
    '知識':  { r:'ちしき',    m:'knowledge' },
    '経験':  { r:'けいけん',  m:'experience' },
    '努力':  { r:'どりょく',  m:'effort, hard work' },
    '成功':  { r:'せいこう',  m:'success' },
    '失敗':  { r:'しっぱい',  m:'failure' },
    '健康':  { r:'けんこう',  m:'health' },
    '運動':  { r:'うんどう',  m:'exercise, movement' },
    '食事':  { r:'しょくじ',  m:'meal, diet' },
    '旅行':  { r:'りょこう',  m:'travel, trip' },
    '準備':  { r:'じゅんび',  m:'preparation' },
    '発表':  { r:'はっぴょう',m:'presentation, announcement' },
    '勉強':  { r:'べんきょう',m:'study' },
    '練習':  { r:'れんしゅう',m:'practice' },
    '上手':  { r:'じょうず',  m:'skilled, good at' },
    '大切':  { r:'たいせつ',  m:'important, precious' },
    '有名':  { r:'ゆうめい',  m:'famous' },
    '特別':  { r:'とくべつ',  m:'special' },
    '自分':  { r:'じぶん',    m:'oneself, I' },
    '一方':  { r:'いっぽう',  m:'one side; on the other hand' },
    '同時':  { r:'どうじ',    m:'simultaneously, at the same time' },
    '一番':  { r:'いちばん',  m:'number one, the most' },
    '最初':  { r:'さいしょ',  m:'first, beginning' },
    '最後':  { r:'さいご',    m:'last, final' },
    '特に':  { r:'とくに',    m:'especially, particularly' },
    '少子化':{ r:'しょうしか',m:'declining birth rate' },
    '温暖化':{ r:'おんだんか',m:'global warming' },
};

function localLookup(sel) {
    if (LOCAL_DICT[sel]) return LOCAL_DICT[sel];
    // Try progressive prefix matching for compound words
    for (let len = Math.min(sel.length, 4); len >= 1; len--) {
        const sub = sel.slice(0, len);
        if (LOCAL_DICT[sub]) return { ...LOCAL_DICT[sub], partial: true, query: sub };
    }
    return null;
}

// ── Hover/Tap lookup (offline-first) ─────────────────────────
let lookupDebounce;
function attachLookup(textElId, lookupElId) {
    const textEl   = document.getElementById(textElId);
    const lookupEl = document.getElementById(lookupElId);
    if (!textEl || !lookupEl) return;

    const handler = () => {
        clearTimeout(lookupDebounce);
        lookupDebounce = setTimeout(async () => {
            const sel = window.getSelection()?.toString().trim();
            if (!sel || sel.length > 8 || sel.length < 1) return;
            lookupEl.classList.add('visible');

            // 1. Try local dictionary first (instant)
            const local = localLookup(sel);
            if (local) {
                const q = local.partial ? local.query : sel;
                lookupEl.innerHTML = `<strong>${q}</strong> [${local.r}] — ${local.m}${local.partial ? ` <em style="color:var(--text-muted);font-size:.8em">(partial match)</em>` : ''}`;
                return; // Done — no network needed
            }

            // 2. Network fallback (shows loading while trying)
            lookupEl.textContent = `Looking up "${sel}"…`;
            try {
                const data = await proxyFetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(sel)}`);
                if (data?.data?.length) {
                    const item = data.data[0];
                    const word = item.japanese[0]?.word || item.japanese[0]?.reading || sel;
                    const read = item.japanese[0]?.reading || '';
                    const mean = item.senses[0]?.english_definitions?.join(', ') || '—';
                    lookupEl.innerHTML = `<strong>${word}</strong>${read && read !== word ? ` [${read}]` : ''} — ${mean}`;
                } else {
                    lookupEl.textContent = `No result for "${sel}"`;
                }
            } catch {
                lookupEl.textContent = `"${sel}" — not in offline dictionary.`;
            }
        }, 380);
    };
    textEl.addEventListener('mouseup', handler);
    textEl.addEventListener('touchend', handler);
}

// ============================================================
//  LISTENING (fully static + TTS — no proxy needed)
// ============================================================
const LISTEN_BANK = {
    '5': [
        { jap:'これはペンです。', eng:'This is a pen.' },
        { jap:'私は学生です。', eng:'I am a student.' },
        { jap:'今日は天気がいいです。', eng:'The weather is nice today.' },
        { jap:'電車は九時に来ます。', eng:'The train comes at nine o\'clock.' },
        { jap:'ここはどこですか。', eng:'Where is this place?' },
        { jap:'水をください。', eng:'Please give me some water.' },
        { jap:'私の名前は田中です。', eng:'My name is Tanaka.' },
        { jap:'あの建物は図書館です。', eng:'That building is a library.' },
    ],
    '4': [
        { jap:'この映画はとても面白かったです。', eng:'This movie was very interesting.' },
        { jap:'昨日、友達と公園へ行きました。', eng:'Yesterday I went to the park with a friend.' },
        { jap:'もっとゆっくり話してください。', eng:'Please speak more slowly.' },
        { jap:'来週、日本語のテストがあります。', eng:'There is a Japanese test next week.' },
        { jap:'その店はどこにありますか。', eng:'Where is that shop?' },
        { jap:'駅まで歩いて十分かかります。', eng:'It takes ten minutes to walk to the station.' },
        { jap:'彼はいつも早く起きます。', eng:'He always wakes up early.' },
    ],
    '3': [
        { jap:'彼女は仕事が忙しくて、なかなか休めません。', eng:'She is so busy with work that she can rarely rest.' },
        { jap:'このレポートを明日までに仕上げなければなりません。', eng:'I have to finish this report by tomorrow.' },
        { jap:'最近、運動不足なので、ジムに通い始めました。', eng:'Because I haven\'t been exercising lately, I started going to the gym.' },
        { jap:'彼が来るかどうか、まだわかりません。', eng:'I still don\'t know whether he will come or not.' },
        { jap:'この問題を解くには、もっと時間が必要です。', eng:'More time is needed to solve this problem.' },
    ],
    '2': [
        { jap:'経済の動向を把握するためには、日頃からニュースをチェックすることが重要です。', eng:'To understand economic trends, it is important to check the news regularly.' },
        { jap:'文化の違いを理解することは、国際的なビジネスにおいて非常に重要です。', eng:'Understanding cultural differences is extremely important in international business.' },
        { jap:'環境問題を解決するためには、個人の意識改革が欠かせません。', eng:'To solve environmental issues, a change in individual awareness is indispensable.' },
    ],
    '1': [
        { jap:'この問題を解決するには、従来の枠組みを超えた発想が不可欠だ。', eng:'To solve this problem, thinking beyond conventional frameworks is indispensable.' },
        { jap:'技術革新の恩恵を広く享受するためには、教育制度の抜本的な改革が求められる。', eng:'In order to benefit from technological innovation, a fundamental reform of the education system is required.' },
    ],
};
const DISTRACTORS = [
    'I went to the park.', 'The train was late.', 'She likes reading books.',
    'Let\'s eat lunch together.', 'The weather is nice today.', 'He works at a hospital.',
    'Where is the station?', 'I bought a new bag.', 'It rained heavily last night.',
    'Please call me tomorrow.', 'The meeting starts at 10.', 'She speaks three languages.',
    'I study every evening.', 'The shop closes at 8.',
];

function loadListening() {
    const lvl = currentLevel === 'favorites' ? '5' : currentLevel;
    document.getElementById('listen-level-label').textContent = `N${lvl} Listening`;
    document.getElementById('listen-sentence').textContent = '❓ Press ▶ to hear the sentence';
    listenAnswered = false;
    stopAudio('stop');

    const bank = LISTEN_BANK[lvl] || LISTEN_BANK['5'];
    currentListen = bank[Math.floor(Math.random() * bank.length)];

    const wrongPool = shuffle(DISTRACTORS.filter(d => d !== currentListen.eng));
    const opts = shuffle([currentListen.eng, ...wrongPool.slice(0, 3)]);

    document.getElementById('listen-opts').innerHTML = opts.map(o => {
        const safe = o.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        return `<button class="quiz-opt" data-ans="${safe}">${o}</button>`;
    }).join('');

    document.querySelectorAll('.quiz-opt').forEach(btn => {
        btn.addEventListener('click', () => checkListenAnswer(btn));
    });
}

function checkListenAnswer(btn) {
    if (listenAnswered) return;
    listenAnswered = true;
    document.getElementById('listen-sentence').textContent = currentListen.jap;
    const answer = btn.dataset.ans.replace(/&quot;/g,'"').replace(/&#39;/g,"'");
    document.querySelectorAll('.quiz-opt').forEach(b => {
        b.disabled = true;
        const a = b.dataset.ans.replace(/&quot;/g,'"').replace(/&#39;/g,"'");
        if (a === currentListen.eng) b.classList.add('correct');
    });
    if (answer !== currentListen.eng) btn.classList.add('wrong');
}

document.getElementById('btn-play').addEventListener('click', () => { if (currentListen) speak(currentListen.jap); });
document.getElementById('btn-pause').addEventListener('click', () => stopAudio('pause'));
document.getElementById('btn-stop').addEventListener('click',  () => stopAudio('stop'));
document.getElementById('btn-next-listen').addEventListener('click', loadListening);

// ============================================================
//  VOICE
// ============================================================
async function loadVoice() {
    const statusEl = document.getElementById('voice-status');
    statusEl.textContent = ''; statusEl.style.color = '';
    if (!kanjiList.length) return;
    const char = kanjiList[Math.floor(Math.random() * Math.min(kanjiList.length, 30))];
    document.getElementById('voice-word').textContent = char;
    document.getElementById('voice-meaning').textContent = '...';

    let data = cGet('kd_' + char);
    if (!data) {
        try {
            const r = await fetch(`https://kanjiapi.dev/v1/kanji/${char}`);
            data = await r.json();
            cSet('kd_' + char, data);
        } catch { return; }
    }
    document.getElementById('voice-meaning').textContent = (data.meanings || [])[0] || '';
}

document.getElementById('btn-speak-voice').addEventListener('click', () => speak(document.getElementById('voice-word').textContent));
document.getElementById('btn-next-voice').addEventListener('click', loadVoice);
document.getElementById('btn-start-voice').addEventListener('click', () => {
    const statusEl = document.getElementById('voice-status');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { statusEl.textContent = '⚠️ Not supported in this browser.'; return; }
    const rec = new SpeechRecognition();
    rec.lang = 'ja-JP'; rec.interimResults = false; rec.maxAlternatives = 3;
    rec.onstart  = () => { statusEl.textContent = '🎤 Listening...'; statusEl.style.color = 'var(--primary)'; };
    rec.onresult = (e) => {
        const target = document.getElementById('voice-word').textContent;
        const heard  = Array.from(e.results[0]).map(r => r.transcript);
        const match  = heard.some(t => t.includes(target));
        statusEl.textContent = match ? `✅ Correct! "${heard[0]}"` : `❌ Heard: "${heard[0]}"`;
        statusEl.style.color = match ? 'var(--success)' : 'var(--danger)';
    };
    rec.onerror = (e) => { statusEl.textContent = `Error: ${e.error}`; statusEl.style.color = 'var(--danger)'; };
    rec.start();
});

// ============================================================
//  DICTIONARY SEARCH (debounced + JLPT tags)
// ============================================================
let searchTimer;
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');

searchInput.addEventListener('input', e => {
    const q = e.target.value.trim();
    searchClear.style.display = q ? 'block' : 'none';
    clearTimeout(searchTimer);
    if (!q) { switchTab('kanji'); return; }
    searchTimer = setTimeout(() => runSearch(q), 550);
});
searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    switchTab('kanji');
});

async function runSearch(q) {
    switchTab('search');
    const res = document.getElementById('search-results');
    res.innerHTML = '<div class="loading-stub"><div class="spinner"></div><span>Searching…</span></div>';
    try {
        const data = await proxyFetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(q)}`);
        if (!data?.data?.length) {
            res.innerHTML = `<div class="search-empty">No results for "<strong>${q}</strong>"</div>`;
            return;
        }
        res.innerHTML = data.data.slice(0, 20).map(item => {
            const word    = item.japanese[0]?.word || item.japanese[0]?.reading || '?';
            const reading = item.japanese[0]?.reading || '';
            const meaning = item.senses[0]?.english_definitions?.join(', ') || '';
            const pos     = item.senses[0]?.parts_of_speech?.slice(0, 2).join(', ') || '';
            const jlpt    = item.jlpt?.[0]?.replace('jlpt-', '').toUpperCase() || null;
            return `
                <div class="search-result">
                    <div class="result-top">
                        <div>
                            <div class="result-word">${word}</div>
                            <div class="result-reading">${reading !== word ? reading : ''}</div>
                        </div>
                        ${jlpt ? `<span class="jlpt-badge">${jlpt}</span>` : ''}
                    </div>
                    ${pos ? `<div class="result-pos">${pos}</div>` : ''}
                    <div class="result-meaning">${meaning}</div>
                    <button class="btn btn-icon" style="margin-top:10px;font-size:.8rem;padding:7px 11px;"
                        onclick="speak('${word.replace(/'/g,"\\'")}'" title="Listen">🔊</button>
                </div>`;
        }).join('');
    } catch {
        // Proxy unavailable — show friendly message, not a red error
        res.innerHTML = `
            <div class="search-empty">
                <div style="font-size:2rem;margin-bottom:10px;">🌐</div>
                <strong>Dictionary offline</strong><br>
                <span>The search proxy is currently unreachable.<br>Try again in a moment.</span>
            </div>`;
    }
}

// ============================================================
//  TRANSLATE MODAL (tap-to-translate in reader)
// ============================================================
const modalBackdrop = document.getElementById('modal-backdrop');
const modalSheet    = document.getElementById('modal-sheet');

modalBackdrop.addEventListener('click', closeModal);

function openModal()  { modalBackdrop.classList.add('show'); modalSheet.classList.add('show'); }
function closeModal() { modalBackdrop.classList.remove('show'); modalSheet.classList.remove('show'); }

document.getElementById('modal-close-btn').addEventListener('click', closeModal);
document.getElementById('modal-speak-btn').addEventListener('click', () => speak(document.getElementById('modal-word').textContent));

// ============================================================
//  BOOT
// ============================================================
initKanji();
