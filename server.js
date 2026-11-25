// 엔트리 브라우저 서버
// 작품의 실시간 변수 REQ에 "세션|번호|주소"가 적히면 그 페이지를 가져와 줄인 뒤
// C1~C12 (조각)와 RES ("세션|번호|조각수|제목")에 적어 돌려준다.
//
// 엔트리 실시간 변수 접속 방식은 qwert1566/entry-variable-api (MIT) 를 참고했다.
//
// 환경 변수
//   ENTRY_ID, ENTRY_PW  : 봇 전용 엔트리 계정
//   PROJECT_ID          : 작품 주소 playentry.org/project/<여기> 의 값
//   ALLOW_HOSTS (선택)   : 허용할 사이트만 쉼표로. 예) wikipedia.org,example.com  (비우면 모두 허용)
//   CHUNK_SIZE (선택)    : 변수 한 칸에 넣을 글자 수 (기본 2500)
//   PORT (선택)          : 상태 확인용 HTTP 포트 (호스팅이 정해 줌)

const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
// 최신 Node 에는 실험적인 내장 WebSocket 이 있는데, socket.io 가 그걸 먼저 집어 쓰면 연결이 자주 끊긴다.
// 내장 것을 가려서 검증된 ws 패키지를 쓰게 한다. (반드시 socket.io-client 를 불러오기 전에)
try { globalThis.WebSocket = undefined; } catch (e) {}
const io = require("socket.io-client");
const cheerio = require("cheerio");
const { simplify, errorPage } = require("./simplify");
const { styledSimplify, mediaOk } = require("./styled");
const USE_CSS = process.env.CSS !== "0";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;      // (선택) Cloudflare Browser Run 으로 자바스크립트까지 실행한 HTML 받기
const CF_API_TOKEN = process.env.CF_API_TOKEN;
let cfLastCall = 0, cfPausedUntil = 0;

const ENTRY_ID = process.env.ENTRY_ID;
const ENTRY_PW = process.env.ENTRY_PW;
const PROJECT_ID = process.env.PROJECT_ID;
const ALLOW_HOSTS = (process.env.ALLOW_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 2500);
const NCHUNK = Math.max(1, Math.min(12, Number(process.env.MAX_CHUNKS || 12)));   // 응답 하나에 쓸 조각 수 (작게 하면 엔트리에 주는 부담이 준다)
const TOTAL_BUDGET = Number(process.env.TOTAL_BUDGET || 45000);                    // 한 페이지 전체(여러 부분으로 나눠 보냄)에 쓸 글자 수
const WRITE_GAP = Number(process.env.WRITE_GAP || 150);                           // 조각을 쓰는 간격(ms)
let usedChunks = 12;                                                               // 내용이 남아 있을 수 있는 조각 수
const UA = "Mozilla/5.0 (compatible; EntryBrowserBot/1.0)";

const KNOWN_IDS = { REQ: "vaac", RES: "vaad", C1: "vaae", C2: "vaaf", C3: "vaag", C4: "vaah", C5: "vaai", C6: "vaaj", C7: "vaak", C8: "vaal", C9: "vaam", C10: "vaan", C11: "vaao", C12: "vaap" };
const ID_TO_NAME = Object.fromEntries(Object.entries(KNOWN_IDS).map(([n, i]) => [i, n]));

