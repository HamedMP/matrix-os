/**
 * A scriptable `MailProvider` for store tests. Each method records its call
 * and answers from a handler the test can replace.
 */
import type {
  Draft,
  ListThreadsRequest,
  MailFolder,
  MailProvider,
  MailThread,
  Page,
  ThreadChange,
  ThreadSummary,
} from "../../../../home/apps/_shared/office-accounts/types/mail";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeProvider implements MailProvider {
  folders: MailFolder[];
  lists: Record<string, ThreadSummary[]> = {};
  threads: Record<string, MailThread> = {};
  searchResults: ThreadSummary[] = [];
  pageSize = 2;
  calls = {
    listThreads: [] as ListThreadsRequest[],
    search: [] as Array<{ query: string; cursor?: string }>,
    modifyThreads: [] as Array<{ ids: string[]; change: ThreadChange }>,
    getThread: [] as string[],
    saveDraft: [] as Draft[],
    sendDraft: [] as string[],
    deleteDraft: [] as string[],
  };
  onListThreads: ((request: ListThreadsRequest) => Promise<Page<ThreadSummary>>) | null = null;
  onModify: ((ids: string[], change: ThreadChange) => Promise<void>) | null = null;
  onGetThread: ((id: string) => Promise<MailThread>) | null = null;
  onSaveDraft: ((draft: Draft) => Promise<Draft>) | null = null;
  onSendDraft: ((id: string) => Promise<void>) | null = null;
  private draftCounter = 0;

  constructor(folders: MailFolder[]) {
    this.folders = folders;
  }

  async listFolders(): Promise<MailFolder[]> {
    return this.folders;
  }

  async listThreads(request: ListThreadsRequest): Promise<Page<ThreadSummary>> {
    this.calls.listThreads.push(request);
    if (this.onListThreads) return this.onListThreads(request);
    const all = this.lists[request.folderId] ?? [];
    const start = request.cursor ? Number(request.cursor) : 0;
    const end = start + this.pageSize;
    return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
  }

  async getThread(id: string): Promise<MailThread> {
    this.calls.getThread.push(id);
    if (this.onGetThread) return this.onGetThread(id);
    const thread = this.threads[id];
    if (!thread) throw new Error(`no thread ${id} at /internal/path`);
    return thread;
  }

  async search(query: string, cursor?: string): Promise<Page<ThreadSummary>> {
    this.calls.search.push({ query, cursor });
    return { items: this.searchResults, nextCursor: null };
  }

  async modifyThreads(ids: string[], change: ThreadChange): Promise<void> {
    this.calls.modifyThreads.push({ ids, change });
    if (this.onModify) return this.onModify(ids, change);
  }

  async saveDraft(draft: Draft): Promise<Draft> {
    this.calls.saveDraft.push(structuredClone(draft));
    if (this.onSaveDraft) return this.onSaveDraft(draft);
    return { ...draft, id: draft.id ?? `draft-${++this.draftCounter}` };
  }

  async deleteDraft(id: string): Promise<void> {
    this.calls.deleteDraft.push(id);
  }

  async sendDraft(id: string): Promise<void> {
    this.calls.sendDraft.push(id);
    if (this.onSendDraft) return this.onSendDraft(id);
  }

  async getAttachment(): Promise<never> {
    throw new Error("not used");
  }

  async listSentTo(): Promise<never[]> {
    return [];
  }
}
