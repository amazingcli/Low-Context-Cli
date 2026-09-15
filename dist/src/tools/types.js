/* ---------------------------- argument coercion ---------------------------- */
export class ToolArgumentError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolArgumentError';
    }
}
export function asString(args, key, options = {}) {
    const value = args[key];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (options.fallback !== undefined)
        return options.fallback;
    if (options.required === false)
        return '';
    throw new ToolArgumentError(`missing required string argument "${key}"`);
}
export function asOptionalString(args, key) {
    const value = args[key];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return undefined;
}
export function asNumber(args, key, options = {}) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    if (options.fallback !== undefined)
        return options.fallback;
    if (options.required === false)
        return 0;
    throw new ToolArgumentError(`missing required numeric argument "${key}"`);
}
export function asBoolean(args, key, fallback = false) {
    const value = args[key];
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return value === 'true' || value === '1' || value === 'yes';
    if (typeof value === 'number')
        return value !== 0;
    return fallback;
}
export function asStringArray(args, key) {
    const value = args[key];
    if (Array.isArray(value))
        return value.filter((v) => typeof v === 'string');
    if (typeof value === 'string' && value.trim() !== '')
        return [value];
    return [];
}
/* ------------------------------- json schema ------------------------------- */
export function objectSchema(properties, required = []) {
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    };
}
export function stringProp(description, extra = {}) {
    return { type: 'string', description, ...extra };
}
export function numberProp(description, extra = {}) {
    return { type: 'number', description, ...extra };
}
export function booleanProp(description, extra = {}) {
    return { type: 'boolean', description, ...extra };
}
export function enumProp(description, values) {
    return { type: 'string', description, enum: [...values] };
}
/* -------------------------------- results --------------------------------- */
export function toolResultFrom(call, result, extra) {
    return {
        id: call.id,
        tool_call_id: call.id,
        tool: call.name,
        ok: result.ok !== false,
        summary: result.summary,
        bytes: extra.bytes,
        truncated: extra.truncated,
        duration_ms: extra.duration_ms,
        ...(extra.artifactPath === undefined ? {} : { artifact_path: extra.artifactPath }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.affected_files === undefined ? {} : { affected_files: result.affected_files }),
        ...(result.exit_code === undefined ? {} : { exit_code: result.exit_code }),
        ...(result.verification_state === undefined ? {} : { verification_state: result.verification_state }),
    };
}
//# sourceMappingURL=types.js.map