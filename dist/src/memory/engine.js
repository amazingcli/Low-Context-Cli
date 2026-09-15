import { IMPORTANCE_ORDER } from '../core/types.js';
import { newId } from '../core/ids.js';
/** Signals that make a user message worth remembering (§10). */
const USER_MEMORY_SIGNALS = [
    { re: /\bremember(?: this)?\b/i, type: 'FACT' },
    { re: /\bdon'?t forget\b/i, type: 'FACT' },
    { re: /\b(prefer|preference|always|never|please use|use the)\b/i, type: 'PREFERENCE' },
    { re: /\bdecision|decided|we chose|we use\b/i, type: 'DECISION' },
    { re: /\barchitecture|design decision|layout\b/i, type: 'ARCHITECTURE' },
    { re: /\binstruction|rule\b/i, type: 'USER_INSTRUCTION' },
];
/** Turns a raw user message into memory candidates. */
export function candidatesFromUserMessage(message, context) {
    const out = [];
    for (const signal of USER_MEMORY_SIGNALS) {
        if (signal.re.test(message)) {
            out.push({
                type: signal.type,
                scope: context.taskId ? 'task' : context.projectId ? 'project' : 'global',
                summary: message.replace(/\s+/g, ' ').trim().slice(0, 400),
                tags: [signal.type.toLowerCase()],
                source_refs: [],
                confidence: 'high',
                importance: signal.type === 'PREFERENCE' || signal.type === 'USER_INSTRUCTION' || signal.type === 'DECISION' ? 'important' : 'normal',
                ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
                ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
                ...(context.taskId === undefined ? {} : { task_id: context.taskId }),
            });
        }
    }
    return out;
}
/** Explicit `remember this` carries the highest confidence. */
export function candidateFromExplicitRemember(message, context) {
    const match = /^(?:please\s+)?(?:remember|memorize|note(?: down)?)\s*(?:this|that)?\s*:?\s*(.+)$/i.exec(message.trim());
    if (!match)
        return undefined;
    const summary = match[1].trim();
    if (summary.length < 4)
        return undefined;
    return {
        type: 'FACT',
        scope: context.taskId ? 'task' : context.projectId ? 'project' : 'global',
        summary: summary.replace(/\s+/g, ' ').trim().slice(0, 500),
        source_refs: [],
        confidence: 'verified',
        importance: 'important',
        ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
        ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
        ...(context.taskId === undefined ? {} : { task_id: context.taskId }),
    };
}
export function parseMemoryControl(message) {
    const trimmed = message.trim();
    if (/^\s*(?:please\s+)?(?:remember|memorize|note down)\b/i.test(trimmed))
        return { type: 'remember', target: trimmed };
    // "delete the readme" is a file operation, not a memory directive. `forget`
    // is unambiguous; `delete`/`remove` only count when they name memory.
    if (/^\s*forget\b/i.test(trimmed)) {
        return { type: 'forget', target: trimmed.replace(/^\s*forget\s*/i, '') };
    }
    if (/^\s*(?:delete|remove)\b[^.\n]{0,30}\bmemor(?:y|ies)\b/i.test(trimmed)) {
        return {
            type: 'forget',
            target: trimmed.replace(/^\s*(?:delete|remove)\s+(?:this\s+|that\s+|the\s+)?memor(?:y|ies)\s*(?:matching\s*)?/i, ''),
        };
    }
    if (/don'?t remember|do not remember|don'?t store|do not store|don'?t save|do not save/i.test(trimmed))
        return { type: 'dont_remember' };
    if (/^\s*(?:show|list|what|display)\s+(?:my )?memory/i.test(trimmed))
        return { type: 'show' };
    return { type: 'none' };
}
/** Message content stripped of an explicit memory-control directive. */
export function stripMemoryControl(message, control) {
    if (control.type === 'dont_remember')
        return message;
    if (control.type === 'remember')
        return message.replace(/^\s*(?:please\s+)?(?:remember|memorize|note down)\s*(?:this|that)?\s*:?\s*/i, '');
    return message;
}
/**
 * Extract durable memory candidates from *verified* agent events (§35).
 * Tool results become memory only when they represent confirmed outcomes.
 */
export function extractFromEvents(events, context, minImportance = 'normal') {
    const written = [];
    const skipped = [];
    for (const event of events) {
        if (event.kind === 'verification' && event.data) {
            const passed = event.data.passed !== false;
            const summary = describeVerificationEvent(event.data);
            if (passed) {
                written.push({
                    id: newId('mem'),
                    type: 'COMMAND_RESULT',
                    scope: context.projectId ? 'project' : 'global',
                    summary: `Verified: ${summary.slice(0, 300)}`,
                    source_refs: [
                        {
                            kind: 'tool_result',
                            ...(typeof event.data.tool_call_id === 'string' ? { tool_call_id: event.data.tool_call_id } : {}),
                        },
                    ],
                    confidence: 'verified',
                    importance: atLeast(minImportance),
                    tags: ['verified', 'test'],
                    ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
                    ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
                    ...(context.taskId === undefined ? {} : { task_id: context.taskId }),
                });
            }
            else {
                skipped.push({ summary, reason: 'verification failed' });
            }
        }
        if (event.kind === 'edit' && event.data) {
            const file = typeof event.data.file === 'string' ? event.data.file : undefined;
            if (file) {
                written.push({
                    type: 'FILE_KNOWLEDGE',
                    scope: context.projectId ? 'project' : 'global',
                    summary: `Changed ${file}: ${typeof event.data.summary === 'string' ? event.data.summary : 'edit applied'}`.slice(0, 300),
                    source_refs: [{ kind: 'file', file_path: file }],
                    confidence: 'verified',
                    importance: atLeast(minImportance),
                    module_path: file,
                    tags: ['edit'],
                    ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
                    ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
                    ...(context.taskId === undefined ? {} : { task_id: context.taskId }),
                });
            }
        }
    }
    return { written, skipped };
}
/** Prefer the human summary the caller supplied, then the command that ran. */
function describeVerificationEvent(data) {
    if (typeof data.summary === 'string' && data.summary !== '')
        return data.summary;
    if (typeof data.command === 'string' && data.command !== '')
        return data.command;
    return 'Verification run';
}
/** Raise a record's importance to the configured floor, never lower it. */
function atLeast(floor) {
    const normal = 'normal';
    return IMPORTANCE_ORDER[normal] >= IMPORTANCE_ORDER[floor] ? normal : floor;
}
/** A corrected record: supersede the old memory, write the new one (§11). */
export function correctionWrite(oldId, summary, type, source, context, confidence = 'verified') {
    return {
        type,
        scope: context.projectId ? 'project' : 'global',
        summary,
        source_refs: [source],
        confidence,
        importance: 'important',
        supersedes: oldId,
        ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
        ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
        ...(context.taskId === undefined ? {} : { task_id: context.taskId }),
        verification_state: 'verified',
    };
}
export function defaultConfigImportance(config) {
    return config.memory?.min_importance === 'temporary' ? 'temporary' : 'normal';
}
//# sourceMappingURL=engine.js.map