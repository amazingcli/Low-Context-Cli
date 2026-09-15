/**
 * Stable identifier generation.
 *
 * IDs are prefixed by kind so that any string appearing in a log, trace or
 * memory dump can be understood without a lookup table. They sort
 * lexicographically by creation time, which keeps JSONL scans chronological.
 *
 * The returned value is *opaque* — never parse it to recover the timestamp at
 * runtime; use the `created_at` field on the record instead.
 */
import { createHash, randomBytes } from 'node:crypto';
const TIME_WIDTH = 9; // base36, ~2.8e13 ms of headroom
const EPOCH_OFFSET = 1_600_000_000_000; // 2020-09-13, keeps ids short
let counter = Math.floor(Math.random() * 1296);
function nextCounter() {
    counter = (counter + 1) % 1296;
    return counter.toString(36).padStart(2, '0');
}
/** Create a new id such as `mem_m1x9k2ab07q4f`. */
export function newId(prefix) {
    const time = (Date.now() - EPOCH_OFFSET).toString(36).padStart(TIME_WIDTH, '0');
    return `${prefix}_${time}${nextCounter()}${randomBytes(3).toString('hex')}`;
}
/** True when `value` looks like an id created by {@link newId} for `prefix`. */
export function isIdOf(value, prefix) {
    return typeof value === 'string' && value.startsWith(`${prefix}_`) && value.length > prefix.length + 6;
}
/** Deterministic, filesystem-safe id derived from arbitrary text. */
export function stableId(prefix, key) {
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return `${prefix}_${digest}`;
}
/** Short random token, used for cache-busting and temp file names. */
export function shortToken(bytes = 4) {
    return randomBytes(bytes).toString('hex');
}
//# sourceMappingURL=ids.js.map