const WHOLE_PROJECT_RE = /\b(whole|entire|full|all)\s+(app|application|project|codebase|repository|repo|code)\b|\banalyze\s+(the|this)?\s*(app|whole|entire|project)\b/;
const HISTORICAL_RE = /\b(last|previous|earlier|yesterday|last month|last week|before|back when|a while ago|we (decided|discussed|talked|added|removed|changed))\b/;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|c|cpp|h|hpp|kt|swift|scala|sh|sql|json|ya?ml|toml|md|txt|proto|graphql|vue|svelte)\b/gi;
const SYMBOL_RE = /\b[A-Z][A-Za-z0-9]{2,}(?:\.[A-Za-z0-9]+)?\b|\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]+\b|\b[a-z0-9]+_[a-z0-9_]+\b/g;
const CHANGE_RE = /\b(fix|fixes|fixing|change|update|add|remove|delete|create|refactor|implement|rewrite|repair|migrate|move|rename|improve|optimize|debug|break|edit|patch)\b/;
/** Words that describe a defect without naming a fix action. */
const PROBLEM_RE = /\b(broken|break[sz]?|failing|fails?|failure|wrong|incorrect|mishandl\w*|bug|bugs|crash\w*|error|errors|slow|sluggish|hang\w*|timeout|timeouts|stuck|leak\w*|regression|not working|doesn'?t work|isn'?t working|throws?)\b/i;
const QUESTION_RE = /\b(why|what|how|where|when|who|which|is it|are we|should)\b|[\?]$/;
/**
 * Phrases that ask about something *previously established*. Deliberately not
 * a bare `decide` — "how does the builder decide what to send?" is a code
 * question and must not trigger a history search (§61).
 */
const MEMORY_RE = /\b(remember\w*|memor(?:y|ies)|earlier|previously|last (?:time|month|week|year)|we (?:decided|chose|agreed|discussed|talked)|what did we|history)\b/i;
export function understandQuery(raw, modules = []) {
    const text = raw.trim();
    const lower = text.toLowerCase();
    const paths = [...new Set(text.match(PATH_RE) ?? [])];
    const symbols = [
        ...new Set((text.match(SYMBOL_RE) ?? []).filter((s) => !/^[A-Z]{2,}$/.test(s) || isAcronym(s))),
    ].slice(0, 12);
    // Module attribution: match the query terms against indexed module names.
    const queryTerms = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
    const modulesHit = [];
    for (const mod of modules) {
        const name = mod.name.toLowerCase();
        for (const term of queryTerms) {
            if (name.includes(term) && term.length >= 3 && !modulesHit.includes(mod.name)) {
                modulesHit.push(mod.name);
                break;
            }
        }
    }
    const wholeProject = WHOLE_PROJECT_RE.test(lower);
    const historical = HISTORICAL_RE.test(lower);
    const isQuestion = QUESTION_RE.test(lower);
    const isChange = CHANGE_RE.test(text);
    const isMemoryY = MEMORY_RE.test(lower);
    // A defect report that names code is a code task, even without an action verb:
    // "parseReceipt is mishandling currency" must not fall through to chat.
    const problemWithCode = PROBLEM_RE.test(lower) && (symbols.length > 0 || paths.length > 0 || modulesHit.length > 0);
    let kind = 'chat';
    if (wholeProject)
        kind = 'analysis';
    else if (isMemoryY)
        kind = 'memory_query';
    else if (isChange || problemWithCode)
        kind = 'code_change';
    else if (isQuestion)
        kind = 'question';
    else
        kind = 'chat';
    return {
        kind,
        terms: queryTerms,
        paths,
        symbols,
        modules: modulesHit.slice(0, 8),
        whole_project: wholeProject,
        historical,
        confidence: isChange || problemWithCode || isQuestion ? 0.9 : 0.6,
    };
}
function isAcronym(word) {
    return word.length >= 2 && word === word.toUpperCase() && word.length <= 8;
}
export function planForIntent(intent) {
    if (intent.whole_project) {
        return {
            stages: [
                { name: 'project_map', limit: 80 },
                { name: 'modules', limit: 40 },
                { name: 'entry_points', limit: 20 },
                { name: 'symbols', limit: 40 },
                { name: 'memory', limit: 12 },
                { name: 'files', limit: 24 },
            ],
        };
    }
    if (intent.historical || intent.kind === 'memory_query') {
        return {
            stages: [
                { name: 'memory', limit: 20 },
                { name: 'conversation', limit: 24 },
                { name: 'recent_context', limit: 8 },
                { name: 'project_map', limit: 12 },
                { name: 'files', limit: 6 },
            ],
        };
    }
    if (intent.kind === 'code_change' || intent.kind === 'analysis') {
        return {
            stages: [
                { name: 'project_map', limit: 24 },
                { name: 'index_symbols', limit: 20 },
                { name: 'index_files', limit: 16 },
                { name: 'memory', limit: 10 },
                { name: 'dependencies', limit: 12 },
                { name: 'files', limit: 10 },
            ],
        };
    }
    return {
        stages: [
            { name: 'project_map', limit: 12 },
            { name: 'index_files', limit: 8 },
            { name: 'memory', limit: 6 },
            { name: 'recent_context', limit: 6 },
        ],
    };
}
//# sourceMappingURL=intent.js.map