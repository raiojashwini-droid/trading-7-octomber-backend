/**
 * Redis Cache Manager
 *
 * Safe caching utility that doesn't break existing functionality
 * If Redis is not available, gracefully falls back to no caching
 */  
//   ..
const redis = require('redis');

let redisClient = null;
let isRedisConnected = false;
const localGeneration = Object.create(null);

function sqlText(sql) {
    if (typeof sql === 'string') return sql;
    if (sql && typeof sql.sql === 'string') return sql.sql;
    return '';
}

function shouldBumpFinancialCache(sql) {
    const text = sqlText(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!/^(insert|update|delete|replace)\b/.test(text)) return false;
    if (text.startsWith('update trades set last_market_price')) return false;
    if (text.startsWith('update users set session_token')) return false;
    if (text.startsWith('insert into ip_logs')) return false;
    return /\b(trades|ledger|users|client_settings|weekly_settlement|weekly_balances)\b/.test(text);
}

async function getGeneration(name) {
    if (isRedisConnected && redisClient) {
        try {
            const value = await redisClient.get(`cachegen:${name}`);
            if (value != null) return String(value);
        } catch (err) {
            console.warn(`[Cache] generation read failed for ${name}:`, err.message);
        }
    }
    return String(localGeneration[name] || 0);
}

async function bumpGeneration(name) {
    localGeneration[name] = (localGeneration[name] || 0) + 1;
    if (!isRedisConnected || !redisClient) return;
    try {
        await redisClient.incr(`cachegen:${name}`);
    } catch (err) {
        console.warn(`[Cache] generation bump failed for ${name}:`, err.message);
    }
}

async function noteFinancialWrite(sql) {
    if (!shouldBumpFinancialCache(sql)) return;
    await Promise.all([
        bumpGeneration('financial'),
        bumpGeneration('users'),
        bumpGeneration('funds')
    ]);
}

/**
 * Initialize Redis connection
 * Safe: If Redis fails, app continues without caching
 */
const initializeCache = async () => {
    try {
        const redisUrl = process.env.REDIS_URL || null;
        
        const clientOptions = redisUrl 
            ? { url: redisUrl }
            : {
                socket: {
                    host: process.env.REDIS_HOST || 'localhost',
                    port: parseInt(process.env.REDIS_PORT || '6379'),
                    reconnectStrategy: (retries) => {
                        if (retries > 3) {
                            console.warn('[Cache] Redis reconnection failed, continuing without cache');
                            return new Error('Redis max retries exceeded');
                        }
                        return retries * 100;
                    }
                }
            };

        redisClient = redis.createClient(clientOptions);

        redisClient.on('error', (err) => {
            console.warn('[Cache] ⚠️ Redis error:', err.message);
            isRedisConnected = false;
        });

        redisClient.on('connect', () => {
            console.log('[Cache] ✅ Redis connected');
            isRedisConnected = true;
        });

        await redisClient.connect();
        isRedisConnected = true;
    } catch (err) {
        console.warn('[Cache] Redis not available, caching disabled:', err.message);
        isRedisConnected = false;
    }
};

/**
 * Get value from cache
 * Safe: Returns null if cache unavailable
 */
const getFromCache = async (key) => {
    if (!isRedisConnected || !redisClient) return null;

    try {
        const data = await redisClient.get(key);
        if (data) {
            console.log(`[Cache] ✅ HIT: ${key}`);
            return JSON.parse(data);
        }
        return null;
    } catch (err) {
        console.warn(`[Cache] GET error for ${key}:`, err.message);
        return null;
    }
};

/**
 * Save value to cache with TTL
 * Safe: Silently fails if cache unavailable
 */
const saveToCache = async (key, value, ttlSeconds = 300) => {
    if (!isRedisConnected || !redisClient) return false;

    try {
        await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
        console.log(`[Cache] 💾 SAVED: ${key} (TTL: ${ttlSeconds}s)`);
        return true;
    } catch (err) {
        console.warn(`[Cache] SET error for ${key}:`, err.message);
        return false;
    }
};

/**
 * Invalidate cache key
 * Safe: Silently fails if unavailable
 */
const invalidateCache = async (key) => {
    if (!isRedisConnected || !redisClient) return false;

    try {
        await redisClient.del(key);
        console.log(`[Cache] 🗑️ INVALIDATED: ${key}`);
        return true;
    } catch (err) {
        console.warn(`[Cache] DEL error for ${key}:`, err.message);
        return false;
    }
};

/**
 * Clear all cache
 * Safe: Silently fails
 */
const clearAllCache = async () => {
    if (!isRedisConnected || !redisClient) return false;

    try {
        await redisClient.flushAll();
        console.log('[Cache] 🧹 ALL CACHE CLEARED');
        return true;
    } catch (err) {
        console.warn('[Cache] FLUSH error:', err.message);
        return false;
    }
};

module.exports = {
    initializeCache,
    getFromCache,
    saveToCache,
    invalidateCache,
    clearAllCache,
    isConnected: () => isRedisConnected,
    getGeneration,
    bumpGeneration,
    noteFinancialWrite,
    shouldBumpFinancialCache
};
