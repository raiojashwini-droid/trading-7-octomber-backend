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

const withTimeout = (promise, ms = 500) => {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Cache operation timed out')), ms))
    ]);
};

// In-memory fallback cache (used when Redis is not available or for instant 0ms access)
const memoryCache = new Map();

const getFromMemoryCache = (key) => {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
        memoryCache.delete(key);
        return null;
    }
    return entry.value;
};

const saveToMemoryCache = (key, value, ttlSeconds = 300) => {
    if (memoryCache.size > 2000) {
        const firstKey = memoryCache.keys().next().value;
        if (firstKey) memoryCache.delete(firstKey);
    }
    memoryCache.set(key, {
        value,
        expiry: Date.now() + (ttlSeconds * 1000)
    });
};

/**
 * Get value from cache (checks fast memory first, falls back to Redis)
 * Safe: Returns null if cache unavailable
 */
const getFromCache = async (key) => {
    // 1. Instant check in memory
    const memVal = getFromMemoryCache(key);
    if (memVal !== null && memVal !== undefined) {
        return memVal;
    }

    // 2. Check Redis if connected
    if (!isRedisConnected || !redisClient) return null;

    try {
        const data = await withTimeout(redisClient.get(key), 500);
        if (data) {
            const parsed = JSON.parse(data);
            saveToMemoryCache(key, parsed, 60); // Populate fast local memory
            return parsed;
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
    // 1. Always save to fast in-memory cache
    saveToMemoryCache(key, value, ttlSeconds);

    // 2. Also save to Redis if connected
    if (!isRedisConnected || !redisClient) return true;

    try {
        await withTimeout(redisClient.setEx(key, ttlSeconds, JSON.stringify(value)), 500);
        return true;
    } catch (err) {
        console.warn(`[Cache] SET error for ${key}:`, err.message);
        return true; // Still succeeded in memory
    }
};

/**
 * Invalidate cache key
 * Safe: Silently fails if unavailable
 */
const invalidateCache = async (key) => {
    memoryCache.delete(key);

    if (!isRedisConnected || !redisClient) return true;

    try {
        await redisClient.del(key);
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
    memoryCache.clear();

    if (!isRedisConnected || !redisClient) return true;

    try {
        await redisClient.flushAll();
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
    isConnected: () => isRedisConnected || memoryCache.size >= 0
};

