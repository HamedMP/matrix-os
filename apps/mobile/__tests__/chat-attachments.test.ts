import { CanonicalCreateChatTurnRequestSchema } from "@matrix-os/contracts";

import {
  MAX_ATTACHMENT_DRAFTS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_SENT_ATTACHMENT_URIS,
  appendAttachments,
  attachmentIdFrom,
  attachmentKindForMimeType,
  attachmentName,
  attachmentsTitle,
  chatAttachmentPart,
  chatAttachmentUploadPath,
  moveAttachmentDraft,
  readAttachmentDraft,
  rejectionNotice,
  rememberSentAttachments,
  sameAttachments,
  supportedAttachmentKinds,
  unreadableAttachments,
  unreadableNotice,
  writeAttachmentDraft,
  type ComposerAttachment,
} from "../lib/chat-attachments";

import { GPT, SONNET, catalogOf, codexInstance, engineInstance, matrixInstance } from "./model-test-catalog";

/** The id made for a test attachment: its short name, spelled in hex and padded. */
function idOf(name: string): string {
  const hex = Array.from(name, (letter) => letter.charCodeAt(0).toString(16)).join("");
  return `att_${hex.padEnd(32, "0").slice(0, 32)}`;
}

const A1 = idOf("a1");

function photo(id: string, overrides: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: idOf(id),
    uri: `file:///cache/${id}.jpg`,
    name: `${id}.jpg`,
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 1_024,
    ...overrides,
  };
}

function withSupport(attachments: ("file" | "image" | "structured_ref")[]) {
  const base = codexInstance();
  return { ...base, supports: { ...base.supports, attachments } };
}

