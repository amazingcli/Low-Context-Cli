/**
 * Source analysis (§17).
 *
 * This is *best-effort static analysis*. It uses per-language lexical scanners
 * rather than full parsers, because Low Context must index projects with zero
 * native dependencies and no network. The output is `indexed`/`inferred`
 * metadata — never a substitute for reading the source (§16, §51). Symbols and
 * imports are kept intentionally conservative: a miss is harmless (retrieval
 * falls back to lexical search), a false hit misleads navigation.
 */
import type { SymbolKind } from '../core/types.js';

export interface DetectedSymbol {
  name: string;
  kind: SymbolKind;
  line_start: number;
  line_end: number;
  signature?: string;
  exported: boolean;
}

export interface DetectedImport {
  /** Raw module specifier, e.g. `./auth/service`, `react`, `github.com/x/y`. */
  specifier: string;
  /** True for relative or absolute filesystem imports. */
  relative: boolean;
  /** Imported local names (for ts/js/python). */
  names: string[];
}

export interface DetectedRoute {
  method: string;
  path: string;
  line: number;
}

export interface FileAnalysis {
  language: string | undefined;
  symbols: DetectedSymbol[];
  imports: DetectedImport[];
  routes: DetectedRoute[];
  /** Symbols that look like tests (function/class/testcase names). */
  tests: string[];
  summary?: string;
}

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java', kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql',
  vue: 'vue',
  svelte: 'svelte',
  html: 'html',
  css: 'css', scss: 'scss',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  md: 'markdown', markdown: 'markdown',
  txt: 'text',
  proto: 'protobuf',
  graphql: 'graphql', gql: 'graphql',
  dockerfile: 'docker',
  tf: 'terraform',
  xml: 'xml', svg: 'xml',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  scala: 'scala',
  swift: 'swift',
};

export function detectLanguage(path: string): string | undefined {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'dockerfile') return 'docker';
  if (base === 'makefile') return 'make';
  if (base === 'justfile') return 'make';
  if (/^\.env/.test(base)) return 'dotenv';
  const dot = base.lastIndexOf('.');
  if (dot === -1) return undefined;
  const ext = base.slice(dot + 1);
  return EXTENSIONS[ext];
}

export function isBinaryishExtension(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const binaryish = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tar',
    'wasm', 'class', 'jar', 'so', 'dll', 'dylib', 'exe', 'bin', 'woff', 'woff2',
    'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'webm', 'ogg', 'wav', 'lockb',
    'pyc', 'pyd', 'o', 'a', 'rlib', 'pyo', 'whl', 'mod', 'sum',
  ]);
  return binaryish.has(ext);
}

const MAX_SCAN_LINES = 4_000;

/* ------------------------------- extractors ------------------------------- */

function isExportPrefix(code: string, index: number): boolean {
  // Cheap: does the word "export" (or "pub"/"public") precede the declaration?
  const before = code.slice(Math.max(0, index - 24), index);
  return /\b(export|pub|public)\s*(default\s+)?$/.test(before);
}

