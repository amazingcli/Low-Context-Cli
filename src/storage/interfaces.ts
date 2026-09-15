/**
 * Storage abstractions (§43).
 *
 * Every store is an interface with one shipped local-first implementation.
 * Nothing above this layer imports a concrete backend, so replacing the file
 * backend with SQLite, or adding a remote memory service, does not require
 * touching retrieval, context building or the agent loop.
 *
 * Two rules are part of the contract, not just convention:
 *  - Records stored here are *external* to the model. They are retrieved, never
 *    "remembered" by a model (§3).
 *  - Every record that can influence behaviour must carry provenance
 *    (`source_refs`) and a confidence/status pair, so callers can distinguish
 *    a verified fact from an old inference (§36).
 */
import type {
  ChatMessage,
  Conversation,
  IndexedFile,
  IndexedModule,
  MemoryRecord,
  MemorySearchQuery,
  ProjectIndex,
  ProjectRecord,
  Session,
  SourceReference,
  TaskState,
} from '../core/types.js';

/* --------------------------------- projects -------------------------------- */

export interface ProjectStore {
  upsert(project: ProjectRecord): Promise<void>;
  get(id: string): Promise<ProjectRecord | undefined>;
  findByRoot(root: string): Promise<ProjectRecord | undefined>;
  list(): Promise<ProjectRecord[]>;
  remove(id: string): Promise<boolean>;
  touch(id: string): Promise<void>;
}

/* ------------------------------- conversations ----------------------------- */

export interface AppendMessageInput {
  role: ChatMessage['role'];
  content: string;
  session_id?: string;
  tool_calls?: ChatMessage['tool_calls'];
  tool_call_id?: string;
  name?: string;
  importance?: ChatMessage['importance'];
  topic?: string;
  summary?: string;
  references?: SourceReference[];
  tokens_estimate?: number;
  synthetic?: boolean;
  id?: string;
  timestamp?: string;
}

export interface ConversationQuery {
  text: string;
  conversation_id?: string;
  session_id?: string;
  project_id?: string;
  roles?: ChatMessage['role'][];
  limit?: number;
  /** Restrict to messages newer than this ISO timestamp. */
  since?: string;
}

export interface ConversationStore {
  create(input?: { project_id?: string; session_id?: string; title?: string }): Promise<Conversation>;
  get(id: string): Promise<Conversation | undefined>;
  list(input?: { project_id?: string; limit?: number }): Promise<Conversation[]>;
  append(conversationId: string, input: AppendMessageInput): Promise<ChatMessage>;
  appendMany(conversationId: string, inputs: AppendMessageInput[]): Promise<ChatMessage[]>;
  messages(conversationId: string, options?: { limit?: number; offset?: number }): Promise<ChatMessage[]>;
  recentMessages(conversationId: string, count: number): Promise<ChatMessage[]>;
  searchMessages(query: ConversationQuery): Promise<{ message: ChatMessage; score: number; reason: string }[]>;
  /** Fetch messages by id, preserving the order given. */
  messagesByIds(ids: readonly string[]): Promise<ChatMessage[]>;
  updateSummary(conversationId: string, summary: string, throughMessageId: string): Promise<void>;
  delete(conversationId: string): Promise<boolean>;
  count(conversationId?: string): Promise<number>;
  /** Remove messages matching a predicate; used by retention policies. */
  retain(conversationId: string, keep: (message: ChatMessage) => boolean): Promise<number>;
  flush(): Promise<void>;
}

/* ---------------------------------- memory --------------------------------- */

export interface MemoryWriteInput {
  type: MemoryRecord['type'];
  scope: MemoryRecord['scope'];
  summary: string;
  detail?: string;
  tags?: string[];
  /**
   * Routes back to the original material (§8). Optional so a caller can record
   * something it genuinely cannot trace, but consumers surface the absence: a
   * memory with no source is reported as unverified rather than silently
   * treated as fact.
   */
  source_refs?: SourceReference[];
  confidence?: MemoryRecord['confidence'];
  importance?: MemoryRecord['importance'];
  verification_state?: MemoryRecord['verification_state'];
  project_id?: string;
  session_id?: string;
  task_id?: string;
  module_path?: string;
  /** When set, the referenced record is marked superseded by the new one. */
  supersedes?: string;
  id?: string;
}

