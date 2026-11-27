/**
 * Hand-written XML samples for the lossless XML layer tests. They follow the
 * shapes office applications write (WordprocessingML, SpreadsheetML, package
 * parts) plus generic XML features the parser must keep byte for byte.
 */

export interface XmlSample {
  readonly name: string;
  readonly xml: string;
}

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

export const WORD_DOCUMENT =
  DECLARATION +
  '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"' +
  ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
  ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
  ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
  ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"' +
  ' xmlns:v="urn:schemas-microsoft-com:vml" mc:Ignorable="w14 wp14">' +
  "<w:body>" +
  '<w:p w:rsidR="00A77B3E" w:rsidRDefault="00C12F4A" w14:paraId="1A2B3C4D">' +
  '<w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="both"/></w:pPr>' +
  '<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t>Terms &amp; Conditions</w:t></w:r>' +
  "</w:p>" +
  "<w:p>" +
  '<w:r><w:t xml:space="preserve">The supplier&#8217;s liability is limited to </w:t></w:r>' +
  '<w:ins w:id="12" w:author="Matrix Agent" w:date="2026-01-05T10:00:00Z">' +
  '<w:r><w:t xml:space="preserve">&lt;amount&gt; or &quot;the cap&quot; </w:t></w:r>' +
  "</w:ins>" +
  '<w:del w:id="13" w:author="O&apos;Neil &amp; Co" w:date="2026-01-05T10:01:00Z">' +
  '<w:r><w:delText xml:space="preserve">&#x20AC;1,000 </w:delText></w:r>' +
  "</w:del>" +
  '<w:r><w:tab/><w:t>end.</w:t><w:br w:type="page"/></w:r>' +
  "</w:p>" +
  "<w:p><w:r>" +
  "<mc:AlternateContent>" +
  '<mc:Choice Requires="wps"><w:drawing><wp:inline distT="0" distB="0"><wp:extent cx="914400" cy="914400"/></wp:inline></w:drawing></mc:Choice>' +
  '<mc:Fallback><w:pict><v:rect style="width:72pt;height:72pt;mso-wrap-style:square" fillcolor="#4f81bd"/></w:pict></mc:Fallback>' +
  "</mc:AlternateContent>" +
  "</w:r></w:p>" +
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tr><w:tc><w:p/></w:tc><w:tc><w:p></w:p></w:tc></w:tr></w:tbl>' +
  '<w:sectPr w:rsidR="00A77B3E"><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
  "</w:body></w:document>";

export const WORD_COMMENTS =
  DECLARATION +
  '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:comment w:id="0" w:author="Dana Reviewer" w:date="2026-02-01T09:30:00Z" w:initials="DR">' +
  '<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>' +
  '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' +
  '<w:r><w:t xml:space="preserve">Is 5 &lt; 7 &amp;&amp; 7 &gt; 5 really needed here? </w:t></w:r>' +
  "</w:p></w:comment></w:comments>";

export const SHEET =
  DECLARATION +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac"' +
  ' xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">' +
  '<dimension ref="A1:C3"/>' +
  '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="B2" sqref="B2"/></sheetView></sheetViews>' +
  '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>' +
  "<sheetData>" +
  '<row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" s="2"><v>44927</v></c></row>' +
  '<row r="2" spans="1:3"><c r="A2"><v>1.5</v></c><c r="B2"><f>IF(A2&gt;1,"big","small")&amp;" one"</f><v>big one</v></c><c r="C2" t="b"><v>1</v></c></row>' +
  '<row r="3" spans="1:3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">  padded  </t></is></c><c r="B3" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="C3"><f t="shared" ref="C3:C9" si="0">SUM(A$2:A3)</f><v>1.5</v></c></row>' +
  "</sheetData>" +
  '<mergeCells count="1"><mergeCell ref="A5:C5"/></mergeCells>' +
  '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
  "</worksheet>";

export const SHARED_STRINGS =
  DECLARATION +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' +
  "<si><t>Name</t></si>" +
  '<si><t xml:space="preserve"> </t></si>' +
  "<si><t>line one_x000D_\nline two</t></si>" +
  '<si><r><t xml:space="preserve">plain </t></r><r><rPr><b/><sz val="11"/><color rgb="FFFF0000"/><rFont val="Calibri"/></rPr><t>bold &amp; red</t></r></si>' +
  "</sst>";

export const RELATIONSHIPS =
  DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>' +
  "</Relationships>";

export const CONTENT_TYPES =
  DECLARATION +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

/** Generic XML that exercises every lexical form the parser keeps. */
export const KITCHEN_SINK =
  "<?xml version='1.0'  encoding='utf-8'?>\n" +
  "<!-- leading comment -->\n" +
  '<?mso-application progid="Word.Document"?>\n' +
  "<root  xmlns='urn:default'\n\txmlns:a = \"urn:a\"   a:flag='it&apos;s &quot;on&quot;' empty=\"\" >\n" +
  "  <a:item id = '1'/>\n" +
  "  <a:item id='2' ></a:item >\n" +
  "  <a:item id=\"3\"   />\n" +
  "  <!---->\n" +
  "  <!-- a comment with <tags> & ampersands -->\n" +
  "  <![CDATA[if (a < b && c > d) { x = \"]]\"; }]]>\n" +
  "  <![CDATA[]]>\n" +
  "  <?pi?>\n" +
  "  <?target some data ? > still data?>\n" +
  "  <text>&#65;&#x42;&#x0043; &amp;amp; tab&#9;lf&#10;cr&#13; nbsp&#xA0;end ]] > done</text>\n" +
  "  <multi line=\"first\n\tsecond\" gt='a>b'/>\n" +
  "  <deep><er><still>x</still></er></deep>\n" +
  "</root >\n" +
  "<!-- trailing comment -->\n" +
  "<?trailing pi?>\n";