function extractTypeScript(text: string): FileAnalysis {
  const symbols: DetectedSymbol[] = [];
  const imports: DetectedImport[] = [];
  const routes: DetectedRoute[] = [];
  const tests: string[] = [];

  const push = (symbol: DetectedSymbol): void => {
    // Navigation value comes from precision: a repeated name is recorded once,
    // at its first definition.
    if (symbols.some((existing) => existing.name === symbol.name)) return;
    symbols.push(symbol);
  };

  // Declarations with an explicit keyword. `function`/`class` may be nested and
  // are still worth navigating to; `interface`/`type`/`enum` are effectively
  // always module-level, so indentation does not matter for them.
  const declRe =
    /^(\s*)(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const match of text.matchAll(declRe)) {
    const indent = (match[1] ?? '').length;
    const exported = match[2] !== undefined;
    const keyword = match[3] as string;
    if (!exported && indent > 2 && keyword !== 'function' && keyword !== 'class') continue;
    const name = match[4] as string;
    const offset = match.index ?? 0;
    const line = lineOf(text, offset);
    push({
      name,
      kind: keyword as SymbolKind,
      line_start: line,
      line_end: findBlockEnd(text, offset, line),
      exported: exported || isExportPrefix(text, offset),
      signature: grabSignature(text, offset, line),
    });
  }

  // Module-scope `const`/`let`/`var`. Anything declared inside a function body
  // is a local implementation detail, and listing those is what makes an index
  // useless to navigate (§5: the index must be a map, not a heap).
  const varRe = /^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=\n]+)?=/gm;
  for (const match of text.matchAll(varRe)) {
    const exported = match[1] !== undefined;
    const name = match[2] as string;
    const offset = match.index ?? 0;
    const after = text.slice(offset, offset + 160);
    const isFunction = /=>|\bfunction\b/.test(after);
    const isClass = /\bclass\b/.test(after);
    const kind: SymbolKind = isFunction ? 'function' : isClass ? 'class' : name === name.toUpperCase() && /[A-Z]/.test(name) ? 'constant' : 'variable';
    push({
      name,
      kind,
      line_start: lineOf(text, offset),
      line_end: findBlockEnd(text, offset, lineOf(text, offset)),
      exported,
      ...(isFunction ? { signature: grabSignature(text, offset, lineOf(text, offset)) } : {}),
    });
  }

  const importRe = /^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const match of text.matchAll(importRe)) {
    const specifier = match[1] as string;
    imports.push({ specifier, relative: isRelativeImport(specifier), names: extractImportNames(match[0]) });
  }
  const requireRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(requireRe)) {
    const specifier = match[1] as string;
    if (!imports.some((i) => i.specifier === specifier)) {
      imports.push({ specifier, relative: isRelativeImport(specifier), names: [] });
    }
  }

  // Framework route decorators/annotations.
  const routeRe = /(?:@(?:Get|Post|Put|Patch|Delete|Options|All)\(['"])([^'"]+)(?:['"]\))|(?:router\.(get|post|put|patch|delete)\(\s*['"])([^'"]+)(?:['"])/gi;
  for (const match of text.matchAll(routeRe)) {
    if (match[1]) {
      routes.push({ method: 'HTTP', path: match[1], line: lineOf(text, match.index ?? 0) });
    } else if (match[3] && match[2]) {
      routes.push({ method: match[2].toUpperCase(), path: match[3], line: lineOf(text, match.index ?? 0) });
    }
  }

  // Word boundaries matter here: without them `split('\n')` reads as a test.
  const testRe = /\b(?:it|test|describe)\s*\(\s*['"]([^'"]{2,120})['"]/g;
  for (const match of text.matchAll(testRe)) tests.push(match[1] as string);

  return {
    language: 'typescript',
    symbols,
    imports,
    routes,
    tests,
    summary: deriveSummary(text),
  };
}

function extractPython(text: string): FileAnalysis {
  const symbols: DetectedSymbol[] = [];
  const imports: DetectedImport[] = [];
  const tests: string[] = [];

  const defRe = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  for (const match of text.matchAll(defRe)) {
    const indent = (match[1] ?? '').length;
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    symbols.push({
      name: match[2] as string,
      kind: 'function',
      line_start: line,
      line_end: findPythonBlockEnd(text, indent, line),
      exported: !/(^|\n)def /.test(text.slice(0, offset).split('\n').pop() ?? ''),
      signature: grabSignature(text, offset, line),
    });
  }
  const classRe = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const match of text.matchAll(classRe)) {
    const indent = (match[1] ?? '').length;
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    symbols.push({
      name: match[2] as string,
      kind: 'class',
      line_start: line,
      line_end: findPythonBlockEnd(text, indent, line),
      exported: true,
    });
  }
  const importRe = /^import\s+([\w.]+)|^from\s+([\w.]+)\s+import\b/gm;
  for (const match of text.matchAll(importRe)) {
    const specifier = (match[1] ?? match[2]) as string;
    imports.push({ specifier, relative: specifier.startsWith('.'), names: [] });
  }
  const testRe = /^(\s*)def\s+(test_\w+|[A-Za-z_]*Test\w*?)\s*\(/gm;
  for (const match of text.matchAll(testRe)) tests.push(match[2] as string);

  return { language: 'python', symbols, imports, routes: [], tests, summary: deriveSummary(text) };
}

function extractGo(text: string): FileAnalysis {
  const symbols: DetectedSymbol[] = [];
  const imports: DetectedImport[] = [];
  const tests: string[] = [];

  const funcRe = /^func\s+(\([^)]*\)\s+)?([A-Z]\w*|[a-z]\w*)\s*\(/gm;
  for (const match of text.matchAll(funcRe)) {
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    const isMethod = Boolean(match[1]);
    const name = match[2] as string;
    symbols.push({
      name,
      kind: isMethod ? 'method' : 'function',
      line_start: line,
      line_end: findGoBlockEnd(text, line),
      exported: /^[A-Z]/.test(name),
      signature: grabSignature(text, offset, line),
    });
  }
  const typeRe = /^type\s+([A-Za-z_]\w*)\s+(struct|interface|map\[|\[\]|\w+|func)/gm;
  for (const match of text.matchAll(typeRe)) {
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    symbols.push({
      name: match[1] as string,
      kind: (match[2] as string) === 'struct' ? 'struct' : 'interface',
      line_start: line,
      line_end: findGoBlockEnd(text, line),
      exported: /^[A-Z]/.test(match[1] as string),
    });
  }
  const importRe = /^\s*"([^"]+)"/gm;
  // Go imports live inside an import ( ... ) block; approximate by matching
  // quoted strings that look like paths.
  for (const match of text.matchAll(importRe)) {
    const specifier = match[1] as string;
    if (/\w+\/\w+/.test(specifier)) imports.push({ specifier, relative: false, names: [] });
  }
  const testRe = /^func\s+\([^)]*\)\s+(Test[A-Za-z0-9_]+)\s*\(/gm;
  for (const match of text.matchAll(testRe)) tests.push(match[1] as string);

  return { language: 'go', symbols, imports, routes: [], tests, summary: deriveSummary(text) };
}

