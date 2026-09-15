/**
 * Tokenisation.
 *
 * Retrieval quality for code depends heavily on how identifiers are split.
 * `readReceipt`, `read_receipt` and `ReadReceipt` must all be findable from the
 * query "read receipt", so the tokenizer:
 *
 *   1. splits on non-alphanumerics
 *   2. splits camelCase / PascalCase boundaries
 *   3. lowercases
 *   4. drops stop words
 *   5. applies a deliberately conservative stemmer
 *
 * It also keeps the *raw* identifier tokens (with original casing) so exact
 * symbol matching can score higher than a stemmed lexical hit.
 */
export const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'with',
    'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'done', 'have', 'has',
    'had', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he', 'she', 'them', 'my',
    'our', 'your', 'their', 'me', 'us', 'so', 'not', 'no', 'yes', 'can', 'could', 'should', 'would', 'will',
    'just', 'about', 'into', 'over', 'up', 'down', 'out', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'please', 'want', 'need', 'make', 'made', 'using', 'use', 'used', 'get', 'got', 'also', 'than', 'there',
    'here', 'all', 'any', 'some', 'more', 'most', 'very', 's', 't', 're', 've', 'll', 'd', 'm',
]);
/** Language keywords that carry no retrieval signal. */
export const CODE_KEYWORDS = new Set([
    'function', 'const', 'let', 'var', 'return', 'import', 'from', 'export', 'default', 'class', 'extends',
    'interface', 'type', 'enum', 'public', 'private', 'protected', 'static', 'async', 'await', 'new', 'this',
    'self', 'def', 'lambda', 'struct', 'impl', 'fn', 'pub', 'mut', 'package', 'void', 'int', 'string', 'bool',
    'true', 'false', 'null', 'undefined', 'none', 'nil', 'print', 'console', 'log',
]);
const MAX_TOKEN_LENGTH = 48;
/** Split an identifier-ish string into words, preserving original casing. */
export function splitIdentifier(raw) {
    const out = [];
    let current = '';
    const flush = () => {
        if (current !== '') {
            out.push(current);
            current = '';
        }
    };
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        const code = ch.charCodeAt(0);
        const isUpper = code >= 65 && code <= 90;
        const isLower = code >= 97 && code <= 122;
        const isDigit = code >= 48 && code <= 57;
        const isAlphaNum = isUpper || isLower || isDigit;
        if (!isAlphaNum) {
            // Collapse `_` and `-` as word boundaries; drop everything else.
            flush();
            continue;
        }
        if (isUpper) {
            const next = raw[i + 1];
            const prev = raw[i - 1];
            const nextIsLower = next !== undefined && next >= 'a' && next <= 'z';
            const prevIsDigit = prev !== undefined && prev >= '0' && prev <= '9';
            const boundary = current !== '' &&
                // `readReceipt` -> read | Receipt ; `HTTPClient` -> HTTP | Client
                ((prev !== undefined && prev >= 'a' && prev <= 'z') ||
                    (nextIsLower && (prev === undefined || (prev >= 'A' && prev <= 'Z'))));
            if (boundary || current === '') {
                if (current !== '')
                    flush();
            }
            if (prevIsDigit || (current !== '' && current === ''))
                flush();
        }
        current += ch;
        if (current.length > MAX_TOKEN_LENGTH)
            flush();
    }
    flush();
    return out;
}
/** Conservatively strip plural/verb endings. Never shortens below 3 chars. */
export function stem(term) {
    if (term.length < 4)
        return term;
    const rules = [
        [/ies$/, 'y'],
        [/ied$/, 'y'],
        [/([^aeiou])es$/, '$1'],
        [/(ss|sh|ch|x|z)es$/, '$1'],
        [/ing$/, ''],
        [/edly$/, ''],
        [/ed$/, ''],
        [/ly$/, ''],
        [/s$/, ''],
    ];
    for (const [re, replacement] of rules) {
        if (re.test(term)) {
            const next = term.replace(re, replacement);
            if (next.length >= 3)
                return next;
        }
    }
    return term;
}
/** Tokenize text into normalised, stemmed terms suitable for indexing. */
export function tokenize(text, options = {}) {
    const out = [];
    for (const word of splitIdentifier(text)) {
        const lower = word.toLowerCase();
        if (!options.keepStopwords && STOPWORDS.has(lower))
            continue;
        if (!options.keepCodeKeywords && CODE_KEYWORDS.has(lower))
            continue;
        if (lower.length < 2)
            continue;
        out.push(options.stem === false ? lower : stem(lower));
    }
    return out;
}
/** Unique terms only — used to keep postings lookups small. */
export function uniqueTerms(text, options = {}) {
    return [...new Set(tokenize(text, options))];
}
const IDENTIFIER_RE = /\b(?:[A-Za-z_][A-Za-z0-9_]*?(?:[A-Z][a-z0-9]+)+[A-Za-z0-9_]*|[a-z0-9]+_[a-z0-9_]+)\b/g;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|c|cpp|h|hpp|kt|swift|scala|sh|sql|json|ya?ml|toml|md|txt|proto|graphql)\b/gi;
export function analyzeQuery(query) {
    const terms = uniqueTerms(query);
    const raw = [...new Set(tokenize(query, { stem: false }))];
    const identifiers = [...new Set(query.match(IDENTIFIER_RE) ?? [])];
    const path_terms = [...new Set(query.match(PATH_RE) ?? [])];
    return { terms, raw, identifiers, path_terms };
}
/** Term frequency map for a document body. */
export function termFrequencies(tokens) {
    const map = new Map();
    for (const token of tokens)
        map.set(token, (map.get(token) ?? 0) + 1);
    return map;
}
//# sourceMappingURL=tokenize.js.map