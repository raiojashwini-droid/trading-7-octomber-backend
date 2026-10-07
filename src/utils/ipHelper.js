/**
 * Utility to reliably extract the actual public/client IP address from an Express request object.
 * Fixes reverse proxy / Nginx / ALB short-circuiting issues where req.socket.remoteAddress
 * or req.ip defaults to 127.0.0.1.
 */
function extractClientIp(req) {
    if (!req) return '127.0.0.1';

    let ip = '';

    // 1. Check proxy / CDN headers first (most accurate for public IP)
    if (req.headers) {
        ip = req.headers['cf-connecting-ip'] ||
             req.headers['x-client-ip'] ||
             req.headers['x-forwarded-for'] ||
             req.headers['x-real-ip'] ||
             req.headers['true-client-ip'] ||
             '';
    }

    // Handle comma-separated list of IPs in X-Forwarded-For (e.g. "49.36.12.34, 127.0.0.1")
    if (typeof ip === 'string' && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }

    // Clean up IPv6 loopback & mapped IPv4 formats
    if (typeof ip === 'string') {
        ip = ip.trim();
        if (ip === '::1') ip = '127.0.0.1';
        if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
    }

    // If header extraction yielded a valid non-loopback IP, return it
    if (ip && ip !== '127.0.0.1' && ip !== 'localhost') {
        return ip;
    }

    // 2. Try express req.ip
    let expressIp = req.ip || '';
    if (typeof expressIp === 'string') {
        expressIp = expressIp.trim();
        if (expressIp === '::1') expressIp = '127.0.0.1';
        if (expressIp.startsWith('::ffff:')) expressIp = expressIp.replace('::ffff:', '');
    }

    if (expressIp && expressIp !== '127.0.0.1' && expressIp !== 'localhost') {
        return expressIp;
    }

    // 3. Check explicitly provided clientIp in body (from App/Web if forwarded)
    if (req.body && typeof req.body.clientIp === 'string' && req.body.clientIp.trim()) {
        const bodyIp = req.body.clientIp.trim();
        if (bodyIp !== '127.0.0.1' && bodyIp !== 'localhost') return bodyIp;
    }

    // 4. Fallback to socket remoteAddress
    let fallback = req.socket?.remoteAddress || '127.0.0.1';
    if (typeof fallback === 'string') {
        if (fallback === '::1') fallback = '127.0.0.1';
        if (fallback.startsWith('::ffff:')) fallback = fallback.replace('::ffff:', '');
    }

    return fallback || '127.0.0.1';
}

module.exports = { extractClientIp };
