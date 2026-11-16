// 페이지의 CSS를 서버에서 미리 계산해, 실제로 쓰인 스타일만 작은 <style> + class 로 붙여 보낸다.
// 엔트리 쪽 렌더러가 이해하는 속성만 남긴다.
const cheerio = require("cheerio");
const csstree = require("css-tree");

const VW = 720;          // 엔트리 화면의 가로 (CSS px)

const OUT_PROPS = new Set(["display", "color", "background", "background-color", "font-size", "font-weight",
    "font-style", "text-decoration", "text-decoration-line", "text-align", "line-height", "width", "height",
    "min-width", "max-width", "min-height", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "border", "border-top",
    "border-right", "border-bottom", "border-left", "border-width", "border-color", "border-style",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "flex", "flex-direction",
    "flex-wrap", "flex-flow", "flex-grow", "flex-shrink", "flex-basis", "justify-content", "align-items",
    "align-self", "gap", "row-gap", "column-gap", "box-sizing", "white-space", "list-style", "list-style-type"]);
const LOGICAL = {
    "margin-inline": ["margin-left", "margin-right"], "margin-block": ["margin-top", "margin-bottom"],
    "padding-inline": ["padding-left", "padding-right"], "padding-block": ["padding-top", "padding-bottom"],
    "margin-inline-start": ["margin-left"], "margin-inline-end": ["margin-right"],
    "margin-block-start": ["margin-top"], "margin-block-end": ["margin-bottom"],
    "padding-inline-start": ["padding-left"], "padding-inline-end": ["padding-right"],
    "padding-block-start": ["padding-top"], "padding-block-end": ["padding-bottom"],
    "border-inline-start": ["border-left"], "border-inline-end": ["border-right"],
    "border-block-start": ["border-top"], "border-block-end": ["border-bottom"],
    "inline-size": ["width"], "block-size": ["height"], "max-inline-size": ["max-width"], "min-inline-size": ["min-width"],
    "min-block-size": ["min-height"],
};
const EXTRA = new Set(["position", "visibility", "opacity", "float", "grid-template-columns", "font", "background-image"]);
const WANT = new Set([...OUT_PROPS, ...Object.keys(LOGICAL), ...EXTRA]);
const INHERITED = ["color", "font-size", "font-weight", "font-style", "line-height", "text-align", "white-space", "list-style-type"];
const DYNAMIC = new Set(["hover", "focus", "active", "visited", "focus-visible", "focus-within", "target", "checked",
    "disabled", "invalid", "placeholder-shown", "indeterminate", "open", "popover-open", "fullscreen", "user-invalid",
    "autofill", "read-only", "required", "optional", "valid", "in-range", "out-of-range", "default", "current"]);

const DROP = new Set(["script", "style", "noscript", "iframe", "svg", "canvas", "video", "audio", "picture", "img",
    "form", "input", "select", "textarea", "button", "link", "meta", "template", "object", "embed", "head", "title",
    "map", "dialog", "source", "track"]);
const KEEP = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "a", "ul", "ol", "li", "b", "strong", "i",
    "em", "u", "s", "del", "br", "hr", "blockquote", "pre", "code", "table", "tr", "td", "th", "dl", "dt", "dd", "small",
    "sub", "sup", "mark"]);
