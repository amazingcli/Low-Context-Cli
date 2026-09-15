export function buildProjectMap(root, files, modules) {
    const byPath = new Map();
    let verified = 0;
    let symbols = 0;
    for (const file of files) {
        byPath.set(file.path, file);
        if (file.verification_state === 'verified' || file.lines > 0)
            verified += 1;
        symbols += file.symbols.length;
    }
    return {
        root,
        modules: [...modules],
        files: byPath,
        built_at: new Date().toISOString(),
        verified_files: verified,
        total_files: files.length,
        total_symbols: symbols,
    };
}
/** Build a tree of directories under a path, with counts. */
export function buildDirectoryTree(paths) {
    const rootNode = {
        name: '.',
        kind: 'dir',
        children: [],
        file_count: 0,
        symbol_count: 0,
        verification_state: 'indexed',
    };
    const byPath = new Map([['', rootNode]]);
    for (const path of paths) {
        const parts = path.split('/');
        let current = '';
        let node = rootNode;
        for (let i = 0; i < parts.length - 1; i += 1) {
            current = current === '' ? parts[i] : `${current}/${parts[i]}`;
            let child = byPath.get(current);
            if (!child) {
                child = { name: parts[i], kind: 'dir', children: [], file_count: 0, symbol_count: 0, verification_state: 'indexed' };
                node.children.push(child);
                byPath.set(current, child);
            }
            node = child;
        }
        const name = parts[parts.length - 1];
        const leaf = {
            name,
            kind: 'file',
            path,
            children: [],
            file_count: 1,
            symbol_count: 0,
            verification_state: 'indexed',
        };
        node.children.push(leaf);
        // Counts are recomputed from the finished tree below; incremental
        // bookkeeping up the chain would need parent pointers it does not need to pay for.
    }
    recomputeCounts(rootNode);
    return rootNode;
}
function recomputeCounts(node) {
    let files = node.kind === 'file' ? 1 : 0;
    let symbols = node.symbol_count;
    for (const child of node.children) {
        const counts = recomputeCounts(child);
        files += counts.files;
        symbols += counts.symbols;
    }
    node.file_count = files;
    if (node.kind === 'dir')
        node.symbol_count = symbols;
    return { files, symbols };
}
/** Render the map as an indented text tree. */
export function renderTree(node, options = {}, depth = 0, prefix = '') {
    const maxDepth = options.maxDepth ?? 32;
    const lines = [];
    const color = options.colors ?? ((text) => text);
    const children = node.children.slice(0, options.maxFiles ?? Infinity);
    for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        const isLast = i === children.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const indent = prefix + connector;
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        if (depth >= maxDepth && child.children.length > 0) {
            lines.push(`${indent}${color(child.name, 'dir')} … ${child.file_count} files`);
            continue;
        }
        const label = child.kind === 'file'
            ? `${color(child.name, 'file')}${child.verification_state === 'stale' ? color(' ⚠stale', 'stale') : ''}`
            : `${color(child.name, 'dir')} (${child.file_count})`;
        lines.push(`${indent}${label}`);
        if (child.kind === 'dir' && child.children.length > 0) {
            lines.push(renderTree(child, options, depth + 1, childPrefix));
        }
    }
    return lines.join('\n');
}
/** Render the compact whole-project map (§6: Project → Module → Directory → File). */
export function renderProjectMap(map, _options = {}) {
    const lines = [`Project ${map.root}`];
    const byModule = new Map();
    for (const file of map.files.values()) {
        const moduleName = moduleOf(file);
        const list = byModule.get(moduleName) ?? [];
        list.push(file);
        byModule.set(moduleName, list);
    }
    for (const [name, files] of [...byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(` ├── ${name} (${files.length} files)`);
        const dirs = new Map();
        for (const file of files.slice(0, 60)) {
            const parts = file.path.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
            const list = dirs.get(dir) ?? [];
            list.push(file);
            dirs.set(dir, list);
        }
        for (const [dir, dirFiles] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 12)) {
            lines.push(` │    ├── ${dir === '' ? (dirFiles[0]?.path.split('/').pop() ?? '') : dir}`);
        }
    }
    const totals = `Indexed: ${map.total_files} files, ${map.total_symbols} symbols, ${map.verified_files} verified`;
    lines.push(` ${totals}`);
    return lines.join('\n');
}
const CONTAINER_DIRS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'cmd', 'internal', 'pkg']);
function moduleOf(file) {
    const parts = file.path.split('/');
    if (parts.length <= 1)
        return '(root)';
    const first = parts[0];
    return CONTAINER_DIRS.has(first) && parts.length > 2 ? (parts[1] ?? first) : first;
}
/** Render a single file's map entry: purpose + symbols (§6 example). */
export function renderFileMapEntry(file) {
    const lines = [
        `File: ${file.path}`,
        `Language: ${file.language}`,
        `State: ${file.verification_state}${file.stale ? ' (stale — source may differ)' : ''}`,
    ];
    if (file.summary)
        lines.push(`Purpose: ${file.summary}`);
    if (file.symbols.length > 0)
        lines.push(`Symbols: ${file.symbols.join(', ')}`);
    if (file.imports.length > 0)
        lines.push(`Imports: ${file.imports.slice(0, 12).join(', ')}`);
    if (file.depends_on_files && file.depends_on_files.length > 0) {
        lines.push(`Depends on: ${file.depends_on_files.slice(0, 12).join(', ')}`);
    }
    if (file.routes && file.routes.length > 0)
        lines.push(`Routes: ${file.routes.join('; ')}`);
    if (file.tests && file.tests.length > 0)
        lines.push(`Tests: ${file.tests.slice(0, 8).join('; ')}`);
    return lines.join('\n');
}
/** Selectively display one module's tree (§6, §32). */
export function renderModuleMap(map, moduleName, options = {}) {
    const files = [...map.files.values()].filter((f) => moduleOf(f) === moduleName);
    const tree = buildDirectoryTree(files.map((f) => f.path));
    return renderTree(tree, options);
}
//# sourceMappingURL=project-map.js.map