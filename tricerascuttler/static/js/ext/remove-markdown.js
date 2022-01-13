var p = Object.create;
var c = Object.defineProperty;
var u = Object.getOwnPropertyDescriptor;
var d = Object.getOwnPropertyNames;
var f = Object.getPrototypeOf, h = Object.prototype.hasOwnProperty;
var L = (r)=>c(r, "__esModule", {
        value: !0
    })
;
var n = (r, e)=>()=>(e || r((e = {
            exports: {}
        }).exports, e), e.exports)
;
var i = (r, e, a, s)=>{
    if (e && typeof e == "object" || typeof e == "function") for (let l of d(e))!h.call(r, l) && (a || l !== "default") && c(r, l, {
        get: ()=>e[l]
        ,
        enumerable: !(s = u(e, l)) || s.enumerable
    });
    return r;
}, t = (r, e)=>i(L(c(r != null ? p(f(r)) : {}, "default", !e && r && r.__esModule ? {
        get: ()=>r.default
        ,
        enumerable: !0
    } : {
        value: r,
        enumerable: !0
    })), r)
;
var g = n((U, $)=>{
    $.exports = function(r, e) {
        e = e || {}, e.listUnicodeChar = e.hasOwnProperty("listUnicodeChar") ? e.listUnicodeChar : !1, e.stripListLeaders = e.hasOwnProperty("stripListLeaders") ? e.stripListLeaders : !0, e.gfm = e.hasOwnProperty("gfm") ? e.gfm : !0, e.useImgAltText = e.hasOwnProperty("useImgAltText") ? e.useImgAltText : !0;
        var a = r || "";
        a = a.replace(/^(-\s*?|\*\s*?|_\s*?){3,}\s*$/gm, "");
        try {
            e.stripListLeaders && (e.listUnicodeChar ? a = a.replace(/^([\s\t]*)([\*\-\+]|\d+\.)\s+/gm, e.listUnicodeChar + " $1") : a = a.replace(/^([\s\t]*)([\*\-\+]|\d+\.)\s+/gm, "$1")), e.gfm && (a = a.replace(/\n={2,}/g, `
`).replace(/~{3}.*\n/g, "").replace(/~~/g, "").replace(/`{3}.*\n/g, "")), a = a.replace(/<[^>]*>/g, "").replace(/^[=\-]{2,}\s*$/g, "").replace(/\[\^.+?\](\: .*?$)?/g, "").replace(/\s{0,2}\[.*?\]: .*?$/g, "").replace(/\!\[(.*?)\][\[\(].*?[\]\)]/g, e.useImgAltText ? "$1" : "").replace(/\[(.*?)\][\[\(].*?[\]\)]/g, "$1").replace(/^\s{0,3}>\s?/g, "").replace(/^\s{1,2}\[(.*?)\]: (\S+)( ".*?")?\s*$/g, "").replace(/^(\n)?\s{0,}#{1,6}\s+| {0,}(\n)?\s{0,}#{0,} {0,}(\n)?\s{0,}$/gm, "$1$2$3").replace(/([\*_]{1,3})(\S.*?\S{0,1})\1/g, "$2").replace(/([\*_]{1,3})(\S.*?\S{0,1})\1/g, "$2").replace(/(`{3,})(.*?)\1/gm, "$2").replace(/`(.+?)`/g, "$1").replace(/\n{2,}/g, `

`);
        } catch (s) {
            return console.error(s), r;
        }
        return a;
    };
});
var m = t(g()), x = t(g()), { default: y , ...C } = x, w = (m.default ?? y) ?? C;
export { w as default };