const state = { connected: false, lastError: "", served: 0, startedAt: new Date().toISOString(), lastRequestAt: null };
let socket = null;
let vars = {};          // 이름 -> { _id, id }
const queue = [];
let active = 0;                // 지금 처리 중인 요청 수
let lastReqValue = null;      // 마지막으로 본 REQ 값 (끊긴 사이에 온 요청을 찾는 데 쓴다)
const lastSeen = new Map();   // 세션별 최근 요청 시각

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ------------------------------------------------------------------ 엔트리 로그인
function pickCookie(res, name) {
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
    for (const line of raw) {
        for (const part of line.split(/;|,/)) {
            const p = part.trim();
            if (p.startsWith(name + "=") && p.length > name.length + 2) return p.slice(name.length + 1);
        }
    }
    return undefined;
}
function nextData(html) {
    return JSON.parse(cheerio.load(html)("#__NEXT_DATA__").text());
}
async function login() {
    const first = await fetch("https://playentry.org/");
    const csrfToken = nextData(await first.text()).props.initialProps.csrfToken;
    const csrfCookie = pickCookie(first, "_csrf");
    const signin = await fetch("https://playentry.org/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", "csrf-token": csrfToken, cookie: `_csrf=${csrfCookie};` },
        body: JSON.stringify({
            query: `mutation SIGNIN_BY_USERNAME ( $username: String!, $password: String!, $rememberme: Boolean )
                { signinByUsername ( username: $username, password: $password, rememberme: $rememberme ) { id } }`,
            variables: { username: ENTRY_ID, password: ENTRY_PW, rememberme: false },
        }),
    });
    const SID = pickCookie(signin, "ETR_SID");
    if (!SID) throw new Error("엔트리 로그인 실패 (아이디/비밀번호 확인)");
    const cookie = `_csrf=${csrfCookie}; ETR_SID=${SID};`;
    const home = await fetch("https://playentry.org/", { headers: { "csrf-token": csrfToken, cookie } });
    const xToken = nextData(await home.text()).props.pageProps.initialState.common.user.xToken;
    return { csrfToken, cookie, xToken };
}
async function cloudQuery(acc) {
    const res = await fetch("https://playentry.org/graphql/GET_CLOUD_SERVER_INFO", {
        method: "POST",
        headers: { "Content-Type": "application/json", "csrf-token": acc.csrfToken, "x-token": acc.xToken, cookie: acc.cookie },
        body: JSON.stringify({
            query: `query GET_CLOUD_SERVER_INFO ( $id: ID! ) { cloudServerInfo ( id: $id ) { query } }`,
            variables: { id: PROJECT_ID },
        }),
    });
    const q = (await res.json()).data?.cloudServerInfo?.query;
    if (!q) throw new Error("작품의 실시간 변수 서버 정보를 못 받았어요 (PROJECT_ID 확인, 작품 저장 여부 확인)");
    return q;
}

// ------------------------------------------------------------------ 실시간 변수 연결
let reconnectTimer = null, failStreak = 0;
function scheduleReconnect(ms) {
    if (reconnectTimer) return;
    // 계속 실패하면 간격을 늘린다 (엔트리 서버를 두드리지 않게): 최대 2분
    const delay = Math.min(120000, ms * Math.pow(1.7, Math.min(failStreak, 6)));
    failStreak++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}
