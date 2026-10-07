import { createHash } from "node:crypto";
import { JEV_EMAIL_TRIAGE_RECIPE_ID, JevEmailTriageResultSchema, type JevEmailTriageResult, type JevEmailTriageScores } from "@matrix-os/contracts";
import type { JevService } from "../jev/service.js";
import { newsletterPolicy, type NewsletterCategory } from "./policy.js";
export interface ClassificationEvidence {
    subject: string;
    sender: string;
    text: string;
    html: string;
    partial?: boolean;
}
export interface MailClassificationRow {
    result: JevEmailTriageResult;
    verified: boolean;
}
export interface MailClassificationStore {
    get(key: string): Promise<MailClassificationRow | null>;
    /** Idempotent persisted score upsert; must leave manual correction untouched. */
    save(key: string, value: MailClassificationRow): Promise<void>;
}
export function buildMailEvidence(mail: ClassificationEvidence) {
    const content = mail.text || mail.html.replace(/<[^>]*>/g, " ");
    const envelope = { context: "retained-mail", partial: mail.partial === true, truncated: false, subject: mail.subject, sender: mail.sender, body: content };
    let state = JSON.stringify(envelope);
    let verified = !mail.partial && content.trim().length > 0;
    if (Buffer.byteLength(state) > 32768) {
        verified = false;
        envelope.truncated = true;
        // Bound each field by Unicode code point before binary searching the body budget.
        envelope.subject = Array.from(mail.subject).slice(0, 1024).join("");
        envelope.sender = Array.from(mail.sender).slice(0, 512).join("");
        const characters = Array.from(content);
        let low = 0, high = Math.min(characters.length, 32768);
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            envelope.body = characters.slice(0, mid).join("");
            if (Buffer.byteLength(JSON.stringify(envelope)) <= 32768)
                low = mid;
            else
                high = mid - 1;
        }
        envelope.body = characters.slice(0, low).join("");
        state = JSON.stringify(envelope);
    }
    return { state, verified };
}
export async function classifyArchivedMail(options: {
    ownerId: string;
    accountId: string;
    messageId: string;
    contentDigest: string;
    mail: ClassificationEvidence;
    modelPolicy: string;
    store: MailClassificationStore;
    jev: JevService;
    correction?: NewsletterCategory | null;
    signal?: AbortSignal;
}) {
    const evidence = buildMailEvidence(options.mail);
    const key = createHash("sha256").update(JSON.stringify([options.ownerId, options.accountId, options.messageId,
        options.contentDigest, evidence.state, evidence.verified, JEV_EMAIL_TRIAGE_RECIPE_ID, options.modelPolicy])).digest("hex");
    let row = await options.store.get(key);
    if (!row) {
        // The service's durable claim is the authority for unknown, pending, and expired results.
        // Repeating this deterministic key never creates a new paid dispatch for ambiguous outcomes.
        const result = JevEmailTriageResultSchema.parse(await options.jev.evaluate(options.ownerId, { recipe: JEV_EMAIL_TRIAGE_RECIPE_ID, state: evidence.state, idempotencyKey: `mail:${key}` }, options.signal));
        row = { result, verified: evidence.verified };
        await options.store.save(key, row);
    }
    const result = JevEmailTriageResultSchema.parse(row.result);
    const scores = Object.fromEntries(result.answers.map(answer => [answer.id, answer.probability])) as unknown as JevEmailTriageScores;
    return { ...newsletterPolicy(scores, row.verified, options.correction), scores, result, key, verified: row.verified };
}
