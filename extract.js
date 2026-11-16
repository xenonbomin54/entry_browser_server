// 이 파일의 내용은 "페이지 안에서" 실행된다 (렌더링 서비스의 크롬에 주입).
// 화면에 보이는 상자와 글자를 좌표와 함께 뽑아 그리기 목록으로 만들고 <script id="__eb"> 에 넣는다.
(async function () {
    var BUDGET = __BUDGET__, VW = __VW__;
    function done(s) {
        var el = document.createElement("script");
        el.type = "text/plain"; el.id = "__eb";
        el.textContent = JSON.stringify(s).replace(/</g, "\\u003c");
        document.documentElement.appendChild(el);
    }
    try {
        // 아이콘 글꼴을 쓰는 요소는 글꼴을 바꾸면 깨지므로 미리 표시해 둔다
        var iconEls = new Set();
        document.querySelectorAll("i,span,em,b,a,button,div").forEach(function (e) {
            if (e.childElementCount) return;
            var ff = getComputedStyle(e).fontFamily || "";
            if (/icon|awesome|material|glyph|symbol|fontello|icomoon/i.test(ff) || /(^|[\s_-])(icon|fa|fas|far|fab|glyphicon|material-icons)([\s_-]|$)/i.test(e.className && e.className.baseVal === undefined ? e.className : "")) iconEls.add(e);
        });
        // 엔트리와 같은 글꼴로 배치를 다시 잡는다
        try {
            var lk = document.createElement("link");
            lk.rel = "stylesheet"; lk.href = "https://fonts.googleapis.com/css2?family=Nanum+Gothic:wght@400;700&display=swap";
            document.head.appendChild(lk);
            var st = document.createElement("style");
            st.textContent = '*:not(svg):not(svg *){font-family:"Nanum Gothic","NanumGothic","Apple SD Gothic Neo","Malgun Gothic",sans-serif !important;letter-spacing:normal !important}' +
                "*,*::before,*::after{animation:none !important;transition:none !important;scroll-behavior:auto !important}";
            document.head.appendChild(st);
            await Promise.race([
                (async function () {
                    await new Promise(function (r) { lk.onload = r; lk.onerror = r; });
                    await Promise.all([document.fonts.load('16px "Nanum Gothic"', "가A"), document.fonts.load('bold 16px "Nanum Gothic"', "가A")]);
                })(),
                new Promise(function (r) { setTimeout(r, 2500); }),
            ]);
        } catch (e) {}
        window.scrollTo(0, 0);
        await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });

        var rects = [], links = [], linkIdx = {}, items = [];
        function hex(c) {
            // "rgb(1, 2, 3)" / "rgba(1,2,3,0.5)" -> [hex, alpha]
            var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(c || "");
            if (!m) return null;
            var a = m[4] === undefined ? 1 : (m[4].slice(-1) === "%" ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
            function h(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); }
            return [h(+m[1]) + h(+m[2]) + h(+m[3]), a, +m[1], +m[2], +m[3]];
        }
        function blend(fg, bgHex) {
            // 반투명 색을 뒤 배경과 섞는다
            if (fg[1] >= 0.995) return fg[0];
            var b = [parseInt(bgHex.slice(0, 2), 16), parseInt(bgHex.slice(2, 4), 16), parseInt(bgHex.slice(4, 6), 16)];
            function h(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); }
            return h(fg[2] * fg[1] + b[0] * (1 - fg[1])) + h(fg[3] * fg[1] + b[1] * (1 - fg[1])) + h(fg[4] * fg[1] + b[2] * (1 - fg[1]));
        }
        var sx = window.scrollX, sy = window.scrollY;
        // 화면(VW)보다 넓게 만들어진 페이지는 휴대폰 브라우저처럼 전체 폭이 보이게 줄여서 보낸다
        var PW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
        var CW = PW > VW + 16 ? Math.min(PW, 1400) : VW, K = VW / CW;
        function addRect(x, y, w, h, c, clip) {
            var x1 = x + w, y1 = y + h;
            if (clip) { x = Math.max(x, clip[0]); y = Math.max(y, clip[1]); x1 = Math.min(x1, clip[2]); y1 = Math.min(y1, clip[3]); }
            x = Math.max(x, 0); x1 = Math.min(x1, CW);
            if (x1 - x < 0.5 || y1 - y < 0.5 || y1 < 0) return;
            x *= K; y *= K; x1 *= K; y1 *= K;
            items.push({ k: "R", y: y, s: "R|" + Math.round(x) + "|" + Math.round(y) + "|" + Math.max(1, Math.round(x1 - x)) + "|" + Math.max(1, Math.round(y1 - y)) + "|" + c });
        }
        function linkOf(el) {
            var a = el.closest ? el.closest("a[href]") : null;
            if (!a) return 0;
            var h = a.href;
            if (!/^https?:/i.test(h)) return 0;
            if (h.split("#")[0] === location.href.split("#")[0]) return 0;
            try { h = decodeURI(h); } catch (e) {}
            h = h.replace(/[|\n\r]/g, encodeURIComponent).replace(/ /g, "%20");
            if (h.length > 300) return 0;
            if (!linkIdx[h]) { links.push(h); linkIdx[h] = links.length; }
            return linkIdx[h];
        }
        function addText(x, yc, w, fs, c, fl, li, text) {
            text = text.replace(/[|\n\r\t]/g, " ");
            if (!text.trim()) return;
            x *= K; yc *= K; w *= K; fs *= K;
            items.push({ k: "T", y: yc - fs / 2, s: "T|" + Math.round(x) + "|" + Math.round(yc) + "|" + Math.round(w) + "|" + (Math.round(fs * 10) / 10) + "|" + c + "|" + fl + "|" + li + "|" + text });
        }
        function textRuns(node, cs, el, bgHex, clip) {
            var raw = node.nodeValue;
            if (!raw || !raw.trim()) return;
            var col = hex(cs.color);
            if (!col || col[1] < 0.1) return;
            var fs = parseFloat(cs.fontSize) || 16;
            if (fs < 5) return;
            var color = blend(col, bgHex);
            var deco = cs.textDecorationLine || "";
            for (var p = el; p && p.nodeType === 1 && !/underline|line-through/.test(deco); p = p.parentElement) {
                var d = getComputedStyle(p).textDecorationLine || "";
                if (/underline|line-through/.test(d)) deco = d;
                if (getComputedStyle(p).display !== "inline") break;
            }
            var fl = (parseInt(cs.fontWeight, 10) >= 600 ? 1 : 0) + (cs.fontStyle === "italic" ? 2 : 0) + (/underline/.test(deco) ? 4 : 0) + (/line-through/.test(deco) ? 8 : 0);
            var li = linkOf(el);
            var tt = cs.textTransform;
            var range = document.createRange();
            var re = /\S+/g, m, cur = null;
            function flush() {
                if (!cur) return;
                var t = raw.slice(cur.a, cur.b);
                if (tt === "uppercase") t = t.toUpperCase(); else if (tt === "lowercase") t = t.toLowerCase();
                else if (tt === "capitalize") t = t.replace(/(^|\s)(\S)/g, function (q, a, b) { return a + b.toUpperCase(); });
                var yc = (cur.top + cur.bottom) / 2;
                if (!clip || (cur.left < clip[2] && cur.right > clip[0] && yc > clip[1] && yc < clip[3])) {
                    if (cur.right > 0 && cur.left < CW) addText(cur.left, yc, cur.right - cur.left, fs, color, fl, li, t);
                }
                cur = null;
            }
            while ((m = re.exec(raw))) {
                range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
                var rs = range.getClientRects();
                if (!rs.length) continue;
                var r = rs[0], last = rs[rs.length - 1];
                if (r.width < 0.5 && r.height < 0.5) continue;
                var top = r.top + sy, bottom = r.bottom + sy, left = r.left + sx, right = (rs.length > 1 ? r.right : last.right) + sx;
                if (cur && Math.abs(top - cur.top) < 3 && left >= cur.right - 1 && left - cur.right < fs * 1.2 && rs.length === 1) {
                    cur.right = right; cur.b = m.index + m[0].length;
                } else {
                    flush();
                    if (rs.length > 1) {
                        // 한 낱말이 여러 줄에 걸친 경우: 줄마다 따로
                        var chars = m[0], ci = 0, seg = null;
                        for (ci = 0; ci < chars.length; ci++) {
                            range.setStart(node, m.index + ci); range.setEnd(node, m.index + ci + 1);
                            var cr = range.getClientRects()[0];
                            if (!cr) continue;
                            if (seg && Math.abs(cr.top + sy - seg.top) < 3) { seg.right = cr.right + sx; seg.b = m.index + ci + 1; }
                            else { if (seg) { cur = seg; flush(); } seg = { top: cr.top + sy, bottom: cr.bottom + sy, left: cr.left + sx, right: cr.right + sx, a: m.index + ci, b: m.index + ci + 1 }; }
                        }
                        cur = seg;
                    } else cur = { top: top, bottom: bottom, left: left, right: right, a: m.index, b: m.index + m[0].length };
                }
            }
            flush();
        }
        var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, OPTION: 1, DATALIST: 1 };
        var count = 0;
        function walk(el, bgHex, clip) {
            if (++count > 12000) return;
            if (SKIP[el.tagName]) return;
            var cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity) < 0.05) return;
            var r = el.getBoundingClientRect();
            var x = r.left + sx, y = r.top + sy, w = r.width, h = r.height;
            var tag = el.tagName;
            var isRootish = tag === "HTML" || tag === "BODY";
            if (w > 0.5 && h > 0.5 && !isRootish) {
                if (clip && (x >= clip[2] || x + w <= clip[0] || y >= clip[3] || y + h <= clip[1]) && cs.position !== "fixed") {
                    if (cs.overflow !== "visible" || !el.childElementCount) return;
                }
                var bg = hex(cs.backgroundColor);
                var masked = (cs.maskImage && cs.maskImage !== "none") || (cs.webkitMaskImage && cs.webkitMaskImage !== "none");
                if (masked) bg = null;                                   // 아이콘(마스크)은 색 덩어리로 칠하지 않는다
                var grad = !bg || bg[1] < 0.05 ? /gradient\([^)]*?(rgba?\([^)]+\))/.exec(cs.backgroundImage || "") : null;
                if (grad) bg = hex(grad[1]);
                if (bg && bg[1] >= 0.05) {
                    var c = blend(bg, bgHex);
                    if (c !== bgHex || w * h < 1) addRect(x, y, w, h, c, clip);
                    bgHex = c;
                } else if (/url\(/.test(cs.backgroundImage || "") && w >= 40 && h >= 40 && w * h < VW * 2000 && !el.textContent.trim()) {
                    addRect(x, y, w, h, "e3e6ea", clip);
                }
                var sides = [["Top", x, y, w, 0], ["Bottom", x, y + h, w, 1], ["Left", x, y, 0, h], ["Right", x + w, y, 1, h]];
                for (var i = 0; i < 4; i++) {
                    var bw = parseFloat(cs["border" + sides[i][0] + "Width"]) || 0;
                    if (bw < 0.5 || cs["border" + sides[i][0] + "Style"] === "none" || cs["border" + sides[i][0] + "Style"] === "hidden") continue;
                    var bc = hex(cs["border" + sides[i][0] + "Color"]);
                    if (!bc || bc[1] < 0.1) continue;
                    var cc = blend(bc, bgHex);
                    if (i === 0) addRect(x, y, w, bw, cc, clip);
                    else if (i === 1) addRect(x, y + h - bw, w, bw, cc, clip);
                    else if (i === 2) addRect(x, y, bw, h, cc, clip);
                    else addRect(x + w - bw, y, bw, h, cc, clip);
                }
                if (tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" || tag === "IFRAME" || tag === "PICTURE" || tag === "OBJECT" || tag === "EMBED" || (tag === "svg" && w >= 40 && h >= 40)) {
                    if (w >= 24 && h >= 24) {
                        addRect(x, y, w, h, "e3e6ea", clip);
                        var alt = (el.getAttribute("alt") || "").trim();
                        if (alt && w > 60 && h > 20) addText(x + 4, y + Math.min(h / 2, 12), Math.min(w - 8, alt.length * 7), 11, "8a9099", 0, linkOf(el), alt.slice(0, Math.max(4, Math.floor(w / 8))));
                    }
                    return;
                }
                if ((tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && w > 20) {
                    var type = (el.getAttribute("type") || "").toLowerCase();
                    var val = tag === "SELECT" ? (el.selectedOptions[0] ? el.selectedOptions[0].text : "") : (el.value || el.getAttribute("placeholder") || "");
                    if (type !== "hidden" && type !== "checkbox" && type !== "radio" && val) {
                        var fsz = parseFloat(cs.fontSize) || 13, pc = hex(cs.color) || ["666666", 1];
                        var pl = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
                        var isBtn = type === "submit" || type === "button";
                        var est = Math.min(w - pl * 2, val.length * fsz * 0.6);
                        addText(isBtn ? x + (w - est) / 2 : x + pl, y + h / 2, est, fsz, el.value ? pc[0] : "9aa0a6", 0, 0, val.slice(0, 60));
                    }
                    return;
                }
            }
            if (tag === "svg" || tag === "SVG") return;
            if (iconEls.has(el)) return;
            var myClip = clip;
            if (!isRootish && w > 0 && h > 0 && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) {
                var cx0 = cs.overflowX !== "visible" ? x : -1e9, cx1 = cs.overflowX !== "visible" ? x + w : 1e9;
                var cy0 = cs.overflowY !== "visible" ? y : -1e9, cy1 = cs.overflowY !== "visible" ? y + h : 1e9;
                myClip = clip ? [Math.max(clip[0], cx0), Math.max(clip[1], cy0), Math.min(clip[2], cx1), Math.min(clip[3], cy1)] : [cx0, cy0, cx1, cy1];
            }
            if (cs.display === "list-item" && cs.listStyleType !== "none" && w > 0) {
                var lfs = parseFloat(cs.fontSize) || 16, lc = hex(cs.color);
                var mk = "•";
                if (/decimal|numeric/.test(cs.listStyleType)) { var n = 1, sb = el; while ((sb = sb.previousElementSibling)) if (sb.tagName === "LI") n++; var start = el.parentElement && el.parentElement.getAttribute("start"); mk = (n + (start ? parseInt(start, 10) - 1 : 0)) + "."; }
                else if (cs.listStyleType === "circle") mk = "◦"; else if (cs.listStyleType === "square") mk = "▪";
                var lh = parseFloat(cs.lineHeight) || lfs * 1.3;
                if (lc && cs.listStylePosition !== "inside") addText(x - lfs * 0.5 - mk.length * lfs * 0.55, y + (parseFloat(cs.paddingTop) || 0) + lh / 2, mk.length * lfs * 0.55, lfs, blend(lc, bgHex), 0, 0, mk);
            }
            for (var ch = el.firstChild; ch; ch = ch.nextSibling) {
                if (ch.nodeType === 3) textRuns(ch, cs, el, bgHex, myClip);
                else if (ch.nodeType === 1) walk(ch, bgHex, myClip);
            }
        }
        // 페이지 바탕색
        var pageBg = "ffffff";
        var hb = hex(getComputedStyle(document.documentElement).backgroundColor), bb = document.body ? hex(getComputedStyle(document.body).backgroundColor) : null;
        if (hb && hb[1] > 0.05) pageBg = blend(hb, "ffffff");
        else if (bb && bb[1] > 0.05) pageBg = blend(bb, "ffffff");
        if (document.body) walk(document.body, pageBg, null);

        var docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) * K;
        // 예산에 맞게 위에서부터 자른다
        var linkCost = links.map(function (l) { return l.length + 3; });
        var total = 0, i;
        for (i = 0; i < items.length; i++) total += items[i].s.length + 1;
        for (i = 0; i < links.length; i++) total += linkCost[i];
        var cut = false;
        if (total > BUDGET) {
            cut = true;
            var ys = items.map(function (it) { return it.y; }).sort(function (a, b) { return a - b; });
            var lo = 0, hi = ys.length - 1, best = 0;
            while (lo <= hi) {
                var mid = (lo + hi) >> 1, lim = ys[mid], sum = 0, used = {};
                for (i = 0; i < items.length; i++) if (items[i].y <= lim) {
                    sum += items[i].s.length + 1;
                    if (items[i].k === "T") { var parts = items[i].s.split("|"); var li2 = +parts[7]; if (li2 && !used[li2]) { used[li2] = 1; sum += linkCost[li2 - 1]; } }
                }
                if (sum <= BUDGET - 200) { best = lim; lo = mid + 1; } else hi = mid - 1;
            }
            items = items.filter(function (it) { return it.y <= best; });
            docH = Math.min(docH, best + 60);
        }
        // 쓰인 링크만 다시 번호를 매긴다
        var remap = {}, outLinks = [];
        var lines = items.map(function (it) {
            if (it.k !== "T") return it.s;
            var p = it.s.split("|"), li3 = +p[7];
            if (li3) { if (!remap[li3]) { outLinks.push(links[li3 - 1]); remap[li3] = outLinks.length; } p[7] = remap[li3]; }
            return p.slice(0, 8).join("|") + "|" + p.slice(8).join("|");
        });
        var out = ["@DL1", "P|" + Math.round(docH) + "|" + pageBg + "|" + (cut ? 1 : 0)];
        outLinks.forEach(function (l) { out.push("L|" + l); });
        out = out.concat(lines);
        done({ ok: true, dl: out.join("\n"), title: (document.title || "").slice(0, 80), items: items.length, cut: cut });
    } catch (e) {
        done({ ok: false, error: String(e && e.message || e) });
    }
})();