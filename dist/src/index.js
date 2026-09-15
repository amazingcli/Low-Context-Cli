/**
 * Public API (§71).
 *
 * The CLI is one consumer of these modules; everything below is importable so
 * Low Context can be embedded in another tool, a test harness or a future
 * server without redesigning the architecture. Nothing here re-exports the CLI
 * command table, because that is presentation, not capability.
 */
export { main } from './cli/index.js';
/* core */
export * from './core/types.js';
export { newId, stableId, isIdOf } from './core/ids.js';
export { LowContextError, isLowContextError, describeError } from './core/errors.js';
export { defaultConfig, loadConfig, saveGlobalConfig, defaultProviders, validateConfig, requireActiveModel, } from './core/config.js';
export { globalPaths, projectPaths, findProjectRoot } from './core/paths.js';
export { Logger, AgentEventLog, listLogFiles, readLogTail, pruneLogs } from './core/logger.js';
export { FileProjectStore } from './storage/project-store.js';
export { FileConversationStore } from './storage/conversation-store.js';
export { FileMemoryStore } from './storage/memory-store.js';
export { FileSessionStore } from './storage/session-store.js';
export { FileTaskStore } from './storage/task-store.js';
export { LocalVectorStore } from './storage/vector-store.js';
export { HashingEmbedder } from './storage/embedder.js';
/* index */
export { FileIndexStore } from './index/index-store.js';
export { refreshProjectIndex, buildModules, detectStale } from './index/indexer.js';
export { buildProjectMap, renderProjectMap, renderFileMapEntry } from './index/project-map.js';
/* search + retrieval */
export { InvertedIndex } from './search/bm25.js';
export { tokenize, analyzeQuery } from './search/tokenize.js';
export { rankCandidates, scoreCandidate, dedupe } from './search/rank.js';
export { understandQuery } from './retrieval/intent.js';
export { runRetrieval, candidatesToContextItems } from './retrieval/engine.js';
/* context */
export { ContextBuilder, renderBudgetLine } from './context/builder.js';
export { estimateTokens, formatTokens } from './context/estimator.js';
export { compactMessages, extractiveSummarize, shouldCompact } from './context/compactor.js';
/* memory */
export { candidatesFromUserMessage, candidateFromExplicitRemember, extractFromEvents, correctionWrite, parseMemoryControl, } from './memory/engine.js';
export { createProvider, createEmbeddingClient, listAllModels, modelDescriptor } from './providers/registry.js';
/* tools */
export { ToolRegistry, defaultTools, registryFromConfig } from './tools/registry.js';
export { PermissionEngine, commandRisk, isReadOnlyCommand } from './tools/permissions.js';
export { OutputManager } from './tools/output.js';
/* security */
export { redact, redactString, containsSecret, buildChildEnv } from './security/redact.js';
export { scanForInjection, frameUntrusted, sanitizeRetrievedText } from './security/injection.js';
export { guardOutbound } from './security/guards.js';
export { resolveSecret, setCredential, maskSecret } from './security/secrets.js';
/* agent */
export { Agent } from './agent/loop.js';
export { openWorkspace } from './agent/workspace.js';
export { buildSystemPrompt } from './agent/system-prompt.js';
export { verifyAfterAction } from './agent/verify.js';
/* git */
export * as git from './git/git.js';
//# sourceMappingURL=index.js.map