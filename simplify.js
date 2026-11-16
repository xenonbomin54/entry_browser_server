// 웹 페이지 HTML을 엔트리 브라우저가 그릴 수 있는 작은 HTML로 줄인다.
const cheerio = require("cheerio");

const DROP = new Set(["script", "style", "noscript", "iframe", "svg", "canvas", "video", "audio", "picture",
    "img", "form", "input", "select", "textarea", "button", "link", "meta", "template", "object", "embed",
    "head", "title", "map", "dialog", "figure"]);
const KEEP = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "a", "ul", "ol", "li", "b", "strong",
    "i", "em", "u", "s", "del", "br", "hr", "blockquote", "pre", "code", "table", "tr", "td", "th", "dl", "dt",
    "dd", "small", "sub", "sup", "mark"]);
const TO_DIV = new Set(["section", "article", "header", "footer", "main", "aside", "nav", "center", "address",
    "details", "summary", "figcaption", "caption"]);
const BLOCKY = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "tr", "td", "th",
    "blockquote", "pre", "dl", "dt", "dd", "hr"]);

function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function simplify(html, baseUrl, opt = {}) {
    const maxNodes = opt.maxNodes || 450;
    const maxChars = opt.maxChars || 30000;
    const $ = cheerio.load(html);
    const title = ($("title").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 80);
    let base = baseUrl;
    const baseHref = $("base[href]").attr("href");
    if (baseHref) { try { base = new URL(baseHref, baseUrl).href; } catch (e) {} }

    $("[hidden],[aria-hidden='true'],.mw-editsection,.reference,.noprint,.navbox,.mw-jump-link,.sr-only,.visually-hidden," +
        ".sidebar,.infobox,.vertical-navbox,.metadata,.ambox,.hatnote,.toc,#toc,.thumb,.reflist,.mw-references-wrap,.catlinks,.shortdescription").remove();

    let root = null;
    for (const sel of ["#mw-content-text", "article", "main", "[role=main]", "#content", "#main", ".content"]) {
        const el = $(sel).first();
        if (el.length && el.text().replace(/\s+/g, " ").trim().length > 200) { root = el; break; }
    }
    if (!root) root = $("body").first();
    if (!root.length) root = $.root();

    let nodes = 0, chars = 0, cut = false;
    function walk(node, inPre) {
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
        let tag = node.name.toLowerCase();
        if (DROP.has(tag)) return "";
        if (TO_DIV.has(tag)) tag = "div";
        const pre = inPre || tag === "pre";
        let inner = "";
        for (const c of node.children || []) inner += walk(c, pre);
        if (tag === "br") { nodes++; return "<br>"; }
        if (tag === "hr") { nodes++; return "<hr>"; }
        if (!KEEP.has(tag)) return inner;                    // span, font 등은 껍데기 제거
        if (!inner.trim()) return "";                         // 빈 요소 제거
        if (tag === "div" && /^<(div|p|ul|ol|table|h[1-6]|blockquote|pre)[ >][\s\S]*<\/\1>$/.test(inner.trim()) &&
            countTop(inner.trim()) === 1) return inner;       // 자식 하나뿐인 div 껍데기 제거
        nodes++;
        if (tag === "a") {
            let href = node.attribs && node.attribs.href;
            if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) return inner;
            try { href = new URL(href, base).href; } catch (e) { return inner; }
            if (!/^https?:/i.test(href)) return inner;
            try { href = decodeURI(href); } catch (e) {}
            href = href.replace(/[<>|]/g, encodeURIComponent);
            chars += href.length + 15;
            return `<a href="${href.replace(/"/g, "%22").replace(/ /g, "%20")}">${inner}</a>`;
        }
        chars += tag.length * 2 + 5;
        return `<${tag}>${inner}</${tag}>`;
    }
    function countTop(s) {
        // 최상위 요소 개수를 대략 센다
        let depth = 0, count = 0;
        const re = /<(\/?)([a-z0-9]+)[^>]*>/g; let m, last = 0;
        while ((m = re.exec(s))) {
            if (depth === 0 && s.slice(last, m.index).trim()) return 2;
            if (m[2] === "br" || m[2] === "hr") { if (depth === 0) count++; }
            else if (m[1]) { depth--; } else { if (depth === 0) count++; depth++; }
            last = re.lastIndex;
        }
        if (s.slice(last).trim()) return 2;
        return count;
    }

    let body = "";
    for (const c of root.contents().toArray()) body += walk(c, false);
    body = body.replace(/(<br>\s*){3,}/g, "<br><br>").trim();
    let out = "";
    if (title && !/<h1>/.test(body.slice(0, 600))) out += `<h1>${esc(title)}</h1>`;
    out += body || "<p>표시할 내용이 없습니다. (스크립트로만 그려지는 페이지일 수 있어요)</p>";
    if (cut) out += "<hr><p><i>… 페이지가 길어서 여기까지만 보여 줍니다.</i></p>";
    return { title, html: out, nodes, truncated: cut };
}

function errorPage(url, msg) {
    return `<h2>페이지를 열 수 없어요</h2><p>${esc(String(url).slice(0, 200))}</p><p>${esc(msg)}</p><p><a href=about:home>홈으로 돌아가기</a></p>`;
}

module.exports = { simplify, errorPage };