const BLOCK_TAGS = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "pre", "table", "dl", "dt", "dd", "hr"]);
const INLINE_TAGS = new Set(["span", "a", "b", "strong", "i", "em", "u", "s", "del", "code", "small", "sub", "sup", "mark"]);

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ---------------------------------------------------------------- media query
function lenPx(n, unit) { return unit === "px" ? Number(n) : Number(n) * 16; }
function mediaOk(q) {
    if (!q || !q.trim()) return true;
    return q.toLowerCase().split(",").some((part) => {
        const p = part.trim();
        if (/\bprint\b|\bspeech\b/.test(p) && !/\bscreen\b|\ball\b/.test(p)) return false;
        if (/^not\b/.test(p)) return false;
        if (/prefers-color-scheme\s*:\s*dark|prefers-reduced-motion\s*:\s*reduce|prefers-contrast\s*:\s*(more|high)|forced-colors\s*:\s*active|hover\s*:\s*none|pointer\s*:\s*coarse|orientation\s*:\s*portrait/.test(p)) return false;
        let m; let ok = true;
        const re1 = /(min|max)-(?:device-)?width\s*:\s*([\d.]+)(px|em|rem)/g;
        while ((m = re1.exec(p))) { const v = lenPx(m[2], m[3]); if (m[1] === "min" ? VW < v : VW > v) ok = false; }
        const re2 = /width\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)/g;
        while ((m = re2.exec(p))) {
            const v = lenPx(m[2], m[3]);
            if ((m[1] === ">=" && !(VW >= v)) || (m[1] === ">" && !(VW > v)) || (m[1] === "<=" && !(VW <= v)) || (m[1] === "<" && !(VW < v))) ok = false;
        }
        const re3 = /([\d.]+)(px|em|rem)\s*(<=|<)\s*width/g;
        while ((m = re3.exec(p))) { const v = lenPx(m[1], m[2]); if (!(m[3] === "<=" ? v <= VW : v < VW)) ok = false; }
        return ok;
    });
}

// ---------------------------------------------------------------- 규칙 수집
function collectRules(cssText, out, counter, limit) {
    let ast;
    try { ast = csstree.parse(cssText, { parseValue: false, parseCustomProperty: false, onParseError() {} }); } catch (e) { return; }
    function walkList(list) {
        list.forEach((node) => {
            if (counter.n >= limit) return;
            if (node.type === "Rule") {
                if (!node.block || node.prelude.type !== "SelectorList") return;
                const decls = [], custom = [];
                node.block.children.forEach((d) => {
                    if (d.type !== "Declaration") return;
                    const prop = d.property.startsWith("--") ? d.property : d.property.toLowerCase();
                    const value = (d.value.value !== undefined ? d.value.value : csstree.generate(d.value)).trim();
                    if (prop.startsWith("--")) custom.push([prop, value]);
                    else if (WANT.has(prop)) decls.push([prop, value, !!d.important]);
                });
                if (!decls.length && !custom.length) return;
                node.prelude.children.forEach((sel) => {
                    const info = analyze(sel);
                    if (!info) return;
                    out.push({ sel: csstree.generate(sel), spec: info.spec, key: info.key, order: counter.n++, decls, custom });
                });
            } else if (node.type === "Atrule") {
                const name = node.name.toLowerCase();
                if (!node.block) return;
                if (name === "media") {
                    if (mediaOk(node.prelude ? csstree.generate(node.prelude) : "")) walkList(node.block.children);
                } else if (name === "supports" || name === "layer" || name === "container") {
                    if (name !== "container") walkList(node.block.children);
                }
            }
        });
    }
    walkList(ast.children);
}
function analyze(sel) {
    // 동적 가상 클래스·가상 요소가 있으면 버린다. 우선순위와 맨 오른쪽 열쇠를 구한다.
    let a = 0, b = 0, c = 0, bad = false;
    let key = { cls: [], id: null, tag: null };
    sel.children.forEach((n) => {
        switch (n.type) {
            case "IdSelector": a++; key.id = n.name; break;
            case "ClassSelector": b++; key.cls.push(n.name); break;
            case "AttributeSelector": b++; break;
            case "TypeSelector": if (n.name !== "*") { c++; key.tag = n.name.toLowerCase(); } break;
            case "PseudoElementSelector": bad = true; break;
            case "PseudoClassSelector": {
                const nm = n.name.toLowerCase();
                if (DYNAMIC.has(nm) || nm === "before" || nm === "after" || nm === "first-line" || nm === "first-letter" || nm === "has" || nm === "host" || nm === "lang" || nm === "dir") bad = true;
                b++;
                break;
            }
            case "Combinator": key = { cls: [], id: null, tag: null }; break;
            case "NestingSelector": bad = true; break;
        }
    });
    if (bad) return null;
    return { spec: a * 10000 + b * 100 + c, key };
}