describe("chat attachments", () => {
  it("calls anything with an image type a photo and everything else a file", () => {
    expect(attachmentKindForMimeType("image/png")).toBe("image");
    expect(attachmentKindForMimeType("IMAGE/HEIC")).toBe("image");
    expect(attachmentKindForMimeType("application/pdf")).toBe("file");
    expect(attachmentKindForMimeType("text/plain")).toBe("file");
  });

  it("spells an attachment's id from its random bytes", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index * 16 + 1);

    expect(attachmentIdFrom(bytes)).toBe("att_01112131415161718191a1b1c1d1e1f1");
    expect(chatAttachmentUploadPath({ id: attachmentIdFrom(bytes), name: "a.jpg" })).not.toBeNull();
  });

  describe("the name a picture is sent under", () => {
    it.each([
      ["IMG_0001.jpg", "image/jpeg"],
      ["IMG_0001.JPEG", "image/jpeg"],
      ["Screenshot.png", "IMAGE/PNG"],
      ["sticker.webp", "image/webp"],
      ["loop.gif", "image/gif"],
    ])("is %j as it is, ending like its type %s", (name, mimeType) => {
      expect(attachmentName(name, mimeType)).toBe(name);
    });

    it.each([
      ["IMG_0001", "image/jpeg", "IMG_0001.jpg"],
      ["1000012345", "image/png", "1000012345.png"],
      ["sticker", "image/webp", "sticker.webp"],
      ["loop", "IMAGE/GIF", "loop.gif"],
      // An ending that is not the type's own says nothing the computer can use.
      ["IMG_0002.HEIC", "image/jpeg", "IMG_0002.HEIC.jpg"],
      ["Screenshot 2026.10.12", "image/png", "Screenshot 2026.10.12.png"],
    ])("gives %j of type %s the ending of its type", (name, mimeType, expected) => {
      expect(attachmentName(name, mimeType)).toBe(expected);
    });

    it("leaves a file, and a picture of a type the app does not show, as it is named", () => {
      expect(attachmentName("notes", "text/plain")).toBe("notes");
      expect(attachmentName("scan", "image/tiff")).toBe("scan");
      expect(attachmentName("drawing", "image/svg+xml")).toBe("drawing");
    });
  });

  describe("upload place", () => {
    it("is in the folder the computer clears, named by the attachment's id and a safe file name", () => {
      expect(chatAttachmentUploadPath(photo("a1", { name: "Holiday photo (1).jpg" })))
        .toBe(`temporary/desktop-chat/${A1}-Holiday_photo__1_.jpg`);
    });

    it("is the same each time for the same attachment", () => {
      const attachment = photo("a1");
      expect(chatAttachmentUploadPath(attachment)).toBe(chatAttachmentUploadPath({ ...attachment }));
    });

    it.each([
      ["../../etc/passwd", `temporary/desktop-chat/${A1}-.._.._etc_passwd`],
      ["..", `temporary/desktop-chat/${A1}-attachment`],
      ["\u0000\u001f", `temporary/desktop-chat/${A1}-attachment`],
      ["a/b\\c.png", `temporary/desktop-chat/${A1}-a_b_c.png`],
    ])("keeps the name %j inside the folder", (name, expected) => {
      expect(chatAttachmentUploadPath(photo("a1", { name }))).toBe(expected);
    });

    it("keeps the ending of a name too long to keep whole", () => {
      const name = `${"a".repeat(200)}.png`;

      const place = chatAttachmentUploadPath(photo("a1", { name }));

      expect(place).toBe(`temporary/desktop-chat/${A1}-${"a".repeat(116)}.png`);
      expect(chatAttachmentPart(photo("a1", { name, mimeType: "image/png" }))).toMatchObject({
        label: `${"a".repeat(116)}.png`,
        ownerReference: place,
      });
    });

    it("has no place for an attachment whose id is not one this app made", () => {
      expect(chatAttachmentUploadPath(photo("a1", { id: "../escape" }))).toBeNull();
      expect(chatAttachmentUploadPath(photo("a1", { id: "att_a/b" }))).toBeNull();
    });
  });

  describe("message part", () => {
    it("names the upload the way a turn request accepts", () => {
      const part = chatAttachmentPart(photo("a1", { name: "Receipt.jpg", sizeBytes: 2_048 }));

      expect(part).toEqual({
        type: "attachment_reference",
        attachmentId: `mobile_upload_${A1}`,
        kind: "image",
        label: "Receipt.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 2_048,
        ownerReference: `temporary/desktop-chat/${A1}-Receipt.jpg`,
      });
      expect(CanonicalCreateChatTurnRequestSchema.safeParse({
        clientRequestId: "req_1",
        baseRevision: 0,
        parts: [part],
        selection: GPT,
        interactionMode: "default",
        permissionMode: "supervised",
      }).success).toBe(true);
    });

    it("swaps a file name the computer would refuse as a label for a plain one with the same ending", () => {
      // "sk-" followed by letters reads as a secret to the label check.
      expect(chatAttachmentPart(photo("a1", { name: "task-list.png" }))?.label).toBe("Photo.png");
      expect(chatAttachmentPart(photo("a1", {
        name: "risk-report.pdf", mimeType: "application/pdf", kind: "file",
      }))).toMatchObject({ label: "File.pdf", kind: "file", ownerReference: `temporary/desktop-chat/${A1}-risk-report.pdf` });
    });

    it("is not made for an attachment the computer could not accept at all", () => {
      expect(chatAttachmentPart(photo("a1", { mimeType: "not a type" }))).toBeNull();
      expect(chatAttachmentPart(photo("a1", { sizeBytes: 50 * 1024 * 1024 }))).toBeNull();
      expect(chatAttachmentPart(photo("a1", { id: "nope" }))).toBeNull();
    });
  });

  describe("what the model reads", () => {
    it("is photos and files for an engine that takes both", () => {
      expect(supportedAttachmentKinds(catalogOf(withSupport(["file", "image", "structured_ref"])), GPT))
        .toEqual(["image", "file"]);
    });

    it("is files alone for an engine that takes no photos", () => {
      expect(supportedAttachmentKinds(catalogOf(withSupport(["file", "structured_ref"])), GPT)).toEqual(["file"]);
    });

    it("is nothing for an engine that takes no attachments, or one that is not in the catalog", () => {
      expect(supportedAttachmentKinds(catalogOf(withSupport([])), GPT)).toEqual([]);
      expect(supportedAttachmentKinds(catalogOf(matrixInstance()), GPT)).toEqual([]);
      expect(supportedAttachmentKinds(null, GPT)).toEqual([]);
      expect(supportedAttachmentKinds(catalogOf(withSupport(["file", "image"])), null)).toEqual([]);
    });

    it("is nothing while the engine cannot run", () => {
      const unavailable = engineInstance(SONNET.instanceId, "claude_code", "Claude Code", [[SONNET.model, "Sonnet 5"]], {
        availability: "unavailable",
      });
      expect(supportedAttachmentKinds(catalogOf(unavailable), SONNET)).toEqual([]);
    });
  });

  it("compares lists by which attachments they hold and in what order", () => {
    expect(sameAttachments([photo("a"), photo("b")], [photo("a"), photo("b")])).toBe(true);
    expect(sameAttachments([photo("a"), photo("b")], [photo("b"), photo("a")])).toBe(false);
    expect(sameAttachments([photo("a")], [photo("a"), photo("b")])).toBe(false);
    expect(sameAttachments([], [])).toBe(true);
  });

  it("adds attachments once each, up to what a message carries", () => {
    expect(appendAttachments([photo("a")], [photo("a"), photo("b")]).map((item) => item.name)).toEqual(["a.jpg", "b.jpg"]);

    const many = Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 3 }, (_, index) => photo(`n${index}`));
    expect(appendAttachments([], many)).toHaveLength(MAX_MESSAGE_ATTACHMENTS);
    expect(appendAttachments(many.slice(0, 7), many.slice(7)).at(-1)?.name).toBe("n7.jpg");
  });

  it("adds up to a lower limit when asked, without dropping what is already there", () => {
    const waiting = [photo("a"), photo("b"), photo("c")];

    expect(appendAttachments(waiting, [photo("d"), photo("e")], 4).map((item) => item.name))
      .toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
    // Already over the limit: nothing is added and nothing is lost.
    expect(appendAttachments(waiting, [photo("d")], 2).map((item) => item.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    // One that is already there takes no room from the next.
    expect(appendAttachments(waiting, [photo("a"), photo("d")], 4).map((item) => item.name))
      .toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
  });

  describe("attachments the selected model does not read", () => {
    const notes = photo("n", { kind: "file", mimeType: "text/plain", name: "n.txt" });

    it("are those of a kind it does not take", () => {
      expect(unreadableAttachments([photo("a"), notes], ["file"]).map((item) => item.name)).toEqual(["a.jpg"]);
      expect(unreadableAttachments([photo("a"), notes], []).map((item) => item.name)).toEqual(["a.jpg", "n.txt"]);
      expect(unreadableAttachments([photo("a"), notes], ["image", "file"])).toEqual([]);
      expect(unreadableAttachments([], [])).toEqual([]);
    });

    it("are named by kind, with what can be done about them", () => {
      expect(unreadableNotice([])).toBeNull();
      expect(unreadableNotice([photo("a")]))
        .toBe("The selected model cannot read photos. Remove it or choose another model.");
      expect(unreadableNotice([notes, notes]))
        .toBe("The selected model cannot read files. Remove them or choose another model.");
      expect(unreadableNotice([photo("a"), notes]))
        .toBe("The selected model cannot read these attachments. Remove them or choose another model.");
    });
  });

  it("titles a chat that starts with attachments and no text", () => {
    const file = photo("f", { kind: "file", mimeType: "application/pdf", name: "f.pdf" });
    expect(attachmentsTitle([photo("a")])).toBe("Photo");
    expect(attachmentsTitle([photo("a"), photo("b")])).toBe("2 photos");
    expect(attachmentsTitle([file])).toBe("File");
    expect(attachmentsTitle([photo("a"), file])).toBe("2 files");
  });

  it("says what was left out and why, each reason once", () => {
    expect(rejectionNotice([])).toBeNull();
    expect(rejectionNotice(["too_large"])).toBe("1 item is larger than 5 MB.");
    expect(rejectionNotice(["too_large", "unreadable", "too_large", "over_limit", "over_limit"]))
      .toBe("2 items are larger than 5 MB. 1 item could not be read. A message carries up to 8 attachments.");
    expect(rejectionNotice(["unsupported", "unsupported"])).toBe("This model cannot read 2 of the items.");
  });

  describe("waiting attachments", () => {
    it("are kept per chat", () => {
      const drafts = writeAttachmentDraft(writeAttachmentDraft({}, "chat:a", [photo("a")]), "new", [photo("b")]);

      expect(readAttachmentDraft(drafts, "chat:a").map((item) => item.name)).toEqual(["a.jpg"]);
      expect(readAttachmentDraft(drafts, "new").map((item) => item.name)).toEqual(["b.jpg"]);
      expect(readAttachmentDraft(drafts, "chat:other")).toEqual([]);
    });

    it("forget a chat whose attachments are all removed, and stay as they were when it had none", () => {
      const drafts = writeAttachmentDraft({}, "chat:a", [photo("a")]);
      expect(writeAttachmentDraft(drafts, "chat:a", [])).toEqual({});
      expect(writeAttachmentDraft(drafts, "chat:b", [])).toBe(drafts);
    });

    it("drop the chat written longest ago past the cap", () => {
      let drafts = {};
      for (let index = 0; index <= MAX_ATTACHMENT_DRAFTS; index += 1) {
        drafts = writeAttachmentDraft(drafts, `chat:${index}`, [photo(`p${index}`)]);
      }
      expect(Object.keys(drafts)).toHaveLength(MAX_ATTACHMENT_DRAFTS);
      expect(drafts).not.toHaveProperty("chat:0");
      expect(drafts).toHaveProperty(`chat:${MAX_ATTACHMENT_DRAFTS}`);
    });

    it("move to the chat created for them, after any that chat already has", () => {
      const drafts = writeAttachmentDraft(writeAttachmentDraft({}, "new", [photo("b")]), "chat:new", [photo("a")]);

      const moved = moveAttachmentDraft(drafts, "new", "chat:new");
      expect(moved).not.toHaveProperty("new");
      expect(readAttachmentDraft(moved, "chat:new").map((item) => item.name)).toEqual(["a.jpg", "b.jpg"]);
      expect(moveAttachmentDraft({}, "new", "chat:new")).toEqual({});
    });
  });

  describe("sent attachments still on the phone", () => {
    it("are found by their place on the computer", () => {
      const sent = rememberSentAttachments({}, [photo("a1")]);
      expect(sent).toEqual({ [`temporary/desktop-chat/${A1}-a1.jpg`]: "file:///cache/a1.jpg" });
      expect(rememberSentAttachments(sent, [])).toBe(sent);
    });

    it("forget the oldest past the cap", () => {
      let sent = {};
      for (let index = 0; index <= MAX_SENT_ATTACHMENT_URIS; index += 1) {
        sent = rememberSentAttachments(sent, [photo(`s${String(index).padStart(3, "0")}`)]);
      }
      expect(Object.keys(sent)).toHaveLength(MAX_SENT_ATTACHMENT_URIS);
      // By key: a path with dots in it is not one property name to `toHaveProperty`.
      expect(Object.keys(sent)).not.toContain(`temporary/desktop-chat/${idOf("s000")}-s000.jpg`);
      expect(Object.keys(sent)).toContain(`temporary/desktop-chat/${idOf("s001")}-s001.jpg`);
    });
  });
});
