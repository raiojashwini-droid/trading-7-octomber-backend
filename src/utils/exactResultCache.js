/**
 * In-process cache of exact query results.
 * The generation comes from cacheManager. A financial write bumps it,
 * which drops these entries. A miss always runs the query. Values are
 * never invented, and a cold miss waits for the query instead of returning
 * an empty stand-in.
 */
const cache = new Map();
const inflight = new Map();
let seenGen = null;

function resetIfGenerationChanged(gen) {
    const key = String(gen);
    if (seenGen === key) return;
    cache.clear();
    seenGen = key;
}

async function getExact(gen, key, loader) {
    resetIfGenerationChanged(gen);
    const fullKey = `${seenGen}\n${key}`;
    if (cache.has(fullKey)) return cache.get(fullKey);
    if (inflight.has(fullKey)) return inflight.get(fullKey);

    const startedGen = seenGen;
    const pending = (async () => {
        const value = await loader();
        if (seenGen === startedGen) cache.set(fullKey, value);
        return value;
    })().finally(() => {
        inflight.delete(fullKey);
    });
    inflight.set(fullKey, pending);
    return pending;
}

module.exports = { getExact };