// ---------------------------------------------------------------- 값 다듬기
function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function hex2(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"); }
function fixColors(v) {
    v = v.replace(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)/g,
        (m, h, s, l, al) => (al !== undefined && parseFloat(al) === 0 ? "transparent" : hslToHex(+h, +s, +l)));
    v = v.replace(/rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/g, (m, r, g, b, al) => {
        if (al !== undefined && parseFloat(al) === 0) return "transparent";
        const p = (x) => (x.endsWith("%") ? parseFloat(x) * 2.55 : parseFloat(x));
        return "#" + hex2(p(r)) + hex2(p(g)) + hex2(p(b));
    });
    v = v.replace(/#([0-9a-f]{6})([0-9a-f]{2})\b/g, (m, c, al) => (al === "00" ? "transparent" : "#" + c));
    v = v.replace(/#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])\b(?![0-9a-f])/g, (m, r, g, b, al) => (al === "0" ? "transparent" : "#" + r + r + g + g + b + b));
    return v;
}
function topTokens(v) {
    const out = []; let depth = 0, cur = "";
    for (const ch of v) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === " " && depth === 0) { if (cur) out.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

// ---------------------------------------------------------------- 본체
function styledSimplify(html, baseUrl, sheets, opt = {}) {
    let maxNodes = opt.maxNodes || 420;
    const maxChars = opt.maxChars || 29000;
    const deadline = Date.now() + (opt.timeBudget || 7000);
    const $ = cheerio.load(html);
    const title = ($("title").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 80);
    let base = baseUrl;
    const baseHref = $("base[href]").attr("href");
    if (baseHref) { try { base = new URL(baseHref, baseUrl).href; } catch (e) {} }

    // 1. 규칙 모으기
    const rules = []; const counter = { n: 0 };
    for (const css of sheets) collectRules(css, rules, counter, 20000);

    // 2. 문서에 있는 class / id / tag 로 미리 거르고 매칭
    const classSet = new Set(), idSet = new Set(), tagSet = new Set();
    $("*").each((_, el) => {
        tagSet.add(el.name.toLowerCase());
        if (el.attribs.id) idSet.add(el.attribs.id);
        if (el.attribs.class) for (const c of el.attribs.class.split(/\s+/)) if (c) classSet.add(c);
    });
    const matched = new Map();       // element -> [{spec, order, decls}]
    const vars = new Map();
    const htmlEl = $("html").first(), bodyEl = $("body").first();
    const cache = new Map();
    let timedOut = false;
    for (const r of rules) {
        if (Date.now() > deadline) { timedOut = true; break; }
        if (r.key.id && !idSet.has(r.key.id)) continue;
        if (r.key.tag && !tagSet.has(r.key.tag)) continue;
        if (r.key.cls.some((c) => !classSet.has(c))) continue;
        let els = cache.get(r.sel);
        if (els === undefined) {
            try { els = $(r.sel).toArray(); } catch (e) { els = null; }
            cache.set(r.sel, els);
        }
        if (!els || !els.length) continue;
        if (r.custom.length && (els.includes(htmlEl[0]) || els.includes(bodyEl[0]))) {
            for (const [k, v] of r.custom) vars.set(k, v);
        }
        if (!r.decls.length) continue;
        for (const el of els) {
            let arr = matched.get(el);
            if (!arr) matched.set(el, (arr = []));
            arr.push(r);
        }
    }
    function resolveVars(v, depth = 0) {
        if (depth > 6 || v.indexOf("var(") < 0) return v;
        let out = "", i = 0;
        while (i < v.length) {
            const at = v.indexOf("var(", i);
            if (at < 0) { out += v.slice(i); break; }
            out += v.slice(i, at);
            let d = 1, j = at + 4;
            while (j < v.length && d > 0) { if (v[j] === "(") d++; else if (v[j] === ")") d--; j++; }
            const inner = v.slice(at + 4, j - 1);
            const comma = inner.indexOf(",");
            const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
            const fb = comma < 0 ? null : inner.slice(comma + 1).trim();
            const val = vars.has(name) ? vars.get(name) : fb;
            if (val === null || val === undefined) return v;      // 풀 수 없음
            out += resolveVars(val, depth + 1);
            i = j;
        }
        return out;
    }

    // 3. 요소별 최종 선언
    const computedCache = new Map();
    function computed(el) {
        if (computedCache.has(el)) return computedCache.get(el);
        const list = [];
        for (const r of matched.get(el) || []) for (const d of r.decls) list.push({ p: d[0], v: d[1], w: (d[2] ? 1e9 : 0) + r.spec * 1e5 + r.order });
        const inline = el.attribs && el.attribs.style;
        if (inline) {
            let k = 0;
            for (const piece of inline.split(";")) {
                const c = piece.indexOf(":");
                if (c < 1) continue;
                const p = piece.slice(0, c).trim().toLowerCase();
                let v = piece.slice(c + 1).trim();
                const imp = /!important/i.test(v);
                v = v.replace(/\s*!important/i, "");
                if (WANT.has(p)) list.push({ p, v, w: (imp ? 3e9 : 2e9) + k++ });
            }
        }
        list.sort((x, y) => x.w - y.w);
        const raw = new Map();
        for (const d of list) { raw.delete(d.p); raw.set(d.p, d.v); }
        const res = { out: new Map(), hidden: false, grid: 0, display: null };
        const put = (p, v) => { res.out.delete(p); res.out.set(p, v); };
        for (let [p, v] of raw) {
            v = resolveVars(v).trim().toLowerCase().replace(/\s+/g, " ");
            if (!v || v.indexOf("var(") >= 0) continue;
            if (/^(initial|unset|revert|revert-layer)$/.test(v)) continue;
            if (p === "position") { if (v === "fixed" || v === "absolute") res.hidden = true; continue; }
            if (p === "visibility") { if (v === "hidden" || v === "collapse") res.hidden = true; continue; }
            if (p === "opacity") { if (parseFloat(v) === 0) res.hidden = true; continue; }
            if (p === "float" || p === "background-image") continue;
            if (p === "grid-template-columns") {
                const m = /repeat\(\s*(\d+)/.exec(v);
                if (m) res.grid = +m[1];
                else if (/auto-fi(ll|t)/.test(v)) res.grid = 3;
                else res.grid = topTokens(v).length;
                continue;
            }
            if (p === "display") {
                if (v === "none") { res.hidden = true; continue; }
                res.display = v;
            }
            if (p === "font") {
                const m = /([\d.]+(?:px|em|rem|%|pt))(?:\s*\/\s*([\d.]+(?:px|em|rem|%)?))?/.exec(v);
                if (m) { put("font-size", m[1]); if (m[2]) put("line-height", m[2]); }
                if (/\bbold\b|\b[6-9]00\b/.test(v)) put("font-weight", "bold");
                if (/\bitalic\b/.test(v)) put("font-style", "italic");
                continue;
            }
            v = v.replace(/light-dark\(\s*([^,()]+(?:\([^)]*\))?)\s*,[^)]*(?:\([^)]*\))?\s*\)/g, "$1");
            v = fixColors(v);
            if (p.startsWith("margin")) v = v.replace(/(^| )-[\d.]+[a-z%]*/g, "$10");
            if ((p === "font-size" || p === "line-height") && parseFloat(v) === 0) continue;
            v = v.replace(/([\d.]+)ch\b/g, (m, n) => (n * 0.5) + "em").replace(/([\d.]+)(d|s|l)v(h|w)\b/g, "$1v$3").replace(/([\d.]+)vmin\b/g, "$1vh");
            if (/calc\(|min\(|max\(|clamp\(|env\(|attr\(|fit-content|max-content|min-content/.test(v)) continue;
            if (p === "background" || p === "background-color") {
                v = v.replace(/url\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
                if (!v) continue;
                if (/currentcolor/.test(v)) continue;
            }
            if (p === "color" && /currentcolor|inherit/.test(v) && v !== "inherit") continue;
            if ((p === "width" || p === "min-width") && /^[\d.]+px$/.test(v) && parseFloat(v) > VW) continue;
            const targets = LOGICAL[p] || [p];
            if (LOGICAL[p] && targets.length === 2) {
                const t = topTokens(v);
                put(targets[0], t[0]); put(targets[1], t[1] || t[0]);
            } else if (OUT_PROPS.has(targets[0])) put(targets[0], v);
        }
        if (res.display === "grid" || res.display === "inline-grid") {
            if (res.grid >= 2) { put("display", "flex"); put("flex-wrap", "wrap"); } else { put("display", "block"); res.grid = 0; }
        } else res.grid = 0;
        computedCache.set(el, res);
        return res;
    }
    const classes = new Map();
    function classFor(tag, outMap, extra) {
        const parts = [];
        for (const [p, v] of outMap) {
            if (p === "display" && ((v === "block" && BLOCK_TAGS.has(tag)) || (v === "inline" && INLINE_TAGS.has(tag)))) continue;
            if (p === "box-sizing" && v === "content-box") continue;
            parts.push(p + ":" + v);
        }
        if (extra) parts.push(extra);
        if (!parts.length) return "";
        const key = parts.join(";");
        if (!classes.has(key)) classes.set(key, "c" + classes.size.toString(36));
        return classes.get(key);
    }

    // 4. 내보내기
    $("[hidden],[aria-hidden='true'],.mw-editsection,.reference,.noprint,.navbox,.mw-jump-link,.sr-only,.visually-hidden," +
        ".sidebar,.infobox,.vertical-navbox,.metadata,.ambox,.hatnote,.toc,#toc,.thumb,.reflist,.mw-references-wrap,.catlinks,.shortdescription").remove();
    const plainTable = new Map();
    function isPlainTable(td) {
        let t = td.parent;
        while (t && t.name !== "table") t = t.parent;
        if (!t) return false;
        if (!plainTable.has(t)) plainTable.set(t, $(t).find("th").length === 0);
        return plainTable.get(t);
    }
    let nodes, chars, cut;
    function walk(node, inPre, childExtra) {
        if (cut) return "";
        if (node.type === "text") {
            let t = node.data || "";
            if (!inPre) t = t.replace(/\s+/g, " ");
            if (!t || t === " ") return t;
            nodes++; chars += t.length;
            if (nodes > maxNodes || chars > maxChars) { cut = true; return ""; }
            return esc(t);
        }
        if (node.type !== "tag") return "";
        const orig = node.name.toLowerCase();
        if (DROP.has(orig)) return "";
        const cs = computed(node);
        if (cs.hidden) return "";
        let tag = orig;
        if (!KEEP.has(tag)) {
            const d = cs.display;
            tag = d && d !== "inline" && d !== "contents" ? "div" : (cs.out.size || childExtra ? (d === "inline" || !d ? inlineOrBlock(orig) : "div") : null);
        }
        const pre = inPre || orig === "pre";
        const extraForKids = cs.grid >= 2 ? "width:" + (100 / cs.grid - 2).toFixed(1) + "%" : "";
        let inner = "";
        for (const c of node.children || []) inner += walk(c, pre, extraForKids);
        if (orig === "br") { nodes++; return "<br>"; }
        if (orig === "hr") { nodes++; return "<hr>"; }
        if (tag === null) return inner;                                   // 스타일 없는 껍데기
        let outMap = cs.out;
        if (inner.trim() && outMap.has("height")) {                    // 내용이 있으면 높이를 고정하지 않는다
            outMap = new Map(outMap);
            const hv = outMap.get("height"); outMap.delete("height");
            if (!/%|auto/.test(hv) && !outMap.has("min-height")) outMap.set("min-height", hv);
        }
        if (orig === "td" && !childExtra && isPlainTable(node)) childExtra = "flex:0 1 auto";
        const cls = classFor(tag, outMap, childExtra);
        const hasBox = cs.out.has("height") || cs.out.has("min-height") || cs.out.has("background") || cs.out.has("background-color") || cs.out.has("border-top") || cs.out.has("border-bottom") || cs.out.has("border");
        if (!inner.trim() && !(cls && hasBox)) return "";
        if (!cls && tag === "span") return inner;
        nodes++;
        let attrs = cls ? ` class="${cls}"` : "";
        chars += tag.length * 2 + 5 + attrs.length;
        if (tag === "a") {
            let href = node.attribs && node.attribs.href;
            let ok = !!href && !href.startsWith("#") && !/^(javascript|mailto|tel):/i.test(href);
            if (ok) { try { href = new URL(href, base).href; } catch (e) { ok = false; } }
            if (ok && !/^https?:/i.test(href)) ok = false;
            if (!ok) { if (!cls) { nodes--; return inner; } tag = "span"; }
            else {
                try { href = decodeURI(href); } catch (e) {}
                href = href.replace(/[<>|]/g, encodeURIComponent).replace(/"/g, "%22").replace(/ /g, "%20");
                chars += href.length + 8;
                attrs += ` href="${href}"`;
            }
        }
        return `<${tag}${attrs}>${inner}</${tag}>`;
    }
    function inlineOrBlock() { return "span"; }
    function emit(root) {
        nodes = 0; chars = 0; cut = false;
        let s = "";
        for (const c of root.contents().toArray()) s += walk(c, false, "");
        return s;
    }
    // 구조용 태그는 스타일이 없어도 div 로 남긴다
    for (const t of ["section", "article", "header", "footer", "main", "aside", "nav", "center", "address", "details", "summary", "figcaption", "caption", "figure"]) KEEP.add(t);

    // 본문 전체가 예산 안에 들어가면 그대로, 아니면 본문 영역만
    let rootEl, bodyHtml, usedRoot, out, css;
    function build() {
    classes.clear();
    rootEl = bodyEl.length ? bodyEl : $.root();
    bodyHtml = emit(rootEl);
    usedRoot = "body";
    if (cut) {
        for (const sel of ["#mw-content-text", "article", "main", "[role=main]", "#content", "#main", ".content"]) {
            const el = $(sel).first();
            if (el.length && el.text().replace(/\s+/g, " ").trim().length > 200) {
                bodyHtml = emit(el); rootEl = el; usedRoot = sel; break;
            }
        }
    }
    bodyHtml = bodyHtml.replace(/<(section|article|header|footer|main|aside|nav|center|address|details|summary|figcaption|caption|figure)([ >])/g, "<div$2")
        .replace(/<\/(section|article|header|footer|main|aside|nav|center|address|details|summary|figcaption|caption|figure)>/g, "</div>");

    // 5. body 에 물려줄 스타일 (잘라낸 조상들의 상속 속성 + 배경)
    const wrap = new Map();
    const chain = [];
    for (let el = rootEl[0]; el && el.type === "tag"; el = el.parent) chain.unshift(el);
    for (const el of chain) {
        const cs = computed(el);
        const isRoot = el === rootEl[0];
        for (const [p, v] of cs.out) {
            if (INHERITED.includes(p)) wrap.set(p, v);
            else if ((p === "background" || p === "background-color") && (el.name === "body" || el.name === "html" || isRoot)) wrap.set("background", v);
            else if (isRoot && usedRoot === "body" && (p.startsWith("margin") || p.startsWith("padding") || p === "max-width" || p === "width")) wrap.set(p, v);
        }
    }
    if (usedRoot !== "body") { wrap.set("margin", "0"); wrap.set("padding", "12px"); }
    else if (![...wrap.keys()].some((k) => k.startsWith("margin"))) wrap.set("margin", "8px");
    const bodyCls = classFor("body", wrap, "");

    css = "";
    for (const [k, name] of classes) css += `.${name}{${k}}`;
    out = (css ? `<style>${css}</style>` : "") + `<body${bodyCls ? ` class="${bodyCls}"` : ""}>` +
        (bodyHtml.trim() || "<p>표시할 내용이 없습니다. (스크립트로만 그려지는 페이지일 수 있어요)</p>");
    if (cut) out += "<hr><p><i>… 페이지가 길어서 여기까지만 보여 줍니다.</i></p>";
    out += "</body>";
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        build();
        if (out.length <= maxChars) break;
        maxNodes = Math.floor(maxNodes * Math.min(0.85, maxChars / out.length));
    }
    return { title, html: out, nodes, truncated: cut, rules: rules.length, classes: classes.size, cssChars: css.length, root: usedRoot, timedOut };
}

module.exports = { styledSimplify, mediaOk };