export interface MemoryStore {
  /** Write a record. Returns the stored record (with ids/timestamps filled). */
  write(input: MemoryWriteInput): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  getMany(ids: readonly string[]): Promise<MemoryRecord[]>;
  search(query: MemorySearchQuery): Promise<{ record: MemoryRecord; score: number; reason: string }[]>;
  list(input?: {
    project_id?: string;
    scope?: MemoryRecord['scope'];
    type?: MemoryRecord['type'];
    limit?: number;
    include_superseded?: boolean;
  }): Promise<MemoryRecord[]>;
  update(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord | undefined>;
  /** Mark `oldId` superseded by `newId`, keeping both (§11). */
  supersede(oldId: string, newId: string): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** Delete every record whose summary matches a free-text query. */
  forget(query: MemorySearchQuery & { text: string }): Promise<number>;
  count(input?: { project_id?: string; scope?: MemoryRecord['scope'] }): Promise<number>;
  rebuild(): Promise<{ records: number; duration_ms: number }>;
  export(input?: { project_id?: string }): Promise<MemoryRecord[]>;
  flush(): Promise<void>;
}

/* ----------------------------------- index --------------------------------- */

export interface IndexStore {
  loadOrCreate(projectId: string, root: string): Promise<ProjectIndex>;
  save(index: ProjectIndex): Promise<void>;
  getFile(projectId: string, path: string): Promise<IndexedFile | undefined>;
  getFileById(projectId: string, fileId: string): Promise<IndexedFile | undefined>;
  upsertFile(projectId: string, file: IndexedFile): Promise<void>;
  upsertFiles(projectId: string, files: readonly IndexedFile[]): Promise<void>;
  removeFile(projectId: string, path: string): Promise<boolean>;
  listFiles(projectId: string): Promise<IndexedFile[]>;
  listModules(projectId: string): Promise<IndexedModule[]>;
  upsertModules(projectId: string, modules: readonly IndexedModule[]): Promise<void>;
  /** Files whose recorded hash no longer matches the file on disk. */
  markStale(projectId: string, paths: readonly string[]): Promise<number>;
  searchFiles(projectId: string, text: string, limit?: number): Promise<{ file: IndexedFile; score: number; matched: string[] }[]>;
  findSymbol(projectId: string, name: string, limit?: number): Promise<{ file: IndexedFile; symbol: string; score: number }[]>;
  dropProject(projectId: string): Promise<void>;
  flush(): Promise<void>;
}

/* --------------------------------- sessions -------------------------------- */

export interface SessionStore {
  create(input: {
    project_id?: string;
    project_root?: string;
    conversation_id?: string;
    task_id?: string;
    title?: string;
    provider?: string;
    model?: string;
  }): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  /** Accepts an id or a unique id prefix, so users can type short ids. */
  resolve(idOrPrefix: string): Promise<Session | undefined>;
  list(input?: { project_id?: string; limit?: number; status?: Session['status'] }): Promise<Session[]>;
  update(id: string, patch: Partial<Session>): Promise<Session | undefined>;
  saveTaskState(id: string, state: TaskState): Promise<void>;
  end(id: string): Promise<void>;
  delete(id: string): Promise<boolean>;
  latest(projectId?: string): Promise<Session | undefined>;
}

/* ---------------------------------- vectors -------------------------------- */

export interface VectorRecord {
  id: string;
  vector: Float32Array;
  metadata?: Record<string, string | number | boolean>;
}

export interface VectorMatch {
  id: string;
  score: number;
}

/**
 * Optional embedding client (§42). Retrieval must work without one, so every
 * consumer treats its absence as a normal configuration rather than an error.
 */
export interface EmbeddingClient {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<Float32Array[]>;
}

export interface VectorStore {
  upsert(records: readonly VectorRecord[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  search(vector: Float32Array, limit: number): Promise<VectorMatch[]>;
  has(id: string): Promise<boolean>;
  count(): Promise<number>;
  clear(): Promise<void>;
  flush(): Promise<void>;
}

/* ---------------------------------- tasks ---------------------------------- */

export interface TaskStore {
  create(input: { title: string; goal?: string; project_id?: string; session_id?: string }): Promise<TaskState>;
  upsert(state: TaskState): Promise<void>;
  get(id: string): Promise<TaskState | undefined>;
  active(sessionId: string): Promise<TaskState | undefined>;
  list(input?: { project_id?: string; limit?: number }): Promise<TaskState[]>;
  delete(id: string): Promise<boolean>;
}