export const UNICODE =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<文書 言語="日本語" emoji="😀👍🏽">' +
  "<段落>こんにちは、世界 — naïve café ‘quotes’   </段落>" +
  "<é_ü-ö.1 ñ=\"ß\"/>" +
  "<math>𝒜 ⊂ ℝ³ &#x1F600; &#128512;</math>" +
  "</文書>";

export const VML =
  '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">\r\n' +
  ' <o:shapelayout v:ext="edit">\r\n  <o:idmap v:ext="edit" data="1"/>\r\n </o:shapelayout>\r\n' +
  ' <v:shape id="_x0000_s1025" type="#_x0000_t202" style=\'position:absolute;\r\n  margin-left:59.25pt;visibility:hidden\' fillcolor="#ffffe1" o:insetmode="auto">\r\n' +
  '  <x:ClientData ObjectType="Note">\r\n   <x:MoveWithCells/>\r\n   <x:Anchor>\r\n    1, 15, 0, 2, 3, 31, 4, 1</x:Anchor>\r\n  </x:ClientData>\r\n' +
  " </v:shape>\r\n</xml>";

export const SAMPLES: readonly XmlSample[] = [
  { name: "WordprocessingML document", xml: WORD_DOCUMENT },
  { name: "WordprocessingML comments", xml: WORD_COMMENTS },
  { name: "SpreadsheetML worksheet", xml: SHEET },
  { name: "SpreadsheetML shared strings", xml: SHARED_STRINGS },
  { name: "package relationships", xml: RELATIONSHIPS },
  { name: "content types", xml: CONTENT_TYPES },
  { name: "every lexical form", xml: KITCHEN_SINK },
  { name: "non-ASCII names and text", xml: UNICODE },
  { name: "VML with CRLF line endings", xml: VML },
  { name: "byte order mark", xml: "﻿" + RELATIONSHIPS },
  { name: "self-closing root", xml: "<a/>" },
  { name: "empty root with end tag", xml: "<a></a>" },
  { name: "root with text", xml: "<a>text</a>" },
  { name: "whitespace around the root", xml: "\n\n  <a/>  \n" },
  { name: "a CDATA terminator written in plain text", xml: "<a>x]]>y</a>" },
  { name: "a byte order mark character inside text", xml: "<a>x\ufeffy</a>" },
  { name: "single-quoted declaration with standalone", xml: "<?xml version='1.1' standalone='no' ?><a/>" },
  { name: "style sheet instruction before the root", xml: '<?xml-stylesheet type="text/xsl" href="a.xsl"?><a/>' },
];

/** A small deterministic generator (linear congruential), so failures reproduce. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A worksheet of at least `minChars` characters, shaped like real cell data. */
export function buildLargeSheet(minChars: number): string {
  const parts: string[] = [
    DECLARATION,
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<sheetData>",
  ];
  const columns = ["A", "B", "C", "D", "E", "F", "G", "H"];
  let size = 0;
  for (let row = 1; size < minChars; row++) {
    let line = `<row r="${row}" spans="1:8" x14ac:dyDescent="0.25">`;
    for (let col = 0; col < columns.length; col++) {
      const ref = `${columns[col]}${row}`;
      if (col === 0) line += `<c r="${ref}" t="s"><v>${row % 977}</v></c>`;
      else if (col === 5) line += `<c r="${ref}" s="3"><f>SUM(B${row}:E${row})&amp;""</f><v>${row * 4}</v></c>`;
      else if (col === 7) line += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve"> note ${row} </t></is></c>`;
      else line += `<c r="${ref}" s="${col}"><v>${(row * col * 1.25).toFixed(2)}</v></c>`;
    }
    line += "</row>";
    parts.push(line);
    size += line.length;
  }
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

/** A WordprocessingML body of at least `minChars` characters. */
export function buildLargeDocument(minChars: number): string {
  const parts: string[] = [
    DECLARATION,
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>',
  ];
  let size = 0;
  for (let index = 0; size < minChars; index++) {
    const paragraph =
      `<w:p w:rsidR="00A7${(index % 4096).toString(16).padStart(4, "0").toUpperCase()}" w14:paraId="${index.toString(16).padStart(8, "0")}">` +
      '<w:pPr><w:pStyle w:val="BodyText"/><w:spacing w:before="120" w:after="120"/></w:pPr>' +
      `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">Clause ${index}: the parties agree that the supplier&#8217;s obligations under section ${index % 40} survive termination &amp; expiry. </w:t></w:r>` +
      '<w:r><w:rPr><w:b/></w:rPr><w:t>Defined Term</w:t></w:r>' +
      "</w:p>";
    parts.push(paragraph);
    size += paragraph.length;
  }
  parts.push("</w:body></w:document>");
  return parts.join("");
}
