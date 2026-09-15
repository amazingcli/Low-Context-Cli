/** A dependency-free, deterministic, L2-normalised hashing vectoriser. */
export class HashingEmbedder {
    name = 'local-hashing';
    dimensions;
    constructor(dimensions = 512) {
        this.dimensions = dimensions;
    }
    /** Stable 32-bit string hash (FNV-1a variant). */
    static hash(str) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i += 1) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return hash >>> 0;
    }
    async embed(texts) {
        const out = [];
        for (const text of texts)
            out.push(HashingEmbedder.embedOne(text, this.dimensions));
        return out;
    }
    static embedOne(text, dims) {
        const vector = new Float32Array(dims);
        const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
        const tf = new Map();
        for (const token of tokens)
            tf.set(token, (tf.get(token) ?? 0) + 1);
        for (const [token, count] of tf) {
            const slot = HashingEmbedder.hash(token) % dims;
            // Sub-token hashing triples coverage per slot, capturing a little of the
            // "similar words hash near each other" behaviour.
            vector[slot] = (vector[slot] ?? 0) + (1 + Math.log(count));
            if (token.length > 4) {
                const second = HashingEmbedder.hash(token.slice(1)) % dims;
                vector[second] = (vector[second] ?? 0) + 0.5 * (1 + Math.log(count));
            }
        }
        HashingEmbedder.normalise(vector);
        return vector;
    }
    static normalise(vector) {
        let sum = 0;
        for (let i = 0; i < vector.length; i += 1)
            sum += vector[i] ** 2;
        const norm = Math.sqrt(sum) || 1;
        for (let i = 0; i < vector.length; i += 1)
            vector[i] = vector[i] / norm;
    }
}
/** Client half of an OpenAI-compatible embeddings API. */
export class ApiEmbedder {
    endpoint;
    apiKey;
    model;
    headers;
    name;
    dimensions;
    constructor(endpoint, apiKey, model, configuredDimensions, headers = {}) {
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.model = model;
        this.headers = headers;
        this.name = `api:${model}`;
        this.dimensions = configuredDimensions ?? 1024;
    }
    async embed(texts, options = {}) {
        const response = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                ...this.headers,
            },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: options.signal,
        });
        if (!response.ok) {
            throw new Error(`embedding request failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
        }
        const body = (await response.json());
        const rows = body.data ?? [];
        const out = [];
        for (const row of rows) {
            const raw = row.embedding;
            let values;
            if (Array.isArray(raw))
                values = raw;
            else
                values = raw?.values;
            const vector = new Float32Array(values ?? []);
            if (vector.length === 0)
                throw new Error('embedding response had no vector');
            out.push(vector);
        }
        return out;
    }
}
//# sourceMappingURL=embedder.js.map