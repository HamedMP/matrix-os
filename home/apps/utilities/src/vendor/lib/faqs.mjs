import { getTool } from "./catalog.mjs";

/** Original, task-specific answers for the public Matrix browser tools. Plain text for visible FAQs and structured data. */
const authored = {
  "json-formatter": [
    ["Will the JSON formatter fix an invalid document?", "It formats JSON that already parses. If the input has a syntax error, correct the JSON first; formatting cannot infer missing commas or quotes."],
    ["Does JSON formatting preserve comments and duplicate keys?", "No. JSON does not include comments, and parsing can collapse duplicate object keys. Review the result before replacing a configuration file."],
  ],
  "json-validator": [
    ["What does the JSON validator actually check?", "It checks whether the text parses as JSON and identifies the root value type. It does not verify an API's required fields or business rules."],
    ["Can a valid JSON result still be wrong for my app?", "Yes. A document can be syntactically valid while missing fields or using the wrong values. Validate against the receiving app's schema separately."],
  ],
  "json-minifier": [
    ["Will JSON minification change the data?", "The tool parses and serializes the JSON to remove formatting whitespace. Duplicate keys, comments, and number spelling may not survive that round trip."],
    ["Can I minify JSON that contains comments?", "No. Comments are not part of standard JSON, so remove them or use a format designed for commented configuration before minifying."],
  ],
  "json-to-csv": [
    ["Which JSON shape converts to CSV?", "Use an array of objects. Keys from every object become columns in first-seen order, and missing values become empty cells. Choose comma, semicolon, or tab and include or omit headers."],
    ["How are nested values handled in JSON to CSV?", "Nested objects and arrays become JSON text inside CSV cells. Review those cells if the destination spreadsheet expects flat values."],
  ],
  "csv-to-json": [
    ["Does CSV to JSON understand quoted commas and line breaks?", "Yes. Quoted cells can contain commas and line breaks. The first row supplies unique, nonempty JSON property names."],
    ["Will CSV to JSON infer numbers or dates?", "No. CSV cells are converted to strings, preserving the written value. Convert field types explicitly after reviewing the output."],
  ],
  "base64-encode": [
    ["Does Base64 encoding make text confidential?", "No. Base64 is a reversible representation of bytes, not encryption. Do not use it to protect passwords, tokens, or private documents."],
    ["Which text encoding is used before Base64?", "Matrix encodes the input as UTF-8 bytes, then converts those bytes to Base64. That preserves ordinary multilingual text for compatible decoders."],
  ],
  "base64-decode": [
    ["Why can a Base64 value fail to decode as text?", "The decoded bytes must be valid UTF-8. Binary files and malformed Base64 are rejected because this tool displays text rather than arbitrary bytes."],
    ["Does Base64 decoding check whether content is safe?", "No. It reveals the encoded text but does not establish trust. Treat decoded scripts, links, and credentials as untrusted content."],
  ],
  "url-encoder": [
    ["Should I paste a whole URL into the URL encoder?", "This tool encodes one URL component, such as a query parameter value. Encoding an entire URL would also escape its separators."],
    ["Why are spaces encoded as percent signs instead of plus signs?", "The output uses component encoding, where a space becomes percent-encoded. HTML form encoding uses a different plus-sign convention."],
  ],
  "url-decoder": [
    ["Will the URL decoder turn plus signs into spaces?", "No. It decodes percent escapes and leaves plus signs intact. Form-encoded query strings may need a separate conversion."],
    ["What happens when a percent escape is malformed?", "The tool reports invalid URL-encoded text instead of guessing. Correct the escape sequence before using the decoded value."],
  ],
  "html-encoder": [
    ["Where can I safely use HTML-encoded output?", "It is suitable for displaying text inside an HTML text context. Attribute, script, URL, and CSS contexts require their own encoding rules."],
    ["Does HTML encoding sanitize an entire webpage?", "No. This tool escapes input text; it does not audit scripts or make arbitrary HTML safe to render. Prefer safe DOM text APIs."],
  ],
  "html-decoder": [
    ["Will HTML decoding remove dangerous markup?", "No. Decoding entities can reveal markup characters. Insert the result as text, not trusted HTML, unless it has been separately sanitized."],
    ["What kinds of entities can the HTML decoder read?", "It handles common named entities and numeric references in pasted text. Review unusual or malformed entities before using the result."],
  ],
  "hash-generator": [
    ["Which hash and output formats does Matrix generate?", "The tool computes SHA-256 over UTF-8 text. You can copy the digest as hexadecimal, Base64, or an SRI-style sha256 value."],
    ["Can I store passwords as these SHA-256 hashes?", "No. A fast SHA-256 digest alone is unsuitable for password storage. Use a dedicated password hashing scheme with per-password salts."],
  ],
  "uuid-generator": [
    ["Which UUID version does this generator create?", "It creates random UUID version 4 values using the browser's cryptographic random source. The IDs do not encode a timestamp."],
    ["How many UUIDs can I generate at once?", "Enter a count from 1 through 100. Generate another batch if needed, and check uniqueness in the system where you use the IDs."],
  ],
  "regex-tester": [
    ["Can a costly regular expression freeze the page?", "Patterns run in a disposable browser worker with a short deadline and bounded matches. A pattern that takes too long is stopped."],
    ["Which regular-expression syntax does the tester use?", "It uses JavaScript regular expressions. Put the pattern on the first line and sample text below; the output lists up to 100 matches."],
  ],
  "text-diff": [
    ["How do I separate the two versions in Text Diff?", "Put three hyphens on their own line between the old and new blocks. The result marks added and removed lines."],
    ["Does Text Diff understand meaning or code moves?", "No. It compares lines rather than intent, so moved lines may appear as a removal and addition. Review the source when accuracy matters."],
  ],
  "timestamp-converter": [
    ["Does the timestamp converter accept seconds and milliseconds?", "Yes. A 10-digit Unix value is read as seconds and a 13-digit value as milliseconds. ISO date strings are also accepted."],
    ["Why do UTC and local timestamp results differ?", "They describe the same instant in different time zones. The local display follows the browser's time-zone setting; use UTC for portable records."],
  ],
  "color-converter": [
    ["Which color values can the converter read?", "Enter a three- or six-digit hexadecimal color. Matrix reports the matching RGB and HSL values plus contrast against white and black."],
    ["Do the contrast results guarantee accessible text?", "The ratios test the chosen color against white and black using WCAG thresholds. Actual readability also depends on font size, weight, and the real background."],
  ],
  "word-counter": [
    ["How is reading time estimated in Word Counter?", "The tool counts words and estimates time at about 220 words per minute. Reading speed varies with audience and complexity."],
    ["Are word and sentence counts exact in every language?", "No. The browser uses text heuristics. Languages without spaces, abbreviations, and punctuation can affect the counts."],
  ],
  "character-counter": [
    ["Are emoji counted as one character?", "Not always. The tool counts Unicode code points, while some platforms count grapheme clusters or UTF-16 units. Check the target platform's rule."],
    ["What does the UTF-8 byte count tell me?", "It shows how many bytes the text uses when encoded as UTF-8. Multilingual characters and emoji may use several bytes each."],
  ],
  "readability-checker": [
    ["What does the readability score measure?", "It estimates English reading ease from sentence length and syllable counts. It is a rough editing signal, not a quality grade."],
    ["Can I use this score for non-English copy?", "The syllable heuristic is designed for English. For other languages, review clarity with a native reader or a language-specific measure."],
  ],
  "case-converter": [
    ["How do I choose a case conversion?", "Prefix the text with upper, lower, title, or sentence followed by a vertical bar. Matrix applies that mode to the remaining text."],
    ["Will title case preserve names and acronyms?", "No. It normalizes casing, including many Unicode letters, but names, brand styling, and technical acronyms still need review."],
  ],
  "slug-generator": [
    ["How does Matrix make a URL slug?", "It lowercases text, removes common accents and punctuation, then joins the remaining words with hyphens."],
    ["Can I publish the generated slug without checking it?", "Review transliterations, meaning, and existing URL collisions first. Changing a published slug may require redirects."],
  ],
  "text-cleaner": [
    ["Which whitespace does Text Cleaner change?", "It trims lines, normalizes carriage returns and tabs, collapses repeated spacing, and keeps at most one blank line between paragraphs."],
    ["Is Text Cleaner suitable for code or poetry?", "Usually not. Spacing may carry meaning in code, tables, and verse. Compare the result with the original before replacing it."],
  ],
  "line-sorter": [
    ["Does Line Sorter keep duplicate lines?", "Yes. It changes line order and leaves repeated entries in place. Use Duplicate Line Remover separately when you want unique lines."],
    ["Will numbered versions sort numerically?", "Not necessarily. Sorting follows browser locale comparison, so version strings may need a dedicated numeric or semantic sort."],
  ],
  "duplicate-line-remover": [
    ["Does duplicate removal change the original order?", "No. It keeps the first instance of each exact line and removes later copies while preserving the order of retained lines."],
    ["Are lines with different case or spaces duplicates?", "No. Comparison is exact, so case and whitespace matter. Clean or normalize the text first if near-duplicates should match."],
  ],
  "find-replace": [
    ["Does Find and Replace interpret regex characters?", "No. Search text is matched literally and case-sensitively. Characters such as dots and stars have no pattern meaning here."],
    ["Are dollar signs in replacement text expanded?", "No. Enter your search and replacement in separate fields. Matrix inserts replacement text literally, including dollar-sign sequences such as dollar-ampersand; leave the replacement empty to delete matches."],
  ],
  "markdown-preview": [
    ["Can Markdown Preview run raw HTML?", "No. Raw HTML is escaped and a small Markdown subset is converted into HTML source for inspection or export."],
    ["Which Markdown features should I expect?", "Headings, paragraphs, basic emphasis, lists, inline code, and HTTP or HTTPS links are supported. Extensions may need another editor."],
  ],
  "html-to-text": [
    ["Will HTML to Text execute scripts in pasted markup?", "No. It processes the pasted string as text and removes script and style blocks before returning a readable approximation."],
    ["Can HTML to Text recover text added by JavaScript?", "No. It reads only the HTML you paste, so content rendered later by a live page is absent unless included in that source."],
  ],
  "lorem-ipsum-generator": [
    ["How many placeholder paragraphs can I create?", "Enter a number from 1 to 10. The generated paragraphs are predictable filler for checking basic layout spacing."],
    ["Should I use filler text to sign off a design?", "No. Real headings and copy may have different length and structure. Test the finished design again with representative content."],
  ],
  "keyword-density-checker": [
    ["Does a higher keyword frequency improve rankings?", "Not by itself. The report is an editorial view of repeated terms, not a search-engine target or an instruction to repeat phrases."],
    ["Which words appear in the frequency report?", "The tool lists up to 20 terms longer than two characters, with counts and their share of all detected words."],
  ],
  "meta-tag-generator": [
    ["Which page metadata does this generator create?", "It drafts a title, description, canonical link, and social tags from the title, description, and absolute URL you enter."],
    ["Will search engines display these exact snippets?", "No. Search engines may rewrite titles and descriptions. Review the live page and its intent rather than treating generated tags as a guarantee."],
  ],
  "robots-txt-generator": [
    ["Does robots.txt keep private pages confidential?", "No. Robots directives guide cooperating crawlers and do not control who can open a URL. Use access control for confidential content."],
    ["What should I enter for the sitemap line?", "Provide an absolute sitemap URL. Check that the published sitemap is reachable before placing the generated text at your site's root."],
  ],
  "sitemap-xml-generator": [
    ["Does the sitemap generator crawl my website?", "No. It builds XML from the public HTTPS URLs you paste. It does not discover pages or verify their canonical status."],
    ["Should every pasted URL go into a sitemap?", "Include canonical, indexable pages you want crawlers to discover. Remove redirects, blocked pages, and duplicate URL variants."],
  ],
  "canonical-url-generator": [
    ["Which URL parts does the canonical cleaner remove?", "It strips common tracking parameters and the fragment from a candidate URL, leaving meaningful query parameters for review."],
    ["Is the cleaned URL automatically the right canonical?", "No. Canonical choice depends on your site's content and routing. Confirm that the selected page is the preferred indexable version."],
  ],
  "hreflang-generator": [
    ["Do hreflang tags need to appear on every language page?", "Yes. Each localized page should include reciprocal references to the full alternate set, including its own language version."],
    ["Does this tool verify localized pages exist?", "No. It formats locale and URL pairs you provide. Check each live URL, language code, and reciprocal tag after publishing."],
  ],
  "utm-builder": [
    ["What information should go into UTM values?", "Use campaign labels such as source, medium, and campaign. Avoid names, email addresses, or other sensitive data because URL parameters travel with the link."],
    ["Will UTM parameters change the destination page?", "They add tracking values to the URL. Confirm that your site handles the resulting query string and preserves existing meaningful parameters."],
  ],
  "title-length-checker": [
    ["Is there a guaranteed character limit for Google titles?", "No. Search display depends on width and query context, and Google may rewrite a title. Use the count as an editing aid."],
    ["What makes a useful page title beyond its length?", "Describe the page's specific purpose in plain language, then check that the title matches visible content and is distinct from nearby pages."],
  ],
  "meta-description-checker": [
    ["Does a meta description length guarantee a search snippet?", "No. Search engines may use other page text for a query. The length report helps edit copy but does not control the final snippet."],
    ["Should I repeat keywords in a meta description?", "Write a useful summary of the page for a searcher. Repetition for its own sake can make the description less clear."],
  ],
  "social-preview": [
    ["Which social tags does the card generator draft?", "It builds Open Graph and X card metadata from your page title, description, URL, and image URL."],
    ["Why might a shared link show an older card?", "Social platforms cache preview data and crop images differently. Test the published URL with each platform's preview tools after changes."],
  ],
  "schema-jsonld-generator": [
    ["Which structured-data types are supported?", "The generator drafts basic Organization or SoftwareApplication JSON-LD from the fields you enter. It does not model every schema property."],
    ["Will JSON-LD guarantee a rich search result?", "No. Markup must match visible facts on the page, and search engines decide whether to use it. Validate the published page separately."],
  ],
  "html-seo-audit": [
    ["Does the HTML SEO audit fetch my live page?", "No. It checks pasted HTML or a local HTML file for title, description, headings, canonical links, and indexing directives."],
    ["Can this audit detect every ranking problem?", "No. It covers a bounded set of markup signals and cannot judge content quality, links, rendering after scripts, or search performance."],
  ],
  "agents-md-checker": [
    ["What does the AGENTS.md checker look for?", "It reports headings and length, then flags missing verification and safety guidance using simple text heuristics."],
    ["Does a passing AGENTS.md report prove instructions are safe?", "No. The checker cannot reason about permissions or project policy. Review instructions with the people responsible for the repository."],
  ],
  "mcp-config-validator": [
    ["Does MCP validation connect to configured servers?", "No. It checks JSON structure and common command, URL, and argument shapes without launching a server or testing credentials."],
    ["Can a structurally valid MCP config still fail?", "Yes. Executables may be missing, URLs unreachable, or credentials invalid. Test the configuration in its actual client environment."],
  ],
  "local-ai-chat": [
    ["Does Local AI Chat send my messages to Matrix?", "No. The model runs in your browser after its first download of about 185 MB. Messages stay in this tab and are not stored in a Matrix account."],
    ["Will the local chat remember my conversation later?", "No. This is a temporary, bounded conversation that ends when you close or reload the tab. Save any useful answer separately and verify important facts."],
  ],
  "prompt-token-estimator": [
    ["How does Matrix estimate prompt tokens?", "It uses a rough character-based calculation. Actual counts depend on the model tokenizer, language, formatting, and tool messages."],
    ["Can I use this estimate to enforce a model limit?", "Treat it as an early planning signal. Leave room for system instructions and outputs, then check the actual model or API count."],
  ],
  "cron-expression-explainer": [
    ["Which cron syntax can the helper explain?", "It accepts five numeric fields with wildcards, lists, ranges, and steps. Vendor-specific names and extensions are outside this helper."],
    ["How are the next cron runs calculated?", "The preview shows five future instants in UTC using standard day-of-month and weekday matching. Your scheduler's timezone may differ."],
  ],
  "pdf-workspace": [
    ["How do I arrange and rotate pages in PDF Workspace?", "Choose one to ten local PDFs. After page thumbnails load, drag cards or use the arrows to set output order, then choose 0, 90, 180, or 270 degrees of clockwise rotation for each page."],
    ["Will PDF Workspace preserve every interactive feature?", "The output combines your arranged pages into a new PDF. Review forms, signatures, scripts, or unusual annotations after download because copying and rotating pages may affect them."],
  ],
  "pdf-podcast": [
    ["Does PDF to Narrated Audio summarize my document?", "No. It creates a spoken reading of the selectable text you review and edit. It does not summarize the PDF or create a conversation between speakers."],
    ["Can I narrate a scanned PDF?", "Scanned pages need OCR first because this tool reads selectable PDF text. The PDF may contain up to 20 pages and 12 MB, while the edited narration is capped at 6,000 characters."],
    ["Does the narration upload my PDF or audio?", "The PDF text and generated WAV stay in your browser. On first use, the browser downloads voice model files; generation then runs locally and may need substantial memory."],
  ],
  "check-pdf-signature": [
    ["What does this PDF signature checker verify?", "For a supported detached CMS signature, it checks whether the signed bytes match the embedded signature and whether additional bytes follow the signed revision. It can also report an unsupported format."],
    ["Does a matching signature prove who signed the PDF?", "No. Certificate trust, signer identity, revocation, timestamps, and permission for later changes are not checked. Verify those separately before relying on a document."],
    ["Will a handwritten or typed signature appear in the report?", "Only an embedded cryptographic PDF signature is detected. A drawn mark or typed name on the page may look like a signature but has no digital signature to check."],
  ],
  "merge-pdfs": [
    ["How is file order chosen when merging PDFs?", "Matrix combines PDFs in the order shown in the selected-file list. There is no page-level ordering control, so inspect the result before sharing."],
    ["Will merging PDFs preserve digital signatures?", "A cryptographic signature may no longer validate after a PDF is modified. Check signed documents separately before using the merged copy."],
  ],
  "split-pdf": [
    ["How do I choose pages in Split PDF?", "Enter page numbers or ranges such as 1,3-5. The tool exports the selected pages into one new PDF."],
    ["Does Split PDF create one file per page?", "No. Selected pages are combined into one output PDF. For separate files, run additional selections and download them individually."],
  ],
  "rotate-pdf": [
    ["Can I rotate a single PDF page?", "This tool applies the chosen 90, 180, or 270 degree turn to every page. Mixed orientation changes need a page-level editor."],
    ["Does rotation change the page text itself?", "Rotation changes how pages are viewed. Review the saved PDF to confirm its layout and any annotations still appear as intended."],
  ],
  "watermark-pdf": [
    ["Does a watermark stop someone editing the PDF?", "No. It adds visible text to pages but does not enforce permissions or prevent a recipient from modifying the document."],
    ["Where does Matrix apply the watermark?", "The chosen short text is stamped across every page in the downloaded copy. Check legibility over light and dark content."],
  ],
  "add-pdf-page-numbers": [
    ["Where will PDF page numbers appear?", "Matrix stamps a small page count near the bottom center of each page. Check documents with tight margins for overlap."],
    ["Will existing page labels be replaced?", "No. This adds visible numbers to the pages. Existing labels or printed numbers can remain and may need manual review."],
  ],
  "edit-pdf-metadata": [
    ["Which PDF metadata fields can I edit?", "The current page lets you set a title and author in the downloaded copy. Subject, keywords, and other fields are not exposed in its controls."],
    ["Does changing PDF metadata remove sensitive history?", "No. Review the full file before sharing sensitive material; updating selected fields is not a forensic cleanup or redaction."],
  ],
  "edit-pdf": [
    ["Can Add Text to PDF rewrite existing words?", "No. It draws new text on the first page. It does not erase or alter underlying PDF text."],
    ["How should I check text added to a PDF?", "Download and open the saved PDF to confirm the text position and any overlap with existing content. This page does not preview the edited output."],
  ],
  "sign-pdf": [
    ["Is a typed PDF signature cryptographically verified?", "No. Matrix places your typed name as a visual mark on the first page; it is not a digital signature or identity check."],
    ["Can I sign every page at once with this tool?", "The visual signature is placed on the first page. Check the saved copy and use a dedicated signing service when formal verification is required."],
  ],
  "protect-pdf": [
    ["What protection does the PDF password add?", "The output uses an AES-256 open password. A recipient needs that password to open the encrypted copy in a compatible viewer."],
    ["Can a recipient still save a decrypted PDF?", "Yes. Someone who knows the open password can view and save content. Share the password separately and choose a strong unique value."],
  ],
  "unlock-pdf": [
    ["Can Unlock PDF recover a forgotten password?", "No. You must know the correct open password. The tool decrypts a PDF you can already open and saves an unencrypted copy."],
    ["What should I do with the unlocked PDF?", "Store or share it carefully: the downloaded output no longer requires the source password for access."],
  ],
  "compress-pdf": [
    ["Will lossless PDF compression reduce every file?", "No. It repacks eligible objects and streams, so an already optimized or image-heavy PDF may stay the same size or grow."],
    ["Does this PDF compressor lower image resolution?", "No. This tool uses lossless repacking rather than intentionally reducing image quality or resolution."],
  ],
  "verify-pdf": [
    ["What does Inspect PDF Structure verify?", "It checks that the document can be opened structurally and reports basic details such as pages, version, and encryption state."],
    ["Does the PDF structure check prove authenticity?", "No. A structurally readable file can still be forged or altered. This tool does not validate cryptographic signatures."],
  ],
  "compare-pdfs": [
    ["What does Compare PDFs compare?", "It compares extractable text on corresponding pages and reports wording differences. It does not inspect pixels, placement, or color."],
    ["Will scanned PDFs show wording differences?", "Only if text can be extracted. Matrix OCR downloads separate text for manual review; it does not add a text layer that this comparison can read."],
  ],
  "pdf-to-word": [
    ["Will the Word file preserve the PDF layout?", "No. Matrix extracts selectable text into editable DOCX paragraphs. Tables, images, fonts, and page layout are not reconstructed."],
    ["Can PDF to Word read a scanned document?", "No. A scan without selectable text will not produce editable paragraphs here. Matrix OCR downloads separate text that you can review and paste into Word."],
  ],
  "pdf-to-excel": [
    ["Does PDF to Excel reconstruct tables?", "No. The workbook contains extracted text lines with page and line references, rather than recovered spreadsheet columns or formulas."],
    ["How should I handle a scanned table PDF?", "This converter cannot recover scanned cells. Matrix OCR downloads separate text; review its values and rebuild the table in a spreadsheet."],
  ],
  "pdf-to-image": [
    ["What does PDF to Images download?", "It renders each accepted page as a PNG and packages the images into a ZIP archive for download."],
    ["Will converted PDF images keep selectable text?", "No. The output is pixels. Keep the original PDF if you still need text selection, search, or accessible document structure."],
  ],
  "redact-pdf": [
    ["Can I redact multiple areas on different PDF pages?", "Yes. Choose a page and draw areas on its preview, or add precise coordinates. Repeat across pages for up to 50 areas, then create the redacted PDF."],
    ["Does covering PDF regions remove the original text layer?", "Matrix rasterizes every page after covering your selected areas, removing the original selectable text layer and interactive content in the output. Open the downloaded file and inspect every page before sharing."],
  ],
  "ocr-pdf": [
    ["What does PDF OCR produce?", "It recognizes English text from up to ten scanned pages and downloads text, not a new searchable PDF."],
    ["Why does OCR PDF take longer the first time?", "A recognition model must download to the browser before local processing. Poor scans and handwriting can still cause errors."],
  ],
  "image-workspace": [
    ["What can I do in the Image Workspace?", "You can convert, compress, or resize a local image, or combine up to ten images into a PDF from one browser workspace."],
    ["What image sizes can the workspace handle?", "Inputs are limited to PNG, JPEG, or WebP up to 20 MB each and 32 million pixels; browser memory can be another constraint."],
  ],
  "image-convert": [
    ["Which image formats can Matrix convert between?", "The browser workspace accepts PNG, JPEG, and WebP and exports a supported choice among those formats."],
    ["What happens to transparency when converting to JPEG?", "JPEG does not support an alpha channel, so transparent areas become opaque in the exported image. Review the preview before using it."],
  ],
  "compress-image": [
    ["Will image compression always make a smaller file?", "No. A selected quality or format can produce a larger copy, especially when the source is already well compressed."],
    ["Does compressing an image change its appearance?", "JPEG and WebP quality settings can soften fine detail. Compare the preview and resulting file size before publishing."],
  ],
  "resize-image": [
    ["Does the image resizer keep proportions?", "Yes by default. Set maximum width and height and leave Keep original proportions checked; uncheck that option to stretch into the chosen dimensions."],
    ["Can increasing image dimensions restore lost detail?", "No. Upscaling adds pixels but cannot recreate information missing from the source. Check sharpness at the target display size."],
  ],
  "image-color-picker": [
    ["How does Image Color Picker choose a color?", "Click a point in the decoded image preview to read its HEX and RGBA pixel values in the browser."],
    ["Why might a picked color differ from the source file?", "The sampled value reflects decoded display pixels; color profiles, transparency, and wide-gamut handling can affect the result."],
  ],
  "image-metadata": [
    ["Which image details does Metadata Viewer show?", "It reports basic size, dimensions, and format, plus selected JPEG EXIF fields when available."],
    ["Does viewing metadata remove it from the photo?", "No. This viewer inspects details and does not strip the source image. Check metadata separately before sharing a sensitive photo."],
  ],
  "images-to-pdf": [
    ["How many images can go into one PDF?", "Choose up to ten local images. Matrix places each image on its own page in selected-file list order, so check the list before creating the PDF."],
    ["Will Images to PDF fit pages to standard paper?", "Images are fitted within 595 by 842 PDF points while keeping their proportions. The page uses the fitted image size, so it is not a fixed paper-size layout."],
  ],
  "image-ocr": [
    ["What kind of image text can OCR recognize?", "It recognizes printed English text best when the image is sharp and well lit. Handwriting and low contrast can reduce accuracy."],
    ["Does Image OCR upload my picture?", "Recognition runs in the browser after any required model download. Review the extracted text because OCR can confuse similar characters."],
  ],
  "image-upscale": [
    ["What is the difference between the two image enlargement modes?", "Smooth enlargement uses browser interpolation to make a 2× or 4× WebP. AI detail enhancement uses a local model to predict a 2× PNG from a small image. Review invented or distorted details before using it."],
    ["Which images can AI detail enhancement process?", "The local model accepts images up to 256 pixels per side and 32,768 input pixels total. Choose smooth interpolation for larger images. The first AI run downloads model files and needs available browser memory."],
  ],
  "blur-faces": [
    ["Will face blurring detect every person?", "No. Detection can miss small, turned, obscured, or unusual faces. Inspect the exported image before relying on it for privacy."],
    ["Does blurring remove original face pixels from the export?", "The exported image contains the processed pixels. Keep the unedited source private and verify each face is sufficiently obscured."],
  ],
  "remove-background": [
    ["Which photos work best with Portrait Background Remover?", "A clear photo with one person works best. Hair, overlapping people, and objects may leave rough edges, so inspect the transparent PNG before publishing."],
    ["Will background removal preserve the source image size?", "The browser reduces large inputs to at most 1,024 pixels per side before local model processing. The first run also downloads about 7 MB of model weights plus a browser runtime."],
  ],
  "zero-shot-image-tags": [
    ["How does Image Tag Suggestions work?", "A local TinyCLIP model compares your image with the 2 to 12 labels you enter, then ranks those labels by relative match. It does not generate new labels or verify that any label is correct."],
    ["Is my image uploaded for tagging?", "No. After downloading about 30 MB of model and tokenizer files plus a browser runtime on first use, the image is processed in your browser. Review suggested labels before publishing them."],
  ],
  "image-caption-generator": [
    ["Does Image Caption Generator upload my photo?", "No. The image is processed in your browser after the model files download. The first download is about 250 MB and may take several minutes on a slow connection."],
    ["Can I publish the generated caption without checking it?", "Review it first. The model can miss context, invent objects, or use wording that does not fit your audience. Edit the suggestion before sharing."],
  ],
  "jwt-decoder": [
    ["Are decoded JWT claims trusted immediately?", "No. Anyone can construct a token-shaped string. Treat claims as unverified until a supported signature is checked against a trusted key."],
    ["Which JWT signatures can Matrix verify?", "The browser supports HS256, HS384, HS512, RS256, RS384, and RS512. Verification does not replace issuer, audience, or application policy checks."],
  ],
  "qr-code-generator": [
    ["What can I put in a Matrix QR code?", "Enter text or a URL up to the tool's 1,024-byte UTF-8 limit, then preview and download an SVG image."],
    ["Will a generated QR code scan on every phone?", "Not necessarily. Print size, contrast, damage, and content length affect scanning. Test the final exported code with a phone."],
  ],
  "password-generator": [
    ["How are generated passwords randomized?", "The browser uses cryptographic random values and your chosen length and character groups to create each password locally."],
    ["Where should I save a generated password?", "Copy it into a trusted password manager. The result lives in this browser tab and can be lost when you close or reset the page."],
  ],
  "password-strength-checker": [
    ["Does the password checker send my password to Matrix?", "The estimate runs in your browser. Matrix does not need the entered password to show feedback for this tool."],
    ["Is a strong password score a security guarantee?", "No. It is an estimate of guessability and can miss exposure or reuse. Use a unique password and multi-factor authentication."],
  ],
  "text-to-speech": [
    ["Can I download audio from Text to Speech?", "No. This tool plays speech through a local voice made available by your browser or device; the browser voice API here does not export audio."],
    ["Why are some voices unavailable in Text to Speech?", "Installed local voices and supported languages vary by browser and device. Choose from the voices shown on your current device."],
  ],
  "code-workspace": [
    ["Can code in the workspace access Matrix data?", "No. Snippets run in a disposable isolated browser environment with network access blocked and a short execution timeout."],
    ["Does the TypeScript workspace type-check a project?", "No. It transpiles a bounded single snippet for execution. Imports and exports are unsupported, and full project type checking is outside this tool."],
  ],
  "audio-workspace": [
    ["Can I work on several audio files at once?", "Yes. Add up to five files and switch between tabs. Each file keeps its own trim, noise, volume, pitch, speed, and preview settings."],
    ["Will my audio session survive a reload?", "When browser storage is available, Audio Workspace saves the original files and edit settings locally for recovery after a reload. Use Clear session to erase them. Exported WAV files are not stored."],
    ["What are the Audio Workspace limits?", "Each file must be 40 MB or smaller and up to three minutes long. The complete saved session can use up to 80 MB. Codec, storage, and memory support vary by browser."],
  ],
  "audio-converter": [
    ["Which audio formats can I export?", "WAV is available, and an Opus export may be offered when your browser supports it. Available source decoders also vary by browser."],
    ["Will converting audio restore lost quality?", "No. Re-encoding cannot recreate information lost in a compressed source. Choose an export format suited to playback compatibility."],
  ],
  "audio-trimmer": [
    ["How do I choose the part of an audio clip to keep?", "Set start and end times within the loaded clip, process it, then preview and export the cut as a new file."],
    ["Does trimming change the original recording?", "No. Matrix processes a local copy and downloads a new result. Keep the original if you may need the removed section later."],
  ],
  "transcription-player": [
    ["Does Transcription Player automatically recognize speech?", "No. It is a manual listening and note-taking workspace for timestamped cues. Automatic recognition is a separate Speech to Text tool."],
    ["What can I export from Transcription Player?", "Your timestamped notes can be downloaded as SRT subtitle cues. Review timing and wording against the recording first."],
  ],
  "speech-to-text": [
    ["Does Speech to Text send my recording to a server?", "No. The browser downloads a speech model on first use, then processes your recording locally. Model availability and performance depend on your device and browser."],
    ["How long a recording can I transcribe?", "Choose an English recording up to two minutes and 25 MB. Review names, numbers, and timing because automatic transcription can make mistakes, especially with noise or overlapping voices."],
  ],
  "audio-compressor": [
    ["How does Audio Compressor reduce file size?", "It exports an Opus copy at your selected target bitrate when the browser supports compressed encoding. Final size can vary."],
    ["Will a lower Opus bitrate always sound acceptable?", "No. Lower bitrates can add audible encoding artifacts. Compare the processed preview with the original before downloading."],
  ],
  "noise-reducer": [
    ["What kind of background sound can Noise Reducer help with?", "It targets a relatively steady noise floor in a short recording. Changing sounds or overlapping voices may remain."],
    ["Can noise reduction damage speech quality?", "Yes. Strong settings can create artifacts or remove quiet details. Preview the processed audio and keep the original recording."],
  ],
  "pitch-and-speed": [
    ["Can I change pitch without changing tempo?", "The workspace provides separate pitch and speed controls for a short clip, then lets you preview and export the processed audio."],
    ["Why can extreme pitch or speed settings sound unnatural?", "Large adjustments require more signal processing and can introduce artifacts. Compare moderate settings against the original before exporting."],
  ],
  "text-workspace": [
    ["What can I do in the Text Workspace?", "Write or paste a draft, inspect word and character counts, apply a text transform, and copy or download the result."],
    ["Will text transforms preserve my formatting?", "Not always. Case and whitespace changes can affect intentional layout. Review the transformed draft before publishing."],
  ],
  "markdown-editor": [
    ["Can Markdown Editor display raw HTML in its preview?", "The preview sanitizes HTML and unsafe links. You can download the Markdown source or the safe HTML output for later review."],
    ["Does this editor support every Markdown extension?", "No. Some extension syntax is outside its supported subset. Check the preview before moving the document into another renderer."],
  ],
  "csv-editor": [
    ["Can CSV Editor open a table with thousands of rows?", "It accepts up to 1,000 data rows and 100 columns. Larger datasets need a spreadsheet or database workflow."],
    ["How does CSV export handle formula-like cells?", "The download neutralizes cells that spreadsheet apps might interpret as formulas. Review exported data in the target app."],
  ],
  "csv-to-pdf": [
    ["Will every CSV column fit on one PDF page?", "Wide tables are split across pages, and long cell values may be shortened. Inspect the exported PDF before printing."],
    ["Can CSV to PDF reproduce formulas or formatting?", "No. It renders a plain table from CSV values. Formulas, spreadsheet styles, and some non-Latin glyphs may not carry over."],
  ],
  "text-summarizer": [
    ["Why does Local Text Summarizer download a model?", "The first run downloads about 100 MB so a small model can process the passage on your device. Later availability depends on browser cache."],
    ["Can I trust the generated summary as a factual source?", "No. The model may omit or change details. Compare names, dates, numbers, and claims with the original passage before sharing."],
  ],
  "sentiment-analysis": [
    ["What does the sentiment confidence percentage mean?", "It is the model's confidence between positive and negative labels, not a measure of customer intent, truth, or business impact."],
    ["Can sentiment analysis understand sarcasm or mixed reviews?", "It may miss sarcasm, context, and mixed opinions. The English model is a quick signal and should be checked against the full text."],
  ],
  "video-call": [
    ["How do two people connect for a video call?", "One browser creates an invitation and the other returns an answer code. Both people keep their pages open during the direct WebRTC call."],
    ["Why can a peer video call fail on some networks?", "A public STUN server helps discover a connection path, but restrictive networks may need a TURN relay that this free tool does not provide."],
  ],
  "file-share": [
    ["Does File Share upload the file to Matrix?", "The file moves directly between connected browsers over an encrypted WebRTC data channel. A public STUN server sees connection metadata."],
    ["What are the size and connection limits for File Share?", "Choose a file up to 20 MB. Both peers need to remain connected until transfer finishes, and restrictive networks may block a direct path."],
  ],
  "whiteboard": [
    ["Will a shared whiteboard remain after the call ends?", "No. The board is temporary and resets when the direct browser connection closes. Save a copy separately if you need a record."],
    ["How does a peer join the whiteboard?", "Exchange invitation and answer codes to establish a WebRTC data channel. Both browsers must stay open while drawing together."],
  ],
  "workflows": [
    ["Can a browser workflow run after I close the tab?", "No. The chain runs in the active tab and stops when that tab closes. It does not schedule background tasks or use a Matrix computer."],
    ["How can I reuse a tool workflow?", "Build a chain of up to ten working text tools, then save its step list as JSON for a later session."],
  ],
};

export const faqBySlug = Object.freeze(Object.fromEntries(Object.entries(authored).map(([slug, pairs]) => [
  slug,
  Object.freeze(pairs.map(([question, answer]) => Object.freeze({ question, answer }))),
])));

/** Unknown routes return no FAQ. New catalog entries get a conservative metadata-based fallback until authored. */
export function getToolFaqs(slug) {
  if (faqBySlug[slug]) return faqBySlug[slug];
  const tool = getTool(slug);
  if (!tool) return [];
  return [
    { question: `What can I do with ${tool.title}?`, answer: tool.description },
    { question: `What should I check before using ${tool.title}?`, answer: tool.limitations },
  ];
}
