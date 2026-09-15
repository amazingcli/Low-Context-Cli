/**
 * Workspace bootstrap (§26, §43).
 *
 * One function opens a project and hands back every store wired to the right
 * directory. Nothing above this layer knows whether state lives in
 * `<project>/.low-context` or in centralised storage — `projectPaths` decides
 * that, and the stores take a base directory (§26: "allow configuration to
 * disable project-local state").
 *
 * The workspace also owns the lifetime rule: open once, flush once. Retrieval,
 * the agent loop and the CLI all share these store instances, so an index
 * update performed by a tool is immediately visible to the next retrieval
 * without reopening anything.
 */
import { FileProjectStore, projectIdForRoot } from '../storage/project-store.js';
import { FileConversationStore } from '../storage/conversation-store.js';
import { FileMemoryStore } from '../storage/memory-store.js';
import { FileSessionStore } from '../storage/session-store.js';
import { FileTaskStore } from '../storage/task-store.js';
import { FileIndexStore } from '../index/index-store.js';
import { refreshProjectIndex, detectStale } from '../index/indexer.js';
import { projectPaths, findProjectRoot } from '../core/paths.js';
import { ensureDir, nowIso } from '../core/util.js';
export async function openWorkspace(options) {
    const root = options.root
        ? options.root
        : await findProjectRoot(process.cwd());
    const local = options.config.storage.project_local;
    const paths = projectPaths(root, { local });
    await ensureDir(paths.dir);
    const projectStore = new FileProjectStore();
    const projectId = projectIdForRoot(paths.root);
    const existing = await projectStore.findByRoot(paths.root);
    const project = existing ?? {
        id: projectId,
        name: paths.root.split('/').filter((part) => part !== '').pop() ?? paths.root,
        root: paths.root,
        created_at: nowIso(),
        last_opened_at: nowIso(),
    };
    project.last_opened_at = nowIso();
    await projectStore.upsert(project);
    const stores = {
        projects: projectStore,
        conversations: new FileConversationStore({ baseDir: paths.dir }),
        memory: new FileMemoryStore({
            baseDir: paths.dir,
            minImportance: options.config.memory.min_importance,
        }),
        index: new FileIndexStore(paths.dir),
        sessions: new FileSessionStore(paths.dir),
        tasks: new FileTaskStore(paths.dir),
    };
    const artifactsDir = `${paths.dir}/artifacts`;
    const workspace = {
        root: paths.root,
        paths,
        config: options.config,
        project,
        stores,
        artifactsDir,
        async ensureIndex(refreshOptions = {}) {
            if (!options.config.index.enabled)
                return undefined;
            const shouldRun = refreshOptions.force === true || options.refreshIndex === true;
            if (!shouldRun) {
                // Even without a refresh, make sure the store is loaded so reads work.
                await stores.index.loadOrCreate(project.id, paths.root);
                return undefined;
            }
            return refreshProjectIndex({
                root: paths.root,
                projectId: project.id,
                store: stores.index,
                maxFileBytes: options.config.index.max_file_bytes,
                followSymlinks: options.config.index.follow_symlinks,
                extraIgnore: options.config.index.extra_ignore,
                ...(refreshOptions.force === undefined ? {} : { force: refreshOptions.force }),
                ...(refreshOptions.onProgress === undefined ? {} : { onProgress: refreshOptions.onProgress }),
            });
        },
        async stalePaths() {
            if (!options.config.index.enabled)
                return [];
            const files = await stores.index.listFiles(project.id);
            return detectStale(paths.root, files);
        },
        async indexSummary() {
            if (!options.config.index.enabled)
                return undefined;
            const files = await stores.index.listFiles(project.id);
            const modules = await stores.index.listModules(project.id);
            return {
                files: files.length,
                modules: modules.length,
                symbols: files.reduce((sum, file) => sum + file.symbols.length, 0),
            };
        },
        async flush() {
            await Promise.all([
                stores.conversations.flush(),
                stores.memory.flush(),
                stores.index.flush(),
            ]);
        },
    };
    if (options.refreshIndex === true)
        await workspace.ensureIndex({ onProgress: options.onProgress });
    return workspace;
}
/** Project ids are derived from the root path, so they survive a registry wipe. */
export function workspaceProjectId(root) {
    return projectIdForRoot(root);
}
//# sourceMappingURL=workspace.js.map