let evSeen = 0;
let accCache = null, accAt = 0, connectedAt = 0, connecting = false;
async function connect() {
    if (connecting) return;
    connecting = true;
    try {
        if (socket) { socket.removeAllListeners(); socket.close(); socket = null; }
        state.connected = false;
        let q = null;
        if (accCache && Date.now() - accAt < 6 * 3600000) {          // 로그인은 자주 하지 않는다
            try { q = await cloudQuery(accCache); } catch (e) { accCache = null; }
        }
        if (!q) {
            accCache = await login(); accAt = Date.now();
            q = await cloudQuery(accCache);
        }
        connectedAt = Date.now();
        socket = io("https://playentry.org", {
            path: "/cv/", transports: ["websocket"], query: { transport: "websocket", q }, reconnection: false,
            extraHeaders: { Origin: "https://playentry.org", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" },
        });
        socket.on("welcome", (msg) => {
            vars = {};
            const list = msg.variables || [];
            log("welcome 내용:", "isOffline=" + msg.isOffline, "항목=" + Object.keys(msg).join(","));
            // 끊겨 있던 사이에 작품이 보낸 요청은 알림으로 오지 않는다. 다시 붙을 때 받은 REQ 값이
            // 전에 본 것과 다르면 그 요청을 지금 처리한다. (서버를 처음 켰을 때의 오래된 값은 건너뛴다)
            setTimeout(() => {
                const r = list.find((v) => v && v.id === KNOWN_IDS.REQ);
                if (!r) return;
                const val = String(r.value);
                if (lastReqValue !== null && val !== lastReqValue) {
                    log("끊긴 사이에 온 요청을 발견");
                    onAction({ id: r.id, variableType: "variable", type: "set", value: val });
                } else lastReqValue = val;
            }, 0);
            for (const v of list) {
                if (v.variableType && v.variableType !== "variable") continue;
                const name = v.name || ID_TO_NAME[v.id];      // 이름이 안 오면 작품에 넣어 둔 변수 ID로 찾는다
                if (name) vars[name] = { _id: v._id, id: v.id };
            }
            const need = Object.keys(KNOWN_IDS);
            const missing = need.filter((n) => !vars[n]);
            state.connected = missing.length === 0;
            state.lastError = missing.length ? "실시간 변수가 없음: " + missing.join(", ") : "";
            if (missing.length) {
                log("변수 누락: " + missing.join(", "));
                log("서버가 알려 준 실시간 변수 " + list.length + "개:",
                    JSON.stringify(list.slice(0, 20).map((v) => ({ id: v.id, name: v.name, type: v.variableType, keys: Object.keys(v) }))));
            } else {
                failStreak = 0;
                log("연결됨. 요청을 기다리는 중", "(변수 " + list.length + "개, 이름 " + (list.some((v) => v.name) ? "있음" : "없음") + ", REQ id " + vars.REQ.id + ")");
            }
        });
        // 진단용: 엔트리가 보내는 모든 이벤트를 이름과 함께 기록한다 (조각 변수 값은 길어서 줄인다)
        const origOnevent = socket.onevent;
        socket.onevent = function (packet) {
            try {
                const a = packet.data || [];
                if (a[0] !== "action" || evSeen < 60) {
                    evSeen++;
                    log("받음 <-", a[0], JSON.stringify(a.slice(1)).slice(0, 140), packet.id !== undefined ? "(응답 요구 id " + packet.id + ")" : "");
                }
            } catch (e) {}
            return origOnevent.call(this, packet);
        };
        socket.on("check", (id) => { socket.emit("imAlive", id); log("보냄 -> imAlive", JSON.stringify(id)); });
        for (const ev of ["changeMode", "reset", "create", "delete", "error", "exception"]) socket.on(ev, (m) => log("소켓 이벤트", ev, JSON.stringify(m || "").slice(0, 150)));
        socket.on("action", onAction);
        socket.on("connect_error", (e) => {
            const d = e && e.description;
            const detail = d ? (d.message || (typeof d === "object" ? JSON.stringify(d) : String(d))) : "";
            state.lastError = "연결 오류: " + e + (detail ? " / 자세히: " + detail : "");
            log(state.lastError);
            scheduleReconnect(15000);
        });
        socket.on("disconnect", (r) => {
            state.connected = false;
            log("연결 끊김:", r, "(붙어 있던 시간 " + Math.round((Date.now() - connectedAt) / 1000) + "초)");
            scheduleReconnect(5000);
        });
        if (socket.io && socket.io.engine) {
            socket.io.engine.on("close", (reason, desc) => log("엔진 닫힘:", reason, desc ? (desc.message || desc.code || "") : ""));
        }
    } catch (e) {
        state.lastError = String(e.message || e);
        log("접속 실패:", state.lastError);
        accCache = null;
        scheduleReconnect(60000);
    } finally {
        connecting = false;
    }
}
// 연결이 조용히 죽는 경우에 대비해 주기적으로 살펴본다
function watchdog() {
    if (active || queue.length || connecting || reconnectTimer) return;
    const dead = !socket || !socket.connected;
    const old = Date.now() - connectedAt > 12 * 60000;
    if (dead || old) { log(dead ? "연결이 죽어 있어 다시 연결" : "연결을 새로 고침"); connect(); }
}
function setVar(name, value) {
    const v = vars[name];
    if (!v || !socket) return;
    socket.emit("action", { _id: v._id, id: v.id, variableType: "variable", type: "set", value });
}
let actionSeen = 0;
function onAction(msg) {
    // 진단용: 어떤 변수 변경이든 도착하면 처음 40번은 기록한다
    if (actionSeen < 40) {
        actionSeen++;
        log("변수 변경 수신", JSON.stringify({ id: msg && msg.id, type: msg && msg.type, vt: msg && msg.variableType, value: String(msg && msg.value).slice(0, 70) }),
            "REQ 의 id =", vars.REQ && vars.REQ.id);
    }
    if (!msg || msg.variableType !== "variable" || !vars.REQ || msg.id !== vars.REQ.id) return;
    lastReqValue = String(msg.value);
    const m = /^(\d{1,9})\|(\d{1,9})\|([\s\S]{1,2000})$/.exec(String(msg.value));
    if (!m) return;
    let rest = m[3], nick = "";
    const um = /^U:([^|]{0,40})\|([\s\S]+)$/.exec(rest);
    if (um) { nick = um[1].trim(); rest = um[2]; }
    let reqUrl = rest.trim(), part = 1;
    const pm = /^@p(\d{1,3})@([\s\S]+)$/.exec(reqUrl);
    if (pm) { part = Math.max(1, Number(pm[1])); reqUrl = pm[2].trim(); }
    log("요청 받음", reqUrl.slice(0, 80), part > 1 ? "(부분 " + part + ")" : "", nick ? "· " + nick : "· (닉네임 없음)");
    const job = { sid: m[1], seq: m[2], url: reqUrl, part, nick };
    // 같은 사람이 기다리는 요청이 있으면 새 요청으로 바꾼다 (연타·다시 받기)
    const same = queue.findIndex((j) => j.sid === job.sid);
    if (same >= 0) queue[same] = job;
    else { if (queue.length >= 30) return; queue.push(job); }
    pump();
}
const PARALLEL = Math.max(1, Number(process.env.PARALLEL || 3));   // 동시에 가져올 페이지 수
const RES_GAP = Number(process.env.RES_GAP || 1200);                 // 응답과 응답 사이 간격(ms): 받는 쪽이 조각을 다 읽을 시간
let pausedForTest = false;
function pump() {
    if (pausedForTest) return;
    while (active < PARALLEL && queue.length) {
        const job = queue.shift();
        active++;
        handleJob(job).catch((e) => log("처리 실패:", e && e.message)).finally(() => { active--; pump(); });
    }
}
async function handleJob(job) {
    state.lastRequestAt = new Date().toISOString();
    let page;
    const q = await checkQuota(job);
    if (!q.ok) page = q.page;
    else {
        try { page = await loadPage(job.url); }
        catch (e) { page = { title: "오류", html: errorPage(job.url, String(e.message || e)) }; }
        page = partOf(page, job.part || 1);
    }
    await sendInTurn(job, page, q.left);
    state.served++;
}
// 응답 칸(C1~C12)은 모두가 같이 쓰므로, 응답은 한 번에 하나씩 보내고 사이에 간격을 둔다
let sendChain = Promise.resolve();
function sendInTurn(job, page, left) {
    const p = sendChain.then(async () => { await respond(job, page, left); await sleep(RES_GAP); });
    sendChain = p.catch(() => {});
    return p;
}

// ------------------------------------------------------------------ 사용량 제한
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 10);       // 한 사람이 하루에 열 수 있는 페이지 수
const LIKE_BONUS = Number(process.env.LIKE_BONUS || 5);          // 작품에 좋아요를 누르면 더해 주는 수
const UNLIMITED = new Set((process.env.UNLIMITED || "").split(",").map((x) => x.trim()).filter(Boolean));
const usage = new Map();      // 닉네임 -> { day, urls: Set }  (서버를 다시 켜면 처음부터 센다)
function kstDay() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
let likeSet = new Set(), likeAt = 0, likeLoading = null;
let anonAuth = null, anonAt = 0;
async function gqlHeaders() {
    if (accCache) return { "csrf-token": accCache.csrfToken, "x-token": accCache.xToken, cookie: accCache.cookie };
    if (!anonAuth || Date.now() - anonAt > 3600000) {
        const first = await fetch("https://playentry.org/");
        anonAuth = { "csrf-token": nextData(await first.text()).props.initialProps.csrfToken, cookie: "_csrf=" + pickCookie(first, "_csrf") + ";" };
        anonAt = Date.now();
    }
    return anonAuth;
}
async function loadLikers() {
    const set = new Set();
    const auth = await gqlHeaders();
    for (let start = 0, pages = 0; start < 2000 && pages < 40; pages++) {
        const res = await fetch("https://playentry.org/graphql/LIKE_LIST", {
            method: "POST", signal: AbortSignal.timeout(8000),
            headers: Object.assign({ "Content-Type": "application/json" }, auth),
            body: JSON.stringify({
                query: "query LIKE_LIST($target: String, $pageParam: PageParam){ likeList(target: $target, pageParam: $pageParam) { total list { user { nickname } } } }",
                variables: { target: PROJECT_ID, pageParam: { display: 100, start } },
            }),
        });
        const j = await res.json();
        const ls = (j.data && j.data.likeList && j.data.likeList.list) || [];
        ls.forEach((x) => x && x.user && x.user.nickname && set.add(x.user.nickname));
        const total = (j.data && j.data.likeList && j.data.likeList.total) || 0;
        if (!ls.length || set.size >= total) break;
        start += ls.length;
    }
    return set;
}
async function likers(maxAgeMs) {
    if (Date.now() - likeAt < maxAgeMs) return likeSet;
    if (!likeLoading) likeLoading = loadLikers().then((s) => { likeSet = s; likeAt = Date.now(); log("좋아요 목록", s.size + "명"); })
        .catch((e) => log("좋아요 목록을 못 가져옴:", e && e.message)).finally(() => { likeLoading = null; });
    await likeLoading;
    return likeSet;
}
function simplePage(title, body) {
    return { title, html: `<html><head><title>${title}</title><style>body{margin:0;background:#f8f9fa}.card{width:460px;margin:64px auto 0;background:#ffffff;border:1px solid #e3e5e8;padding:26px 34px}h2{margin:0 0 12px;font-size:22px;color:#202124}p{margin:8px 0;font-size:14px;color:#5f6368}b{color:#202124}a{color:#1a73e8}</style></head><body><div class="card"><h2>${title}</h2>${body}<p><a href="about:home">홈으로 돌아가기</a></p></div></body></html>` };
}
async function checkQuota(job) {
    if (!job.nick) return { ok: false, left: "", page: simplePage("로그인이 필요해요", "<p>엔트리에 로그인한 사람만 바깥 사이트를 열 수 있어요.</p><p>로그인한 뒤 작품 페이지를 새로고침해 주세요.</p>") };
    if (UNLIMITED.has(job.nick)) return { ok: true, left: "" };
    const day = kstDay();
    let u = usage.get(job.nick);
    if (!u || u.day !== day) { u = { day, urls: new Set() }; usage.set(job.nick, u); }
    if (usage.size > 20000) usage.clear();
    let liked = (await likers(5 * 60000)).has(job.nick);
    let limit = DAILY_LIMIT + (liked ? LIKE_BONUS : 0);
    // 이미 오늘 연 페이지(다시 불러오기, 뒤로 가기, 이어 받기)는 다시 세지 않는다
    if (u.urls.has(job.url)) return { ok: true, left: Math.max(0, limit - u.urls.size) };
    if (u.urls.size >= limit && !liked) {
        liked = (await likers(10000)).has(job.nick);           // 방금 좋아요를 눌렀을 수 있다
        limit = DAILY_LIMIT + (liked ? LIKE_BONUS : 0);
    }
    if (u.urls.size >= limit) {
        log("사용량 초과", job.nick, u.urls.size + "/" + limit);
        const more = liked ? "" : `<p>작품에 <b>좋아요</b>를 누르면 오늘 <b>${LIKE_BONUS}번</b> 더 열 수 있어요. 좋아요를 누른 뒤 다시 시도해 주세요.</p>`;
        return { ok: false, left: 0, page: simplePage("오늘 열 수 있는 페이지를 다 썼어요", `<p>한 사람이 하루에 <b>${limit}개</b>의 페이지를 열 수 있어요. 이미 연 페이지는 다시 열어도 세지 않아요.</p>${more}<p>한국 시간 밤 12시에 다시 채워져요.</p>`) };
    }
    u.urls.add(job.url);
    return { ok: true, left: limit - u.urls.size };
}
// 긴 그리기 목록을 세로 위치 기준으로 여러 부분으로 나눈다. 작품은 스크롤이 끝에 닿으면 다음 부분을 요청한다.
// 엔트리 변수에 한 번에 큰 값을 쓰지 않으려는 것이다.
function splitDL(dl, cap) {
    const lines = dl.split("\n");
    const head = (lines[1] || "P|0|ffffff|0").split("|");
    const docH = Number(head[1]) || 0, bg = head[2] || "ffffff", cut = head[3] === "1" ? 1 : 0;
    const links = [], items = [];
    for (let i = 2; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.startsWith("L|")) links.push(ln.slice(2));
        else if (ln.startsWith("R|") || ln.startsWith("T|") || ln.startsWith("I|")) {
            const f = ln.split("|");
            items.push({ ln, y: Number(f[2]) || 0, li: ln[0] === "T" ? Number(f[7]) || 0 : 0, ord: items.length });
        }
    }
    const byY = items.slice().sort((a, b) => a.y - b.y || a.ord - b.ord);
    const parts = []; let cur = [], size = 60, used = new Set();
    const flush = (yEnd) => { parts.push({ items: cur, yEnd }); cur = []; size = 60; used = new Set(); };
    for (const it of byY) {
        let cost = it.ln.length + 1;
        if (it.li && !used.has(it.li)) cost += (links[it.li - 1] || "").length + 3;
        if (cur.length && size + cost > cap) flush(it.y);
        if (it.li) used.add(it.li);
        cur.push(it); size += cost;
    }
    if (cur.length || !parts.length) flush(docH);
    return parts.map((p, k) => {
        const last = k === parts.length - 1;
        const remap = new Map(), outL = [];
        const body = p.items.sort((a, b) => a.ord - b.ord).map((it) => {
            if (!it.li) return it.ln;
            if (!remap.has(it.li)) { outL.push("L|" + (links[it.li - 1] || "")); remap.set(it.li, outL.length); }
            const f = it.ln.split("|"); f[7] = remap.get(it.li);
            return f.join("|");
        });
        // 마지막이 아니면 문서 높이를 "여기까지"로 알려서 그 아래로는 다음 부분을 받은 뒤에 내려가게 한다
        const h = last ? docH : Math.max(1, Math.round(p.yEnd));
        return ["@DL1", `P|${h}|${bg}|${last ? cut : 0}|${last ? 0 : 1}`].concat(outL, body).join("\n");
    });
}
function partOf(page, part) {
    if (!page || typeof page.html !== "string" || !page.html.startsWith("@DL1")) {
        if (part > 1) return { title: page && page.title, html: "@DL1\nP|0|ffffff|0|0" };   // 그리기 목록이 아니면 이어 줄 것이 없다
        return page;
    }
    if (!page.parts) page.parts = splitDL(page.html, CHUNK_SIZE * NCHUNK - 150);
    const html = page.parts[part - 1] || "@DL1\nP|0|ffffff|0|0";
    if (page.parts.length > 1) log("부분", part + "/" + page.parts.length, "글자", html.length);
    return { title: page.title, html };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function respond(job, page, left) {
    let html = page.html;
    const cap = CHUNK_SIZE * NCHUNK;
    if (html.length > cap) html = html.startsWith("@DL1") ? html.slice(0, html.lastIndexOf("\n", cap)) : html.slice(0, cap - 60) + "<p><i>… (잘림)</i></p>";
    const n = Math.max(1, Math.ceil(html.length / CHUNK_SIZE));
    // 한꺼번에 쏟아붓지 않고 간격을 두고 쓴다
    // 조각마다 요청 번호를 붙여서, 받는 쪽이 남의 응답을 섞어 읽지 않게 한다
    const tag = `${job.sid}|${job.seq}|`;
    for (let i = 0; i < n; i++) { setVar("C" + (i + 1), tag + html.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)); await sleep(WRITE_GAP); }
    const title = String(page.title || "").replace(/[|\n]/g, " ").slice(0, 60);
    setVar("RES", `${job.sid}|${job.seq}|${n}|${title}|${left === undefined ? "" : left}`);
    log("응답", job.url.slice(0, 80), "조각", n, "글자", html.length);
    // 이번에 안 쓴 조각에 예전 큰 내용이 남아 있으면 비운다 (엔트리에 큰 값이 쌓여 있지 않게)
    for (let i = n; i < usedChunks; i++) { await sleep(WRITE_GAP); setVar("C" + (i + 1), "-"); }
    usedChunks = n;
}

