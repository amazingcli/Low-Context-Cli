/**
 * Token estimation (§14, §79).
 *
 * Real tokenizers are provider-specific and none is guaranteed offline, so
 * every estimate is heuristic and marked as such. Rules:
 *  - ASCII runs count at ~4 chars/token, sub-word fragmentation included.
 *  - CJK and other wide scripts count ≈ 1 token/character.
 *  - A floor is applied so short prompts aren't wildly understated.
 * The estimator is used for context budgeting and for `~tokens` display, with
 * provider-reported usage replacing it whenever the API returns real numbers.
 */

export interface TokenEstimate {
  tokens: number;
  chars: number;
}

export function estimateTokens(text: string): TokenEstimate {
  const chars = text.length;
  if (chars === 0) return { tokens: 0, chars: 0 };
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < chars; i += 1) {
    const code = (text.charCodeAt(i) as number);
    if (
      (code >= 0x3000 && code <= 0x9fff) || // CJK + punctuation
      (code >= 0xac00 && code <= 0xd7af) || // hangul
      (code >= 0x3040 && code <= 0x30ff) // kana
    ) {
      cjk += 1;
    } else if (code < 0x80) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  const tokens = Math.ceil(cjk * 1.0 + other * 0.65 + ascii / 4.0);
  return { tokens: Math.max(tokens, 1), chars };
}

/** Rough token cost of a code region: whitespace is cheap, strings are not. */
export function estimateCodeTokens(text: string): number {
  const { tokens } = estimateTokens(text);
  return tokens;
}

export function estimateMessagesTokens(messages: readonly { content: string }[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.content).tokens;
  return total;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}