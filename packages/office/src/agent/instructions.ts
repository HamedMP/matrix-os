/**
 * The edit format as instructions for a system prompt: `AgentEditInstructions`
 * in `../api/agent.ts`. Plain text, the same for every document.
 */

import type { AgentEditInstructions } from "../api/agent.js";
import { OfficeError } from "../errors.js";
import { MAX_EDITS, MAX_RANGE_CELLS, MAX_STRING_LENGTH, STARTS_WITH_LENGTH } from "./limits.js";

const COMMON = [
  "Answer with one JSON object and nothing else. Do not add properties that are not listed here.",
  `At most ${MAX_EDITS} edits; no string longer than ${MAX_STRING_LENGTH} characters.`,
  "Your edits are proposals: the owner sees each one and accepts or rejects it.",
  'An optional "summary" string says in one sentence what the edits do.',
];

const DOCX = [
  'Format: {"kind":"docx","edits":[…],"summary":"…"}',
  "",
  "The document was given to you one paragraph per line. Each line starts with the block id of the paragraph in square brackets, for example [b12]. A heading shows its style in parentheses, a paragraph in a table shows its row and cell. The id, the style, the table marker and an automatic number in front of the text are not part of the text of the paragraph.",
  "",
  "Edits:",
  '- {"op":"replaceText","blockId":"b12","find":"30 days","replace":"45 days"}',
  '  Replaces text inside one paragraph. "find" is copied exactly from that paragraph and must not be empty; keep it short, but long enough to occur once. When it occurs more than once, add "occurrence" (1 for the first match). An empty "replace" deletes the text.',
  '- {"op":"insertParagraph","blockId":"b12","position":"after","text":"New paragraph."}',
  '  Adds one paragraph after (default) or before a paragraph or table. "headingLevel" from 1 to 9 makes it a heading.',
  '- {"op":"deleteParagraph","blockId":"b12","startsWith":"The first words of the paragraph"}',
  `  Deletes a whole paragraph. "startsWith" is the exact first ${STARTS_WITH_LENGTH} characters of its text, or all of the text when it is shorter.`,
  '- {"op":"comment","blockId":"b12","find":"30 days","text":"Is this period agreed?"}',
  '  Attaches a comment to the quoted text. An empty "find" comments on the whole paragraph.',
  "",
  "Rules:",
  "- Use only block ids you were shown. Quote text exactly as shown, including punctuation and spaces.",
  "- Change as little text as the edit needs. Do not make two edits that change the same words.",
  "- Text of a paragraph that ends in … was cut: quote only what is shown.",
  "",
  "Example:",
  '{"kind":"docx","edits":[{"op":"replaceText","blockId":"b25","find":"24 months","replace":"36 months"},{"op":"comment","blockId":"b31","find":"timely access","text":"Should this name a number of days?"}],"summary":"Extends the term and flags a vague obligation."}',
];

const SHEET = [
  'Format: {"kind":"sheet","edits":[…],"summary":"…"}',
  "",
  'The sheet was given to you one cell per line, for example "B3: =SUM(B1:B2) => 1500": the address, then the formula and its result, or the value as displayed.',
  "",
  "Edits:",
  '- {"op":"setCell","sheet":"Assumptions","cell":"B3","value":0.05,"expect":"3.0%"}',
  '  Sets one cell. "value" is a number, true, false, null (empty) or a string; a string that starts with = is a formula. "expect" is optional: what you saw in the cell (the formula with its = for a formula cell, else the displayed text, an empty string for an empty cell). The edit is refused when the cell holds something else.',
  '- {"op":"setRange","sheet":"Data","start":"A2","values":[["North",1200],["South",950]]}',
  `  Sets a block of cells row by row from its top-left cell; at most ${MAX_RANGE_CELLS} cells.`,
  '- {"op":"clearRange","sheet":"Data","range":"A2:C9"}',
  "  Empties the cells of a range.",
  "",
  "Rules:",
  "- Use the sheet names and A1 addresses you were shown.",
  "- Write numbers as JSON numbers, not as text: 0.05, not \"5%\".",
  "- Write formulas in English function names with commas between arguments.",
  "",
  "Example:",
  '{"kind":"sheet","edits":[{"op":"setCell","sheet":"Summary","cell":"B2","value":"=Projection!N4","expect":"725,000"}],"summary":"Links the total to the projection."}',
];

export const agentEditInstructions: AgentEditInstructions = (kind) => {
  if (kind !== "docx" && kind !== "sheet") throw new OfficeError("invalid_argument", "unknown document kind");
  return [...COMMON, ...(kind === "docx" ? DOCX : SHEET)].join("\n");
};