// ------------------------------------------------------------------ 페이지 가져오기
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split(".").map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}
async function checkUrl(u) {
    let url;
    try { url = new URL(u); } catch (e) { throw new Error("주소 형식이 올바르지 않아요."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("http, https 주소만 열 수 있어요.");
    const host = url.hostname.toLowerCase();
    if (ALLOW_HOSTS.length && !ALLOW_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
        throw new Error("이 브라우저에서 허용되지 않은 사이트예요.");
    }
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error("사이트를 찾을 수 없어요.");
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("열 수 없는 주소예요.");
    return url;
}
const pageCache = new Map();      // 주소 -> { page, at }
const CACHE_MS = 10 * 60000;
const noScriptHosts = new Set();  // 스크립트 주입이 막힌 사이트 (CSP 등)
const EXTRACT_SRC = fs.readFileSync(path.join(__dirname, "extract.js"), "utf8");

const inflight = new Map();       // 지금 가져오는 중인 주소 -> Promise (같은 주소를 동시에 두 번 가져오지 않게)
async function loadPage(u) {
    const hit = pageCache.get(u);
    if (hit && Date.now() - hit.at < CACHE_MS) { log("캐시 사용", u.slice(0, 80)); return hit.page; }
    if (inflight.has(u)) return inflight.get(u);
    const p = loadPageFresh(u);
    inflight.set(u, p);
    let page;
    try { page = await p; } finally { inflight.delete(u); }
    pageCache.set(u, { page, at: Date.now() });
    if (pageCache.size > 150) pageCache.delete(pageCache.keys().next().value);
    return page;
}
async function fetchDirect(url) {
    let res;
    for (let hop = 0; hop < 5; hop++) {
        res = await fetch(url, {
            redirect: "manual", signal: AbortSignal.timeout(8000),
            headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "ko,en;q=0.8" },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            url = await checkUrl(new URL(res.headers.get("location"), url).href);   // 이동할 주소도 다시 검사
            continue;
        }
        break;
    }
    if (!res.ok) throw new Error("사이트가 오류를 돌려줬어요. (HTTP " + res.status + ")");
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type && !/html|text\/plain|xml/.test(type)) throw new Error("웹 페이지가 아니에요. (" + type.split(";")[0] + ")");
    const buf = await readLimited(res, 3 * 1024 * 1024);
    let charset = (/charset=([\w-]+)/.exec(type) || [])[1];
    if (!charset) {
        const headText = buf.subarray(0, 2048).toString("latin1");
        charset = (/charset=["']?([\w-]+)/i.exec(headText) || [])[1];
    }
    let text;
    try { text = new TextDecoder(charset || "utf-8").decode(buf); } catch (e) { text = new TextDecoder("utf-8").decode(buf); }
    return { url, type, text };
}
async function loadPageFresh(u) {
    let url = await checkUrl(u);
    const cap = CHUNK_SIZE * NCHUNK - 400;
    // 작품은 30초까지만 기다린다. 전체를 DEADLINE 안에 끝내고, 늦어지는 단계는 건너뛰어 더 단순한 결과라도 보낸다.
    const t0 = Date.now(), DEADLINE = Number(process.env.DEADLINE_MS || 20000);
    const left = () => DEADLINE - (Date.now() - t0);
    const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(undefined), Math.max(0, ms)))]);
    let direct = null, directErr = null;
    // 직접 가져오기와 렌더링 서비스를 동시에 시작한다 (작품이 기다리는 시간 안에 끝내려고)
    const renderedP = renderedPage(url.href, TOTAL_BUDGET).catch(() => null);
    try { direct = await fetchDirect(url); } catch (e) { directErr = e; }
    if (direct && /text\/plain/.test(direct.type)) {
        return { title: url.hostname, html: "<pre>" + direct.text.slice(0, 20000).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>" };
    }
    if (directErr && /웹 페이지가 아니에요/.test(directErr.message)) throw directErr;
    if (direct) url = direct.url;
    // 1순위: 진짜 브라우저가 그린 결과(그리기 목록)
    let r = await within(renderedP, left() - 4000);
    if (r === undefined) { log("렌더링이 늦어져 건너뜀", url.href.slice(0, 80)); r = null; }
    if (r && r.dl) return { title: r.title, html: r.dl, mode: "paint" };
    // 2순위: 엔트리가 직접 해석할 HTML (렌더링된 HTML 이 있으면 그걸로)
    const text = r && r.html ? r.html : direct ? direct.text : null;
    if (!text) throw directErr || new Error("페이지를 가져오지 못했어요.");
    if (USE_CSS && left() > 5000) {
        try {
            const sheets = await within(collectSheets(text, url.href), left() - 2500);
            if (sheets === undefined) throw new Error("스타일을 가져오는 데 시간이 너무 걸림");
            const page = styledSimplify(text, url.href, sheets, { maxChars: cap });
            log("CSS", "시트", sheets.length, "규칙", page.rules, "클래스", page.classes, "노드", page.nodes, "영역", page.root, page.timedOut ? "(시간 초과로 일부만)" : "");
            return page;
        } catch (e) {
            log("CSS 처리 실패, 글만 보냄:", e && e.message);
        }
    }
    return simplify(text, url.href, { maxChars: cap });
}
// Cloudflare Browser Run: 진짜 브라우저로 페이지를 열고, 그 안에서 extract.js 를 실행해
// "어디에 어떤 상자와 글자가 있는지"(그리기 목록)를 받아 온다.
// 돌려주는 값: { dl, title } (성공) / { html } (스크립트는 막혔지만 렌더링된 HTML 은 받음) / null (못 씀)
async function renderedPage(pageUrl, cap) {
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return null;
    let host = "";
    try { host = new URL(pageUrl).hostname; } catch (e) {}
    const withScript = !noScriptHosts.has(host);
    const body = {
        url: pageUrl,
        viewport: { width: 720, height: 900 },
        gotoOptions: { waitUntil: "networkidle2", timeout: 12000 },
        rejectResourceTypes: ["media"],
    };
    if (withScript) {
        body.addScriptTag = [{ content: EXTRACT_SRC.replace("__BUDGET__", String(cap - 200)).replace("__VW__", "720") }];
        body.waitForSelector = { selector: "#__eb", timeout: 5000 };
    }
    const html = await cfContent(body);
    if (html === null) return null;
    if (html === false) {                               // 요청은 갔는데 실패: 스크립트 주입이 막힌 사이트일 수 있다
        if (withScript) { noScriptHosts.add(host); if (noScriptHosts.size > 500) noScriptHosts.clear(); }
        return null;
    }
    if (withScript) {
        try {
            const raw = cheerio.load(html)("#__eb").text();
            if (raw) {
                const j = JSON.parse(raw);
                if (j.ok && j.dl && j.dl.length <= cap) {
                    log("그리기 목록", pageUrl.slice(0, 80), "항목", j.items, "글자", j.dl.length, j.cut ? "(위쪽만)" : "");
                    return { dl: j.dl, title: j.title };
                }
                log("그리기 목록 실패:", j.error || "너무 김");
            } else {
                noScriptHosts.add(host);
            }
        } catch (e) { log("그리기 목록 해석 실패:", e && e.message); }
    }
    return { html };
}
// 돌려주는 값: HTML 문자열 / false (요청이 실패) / null (지금은 쓸 수 없음: 키 없음, 한도, 너무 잦음)
async function cfContent(body) {
    const now = Date.now();
    if (now < cfPausedUntil) return null;
    // 여러 요청이 동시에 와도 10.5초 간격을 지키도록, 기다리기 전에 차례를 먼저 잡는다
    const slot = Math.max(now, cfLastCall + 10500);
    if (slot - now > 4000) return null;                 // 너무 오래 기다려야 하면 이번엔 건너뛴다
    cfLastCall = slot;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/content`, {
            method: "POST", signal: AbortSignal.timeout(19000),
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${CF_API_TOKEN}` },
            body: JSON.stringify(body),
        });
        const raw = await res.text();
        if (res.status === 429) {
            if (/limit exceeded for today|time limit/i.test(raw)) { cfPausedUntil = Date.now() + 30 * 60000; log("렌더링 서비스 오늘 한도 소진. 30분 동안 건너뜀"); }
            else log("렌더링 서비스 요청이 너무 잦음. 이번엔 건너뜀");
            return null;
        }
        if (res.status === 401 || res.status === 403 || res.status === 404) {
            cfPausedUntil = Date.now() + 10 * 60000;
            log("렌더링 서비스 인증/주소 오류", res.status, raw.slice(0, 200));
            return null;
        }
        if (!res.ok) { log("렌더링 서비스 오류", res.status, raw.slice(0, 300)); return false; }
        let html = raw;
        if (raw.trimStart().startsWith("{")) {
            const j = JSON.parse(raw);
            if (j.success === false) { log("렌더링 서비스 실패", JSON.stringify(j.errors || "").slice(0, 200)); return false; }
            html = typeof j.result === "string" ? j.result : (j.result && (j.result.content || j.result.html)) || "";
        }
        if (!html || html.length < 50) return false;
        return html.length > 4 * 1024 * 1024 ? html.slice(0, 4 * 1024 * 1024) : html;
    } catch (e) {
        log("렌더링 서비스 응답 없음:", e && e.message);
        return false;
    }
}
// 페이지의 <style> 과 외부 스타일시트를 문서 순서대로 모은다
async function collectSheets(html, baseUrl) {
    const $ = cheerio.load(html);
    let base = baseUrl;
    const bh = $("base[href]").attr("href");
    if (bh) { try { base = new URL(bh, baseUrl).href; } catch (e) {} }
    const items = [];
    let links = 0;
    $("style, link[href]").each((_, el) => {
        if (el.name === "style") {
            if (mediaOk(el.attribs.media || "")) items.push(Promise.resolve($(el).text()));
            return;
        }
        const rel = (el.attribs.rel || "").toLowerCase();
        if (!/\bstylesheet\b/.test(rel) || /\balternate\b/.test(rel)) return;
        if (!mediaOk(el.attribs.media || "") || links >= 8) return;
        links++;
        items.push(fetchCss(el.attribs.href, base));
    });
    const texts = await Promise.all(items);
    let total = 0;
    return texts.filter((t) => { if (!t) return false; total += t.length; return total <= 2500000; });
}
async function fetchCss(href, base) {
    try {
        let url = await checkUrl(new URL(href, base).href);
        let res;
        for (let hop = 0; hop < 4; hop++) {
            res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "user-agent": UA, accept: "text/css,*/*;q=0.1" } });
            if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
                url = await checkUrl(new URL(res.headers.get("location"), url).href);
                continue;
            }
            break;
        }
        if (!res.ok) return "";
        return (await readLimited(res, 900 * 1024)).toString("utf8");
    } catch (e) {
        return "";
    }
}
async function readLimited(res, limit) {
    const chunks = []; let size = 0;
    for await (const c of res.body) {
        size += c.length;
        if (size > limit) break;
        chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ 시작
if (require.main === module) {
    http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(Object.assign({}, state, {
            socketAlive: !!(socket && socket.connected), queue: queue.length, active, usersToday: [...usage.values()].filter((u) => u.day === kstDay()).length, likes: likeSet.size,
            connectedSecondsAgo: connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : null,
            now: new Date().toISOString(),
        })));
    }).listen(process.env.PORT || 3000);
    setInterval(watchdog, 60000);

    if (!ENTRY_ID || !ENTRY_PW || !PROJECT_ID) {
        state.lastError = "환경 변수 ENTRY_ID, ENTRY_PW, PROJECT_ID 를 설정해 주세요.";
        log(state.lastError);
    } else {
        connect();
    }
    process.on("unhandledRejection", (e) => log("처리 안 된 오류:", e && e.message));
}
module.exports = { loadPage, checkUrl, splitDL, partOf, checkQuota, likers, usage, respond, onAction, queue, setTest: (o) => { if (o.socket) socket = o.socket; if (o.vars) vars = o.vars; if (o.pause !== undefined) pausedForTest = o.pause; } };