function extractRust(text: string): FileAnalysis {
  const symbols: DetectedSymbol[] = [];
  const imports: DetectedImport[] = [];
  const tests: string[] = [];

  const fnRe = /^\s*(?:pub(?:\([\w\s]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/gm;
  for (const match of text.matchAll(fnRe)) {
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    symbols.push({
      name: match[1] as string,
      kind: 'function',
      line_start: line,
      line_end: findBraceBlockEnd(text, offset, line),
      exported: /pub\b/.test(text.slice(Math.max(0, offset - 40), offset)),
    });
  }
  const structRe = /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/gm;
  for (const match of text.matchAll(structRe)) {
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    const keyword = (text.slice(Math.max(0, offset - 30), offset).match(/\b(struct|enum|trait|impl)\b/) ?? ['struct'])[0] ?? 'struct';
    symbols.push({
      name: match[1] as string,
      kind: keyword as SymbolKind === 'trait' ? 'trait' : keyword === 'enum' ? 'enum' : 'struct',
      line_start: line,
      line_end: findBraceBlockEnd(text, offset, line),
      exported: /pub\b/.test(text.slice(Math.max(0, offset - 40), offset)),
    });
  }
  const importRe = /^\s*(?:use|use\s+\w+::)\s*([A-Za-z0-9_:]+)/gm;
  for (const match of text.matchAll(importRe)) {
    const specifier = (match[1] as string).split('::')[0] ?? '';
    if (specifier.startsWith('crate') || specifier.startsWith('super') || specifier.startsWith('self')) continue;
    imports.push({ specifier, relative: specifier.startsWith('./'), names: [] });
  }
  const testRe = /#\[test\]/g;
  let count = 0;
  for (const _ of text.matchAll(testRe)) count += 1;
  if (count > 0) tests.push(`#[test] annotatations (${count})`);
  const testFnRe = /^\s*fn\s+(test_\w+|[A-Za-z_]*_test)\s*\(/gm;
  for (const match of text.matchAll(testFnRe)) tests.push(match[1] as string);

  return { language: 'rust', symbols, imports, routes: [], tests, summary: deriveSummary(text) };
}

function extractJavaLike(text: string, language: string): FileAnalysis {
  const symbols: DetectedSymbol[] = [];
  const imports: DetectedImport[] = [];
  const tests: string[] = [];

  const classRe = /^\s*(?:public|final|abstract|sealed)?\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm;
  for (const match of text.matchAll(classRe)) {
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    const keyword = (text.slice(Math.max(0, offset - 30), offset).match(/\b(class|interface|enum|record)\b/) ?? ['class'])[0] ?? 'class';
    symbols.push({
      name: match[1] as string,
      kind: keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'enum' : 'class',
      line_start: line,
      line_end: findBraceBlockEnd(text, offset, line),
      exported: true,
    });
  }
  const methodRe = /^\s*(?:public|private|protected|static|final|synchronized|abstract)\s+(?:[\w<>[\],. ]+\s+)+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\{/gm;
  for (const match of text.matchAll(methodRe)) {
    const offset = match.index ?? 0;
    const line = (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
    symbols.push({
      name: match[1] as string,
      kind: 'method',
      line_start: line,
      line_end: findBraceBlockEnd(text, offset, line),
      exported: /public/.test(text.slice(Math.max(0, offset - 60), offset)),
    });
  }
  const importRe = /^import\s+([\w.]+[\w*])/gm;
  for (const match of text.matchAll(importRe)) {
    imports.push({ specifier: match[1] as string, relative: false, names: [] });
  }
  const testRe = /@Test\b|^\s*(?:public\s+)?void\s+(test\w+|should\w+)\s*\(/gm;
  for (const match of text.matchAll(testRe)) tests.push(match[1] ?? '@Test');

  return { language, symbols, imports, routes: [], tests, summary: deriveSummary(text) };
}

function extractGeneric(text: string, language: string): FileAnalysis {
  const symbols: DetectedSymbol[] = [];
  const fnRe = /\b(?:function|def|fn|func|sub)\s+([A-Za-z_]\w*)\s*\(/g;
  for (const match of text.matchAll(fnRe)) {
    const offset = match.index ?? 0;
    symbols.push({
      name: match[1] as string,
      kind: 'function',
      line_start: (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1,
      line_end: (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 2,
      exported: true,
    });
  }
  const classRe = /\bclass\s+([A-Za-z_]\w*)/g;
  for (const match of text.matchAll(classRe)) {
    const offset = match.index ?? 0;
    symbols.push({
      name: match[1] as string,
      kind: 'class',
      line_start: (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1,
      line_end: (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 2,
      exported: true,
    });
  }
  return { language, symbols, imports: [], routes: [], tests: [], summary: deriveSummary(text) };
}

function extractSql(text: string): FileAnalysis {
  const symbols: DetectedSymbol[] = [];
  const tableRe = /\bCREATE\s+TABLE(?: IF NOT EXISTS)?\s+["`]?([\w.]+)["`]?/gi;
  for (const match of text.matchAll(tableRe)) {
    const offset = match.index ?? 0;
    symbols.push({
      name: match[1] as string,
      kind: 'module',
      line_start: (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1,
      line_end: (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 2,
      exported: true,
    });
  }
  const indexRe = /\bCREATE\s+(?:UNIQUE\s+)?INDEX/gi;
  const tests: string[] = [];
  const indexMatch = text.matchAll(indexRe);
  let indexCount = 0;
  for (const _ of indexMatch) indexCount += 1;
  if (indexCount > 0) tests.push(`${indexCount} index(es)`);
  return { language: 'sql', symbols, imports: [], routes: [], tests, summary: deriveSummary(text) };
}

/* ------------------------------ shared helpers ---------------------------- */

function lineOf(text: string, offset: number): number {
  return (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
}

function grabSignature(text: string, offset: number, _line: number): string | undefined {
  const rest = text.slice(offset);
  const lines = rest.split('\n', 3);
  const first = lines[0] ?? '';
  if (first.length > 180) return undefined;
  return first.trim().slice(0, 180);
}

function findBlockEnd(text: string, offset: number, startLine: number): number {
  return findBraceBlockEnd(text, offset, startLine) ?? startLine + 2;
}

function findBraceBlockEnd(text: string, offset: number, startLine: number): number {
  const open = text.indexOf('{', offset);
  if (open === -1) return startLine;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return (text.slice(0, i).match(/\n/g)?.length ?? 0) + 1;
    }
  }
  return startLine;
}

function findPythonBlockEnd(text: string, indent: number, startLine: number): number {
  const lines = text.split('\n');
  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const lineIndent = line.match(/^ */)?.[0].length ?? 0;
    if (lineIndent <= indent && line.trim() !== '') return Math.min(Math.max(i, startLine), lines.length);
  }
  return Math.min(startLine + 10, lines.length);
}

function findGoBlockEnd(text: string, startLine: number): number {
  const lines = text.split('\n');
  for (let i = startLine - 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/}\s*$/.test(line)) return i + 1;
  }
  return Math.min(startLine + 10, lines.length);
}

function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

function extractImportNames(statement: string): string[] {
  const names: string[] = [];
  const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(statement);
  if (star) names.push(star[1] as string);
  const defaultNamed = /import\s+([A-Za-z_$][\w$]*)/.exec(statement);
  if (defaultNamed) names.push(defaultNamed[1] as string);
  const braces = /{([^}]+)}/.exec(statement);
  if (braces) {
    for (const item of (braces[1] ?? '').split(',')) {
      const trimmed = item.trim().replace(/\s+as\s+[\w$]+$/, '');
      if (trimmed !== '') names.push(trimmed);
    }
  }
  return names;
}

function deriveSummary(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  // Module-level doc comment.
  const docLines: string[] = [];
  for (const line of lines.slice(0, 24)) {
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('*') || line.startsWith('/**')) {
      const cleaned = line.replace(/^(\/\/|\/\/\/|#|\*|\/\*\*|\*\/)\s*/, '').replace(/\*\//g, '').trim();
      if (cleaned !== '' && !cleaned.startsWith('@')) docLines.push(cleaned);
      if (docLines.length >= 3) break;
    } else if (docLines.length > 0) {
      break;
    }
  }
  if (docLines.length > 0) {
    const summary = docLines.join(' ').slice(0, 240);
    if (summary.length > 8) return summary;
  }
  return undefined;
}

/* -------------------------------- dispatcher ------------------------------ */

const EXTRACTORS = new Map<string, (text: string, language: string) => FileAnalysis>([
  ['typescript', extractTypeScript],
  ['javascript', extractTypeScript],
  ['python', extractPython],
  ['go', extractGo],
  ['rust', extractRust],
  ['java', extractJavaLike],
  ['kotlin', extractJavaLike],
  ['scala', extractJavaLike],
  ['sql', extractSql],
]);

export function analyzeSource(path: string, text: string): FileAnalysis {
  const language = detectLanguage(path);
  if (!language) return { language: undefined, symbols: [], imports: [], routes: [], tests: [], summary: undefined };
  const extract = EXTRACTORS.get(language);
  const limited = text.split('\n').slice(0, MAX_SCAN_LINES).join('\n');
  // Languages without a dedicated extractor still get function-level symbols
  // from the generic pass, which is better than indexing them as opaque blobs.
  if (!extract) return { ...extractGeneric(limited, language), language };
  try {
    return extract(limited, language);
  } catch {
    // A broken extractor must never block indexing.
    return { ...extractGeneric(limited, language), language };
  }
}