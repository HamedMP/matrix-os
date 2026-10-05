import { createHash } from "node:crypto";
import { extname } from "node:path";
import {
  MemoryImportBatchSchema,
  type MemoryImportBatch,
  type MemoryImportRecord,
} from "../../shared/memory-import-ipc";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const unescapeIcs = (s: string) =>
  s.replace(/\\[nN]/g, "\n").replace(/\\([,;\\])/g, "$1");
export function parseMemoryExport(
  name: string,
  content: string,
  sourceIdentity = name,
): MemoryImportBatch {
  if (
    Buffer.byteLength(content) > 2 * 1024 * 1024 ||
    content.includes("\u0000")
  )
    throw Error("Export too large or invalid");
  const extension = extname(name).toLowerCase();
  let batch: MemoryImportBatch;
  if (extension === ".json") {
    const parsed: unknown = JSON.parse(content);
    batch = MemoryImportBatchSchema.parse(
      Array.isArray(parsed)
        ? { records: parsed, warnings: [] }
        : typeof parsed === "object" && parsed !== null
          ? {
              ...parsed,
              warnings:
                (
                  parsed as {
                    warnings?: unknown;
                  }
                ).warnings ?? [],
            }
          : parsed,
    );
  } else if (extension === ".md" || extension === ".txt") {
    batch = {
      records: [
        {
          externalId: `export:${hash(sourceIdentity)}`,
          title: name.slice(0, 256),
          content,
          kind: "document",
          collection: "File imports",
        },
      ],
      warnings: [],
    };
  } else if (extension === ".ics") batch = parseIcs(content, sourceIdentity);
  else if (extension === ".eml") batch = parseEml(content);
  else throw Error("Unsupported export");
  return MemoryImportBatchSchema.parse(batch);
}
function parseIcs(content: string, sourceIdentity: string): MemoryImportBatch {
  const lines = content
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  // X-WR-RELCALID is calendar identity, not a mutable display name. Only
  // accept it at VCALENDAR scope, never from an event or nested component.
  let depth = 0;
  let calendarId: string | undefined;
  for (const line of lines) {
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:")) depth--;
    else if (depth === 1 && line.startsWith("X-WR-RELCALID:")) {
      const id = line.slice("X-WR-RELCALID:".length).trim();
      if (id) {
        if (calendarId && calendarId !== id) throw Error("Conflicting calendar identities");
        calendarId = id;
      }
    }
  }
  const namespace = calendarId ? `calendar-id:${calendarId}` : sourceIdentity;
  const records: MemoryImportRecord[] = [];
  let fields: Record<
    string,
    {
      value: string;
      params: string;
    }
  > | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      if (fields) throw Error("Nested event");
      fields = Object.create(null) as Record<
        string,
        {
          value: string;
          params: string;
        }
      >;
    } else if (line === "END:VEVENT") {
      if (!fields?.UID || !fields.DTSTART) throw Error("Invalid event");
      const start = fields.DTSTART;
      const tz = start.params.match(/(?:^|;)TZID=([^;]+)/)?.[1];
      const metadata: Record<string, string> = { start: start.value };
      if (tz) metadata.timeZone = tz;
      const recurrence = fields["RECURRENCE-ID"];
      if (recurrence) {
        metadata.recurrenceId = recurrence.value;
        const recurrenceTz = recurrence.params.match(/(?:^|;)TZID=([^;]+)/)?.[1];
        if (recurrenceTz) metadata.recurrenceTimeZone = recurrenceTz;
      }
      if (fields.DTEND) metadata.end = fields.DTEND.value;
      if (fields.RRULE) metadata.recurrence = fields.RRULE.value;
      if (fields.EXDATE) metadata.excludedDates = fields.EXDATE.value;
      const eventIdentity = JSON.stringify([
        fields.UID.value, recurrence?.params ?? "", recurrence?.value ?? "",
      ]);
      records.push({
        externalId: `calendar:export:${hash(namespace)}:${hash(eventIdentity)}`,
        title: unescapeIcs(fields.SUMMARY?.value ?? "Calendar event"),
        content: [
          fields.SUMMARY?.value ?? "Calendar event",
          start.value,
          fields.LOCATION?.value ?? "",
          fields.DESCRIPTION?.value ?? "",
        ]
          .map(unescapeIcs)
          .filter(Boolean)
          .join("\n"),
        kind: "calendar",
        collection: "Calendar export",
        metadata,
      });
      fields = null;
      if (records.length > 100) throw Error("Too many events");
    } else if (fields) {
      const match = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
      if (match) {
        const [, key, params, value] = match;
        if (
          key &&
          params !== undefined &&
          value !== undefined &&
          [
            "UID",
            "RECURRENCE-ID",
            "SUMMARY",
            "DTSTART",
            "DTEND",
            "LOCATION",
            "DESCRIPTION",
            "RRULE",
            "EXDATE",
          ].includes(key)
        )
          fields[key] = { value, params };
      }
    }
  }
  if (fields || !records.length) throw Error("Invalid calendar");
  return {
    records,
    warnings: [
      "Recurring events are imported as definitions; individual occurrences are not expanded. Calendar alarms and attachments are omitted.",
      ...(!calendarId ? ["This export has no stable calendar identifier. Importing it from another path creates separate sources; reuse the same file path for updates."] : []),
    ],
  };
}
function parseEml(content: string): MemoryImportBatch {
  const split = content.search(/\r?\n\r?\n/);
  if (split < 0) throw Error("Missing email headers");
  const headerText = content.slice(0, split).replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const line of headerText.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) {
      const [, key, value] = m;
      if (key && value !== undefined) headers[key.toLowerCase()] = value;
    }
  }
  if (
    headers["content-type"] &&
    !/^text\/plain(?:;|$)/i.test(headers["content-type"])
  )
    throw Error("Only plain text email exports supported");
  const charset = headers["content-type"]?.match(
    /charset=["']?([^;"'\s]+)/i,
  )?.[1];
  if (charset && !/^(utf-8|us-ascii)$/i.test(charset))
    throw Error("Unsupported email encoding");
  let body = content.slice(split).replace(/^\r?\n\r?\n/, "");
  const encoding = headers["content-transfer-encoding"]?.toLowerCase();
  if (encoding === "base64") {
    if (!/^[A-Za-z0-9+/=\s]*$/.test(body)) throw Error("Invalid base64");
    body = Buffer.from(body, "base64").toString("utf8");
  } else if (encoding === "quoted-printable")
    body = Buffer.from(
      body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9a-f]{2})/gi, (_, n: string) =>
          String.fromCharCode(parseInt(n, 16)),
        ),
      "latin1",
    ).toString("utf8");
  else if (encoding && !/^(7bit|8bit|binary)$/.test(encoding))
    throw Error("Unsupported email encoding");
  const date = Date.parse(headers.date ?? "");
  return {
    records: [
      {
        externalId: `email:${headers["message-id"] ?? hash(content)}`,
        title: headers.subject ?? "Email export",
        content: body,
        kind: "email",
        collection: "Email export",
        ...(Number.isFinite(date)
          ? { occurredAt: new Date(date).toISOString() }
          : {}),
        metadata: { sender: headers.from ?? "", recipient: headers.to ?? "" },
      },
    ],
    warnings: [
      "Only the plain text message is imported. Attachments are omitted; multipart exports need a normalized JSON export.",
    ],
  };
}
