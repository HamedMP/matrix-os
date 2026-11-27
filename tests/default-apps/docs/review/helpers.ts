/**
 * Helpers of the review tests: a session on a real engine document opened
 * from the shared fixtures.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DocxDocument } from "../../../../home/apps/_shared/office-engine/index";
import { createDocx, openDocx } from "../../../../home/apps/_shared/office-engine/index";
import { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { createFakeFiles } from "../session/fakes";

export const OWNER = "Rae Okafor";
export const ALEX = "Alex Morgan";
export const PRIYA = "Priya Shah";
const FIXTURES = path.resolve(__dirname, "../../../office/fixtures");

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

export async function openFixture(name: string): Promise<DocxDocument> {
  return openDocx(fixtureBytes(name));
}

export async function sessionFor(doc: DocxDocument): Promise<DocumentSession> {
  const session = new DocumentSession({
    files: createFakeFiles(),
    author: OWNER,
    autosave: false,
    now: () => new Date("2026-11-23T10:15:42.000Z"),
    log: () => undefined,
  });
  await session.adopt(doc, { name: "Test", dirty: false });
  return session;
}

export async function fixtureSession(name: string): Promise<DocumentSession> {
  return sessionFor(await openFixture(name));
}

export async function plainSession(paragraphs: string[]): Promise<DocumentSession> {
  return sessionFor(createDocx({ paragraphs }));
}

export function finalText(session: DocumentSession): string {
  return session.requireDocument().getPlainText({ view: "final" });
}

export function originalText(session: DocumentSession): string {
  return session.requireDocument().getPlainText({ view: "original" });
}

export function revisionIds(session: DocumentSession): string[] {
  return session.requireDocument().listRevisions().map((revision) => revision.id);
}
