const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { logAction } = require('./systemController');
const { getFromCache, saveToCache, invalidateCache } = require('../utils/cacheManager');
const { getLotSize } = require('../utils/symbolHelper');
const { calculateTradeBrokerage } = require('../utils/brokerageHelper');
const { clearSegmentCache } = require('../utils/segmentPermissionHelper');

const { uploadFile, deleteFile } = require('../utils/imagekit');

const getUsers = async (req, res) => {
    try {
        const { role, adminId, fromDate, toDate, search, page, limit, paginate } = req.query;
        const currentUserId = req.user.id;
        const currentUserRole = req.user.role;

        const parsedLimit = limit !== undefined ? parseInt(limit, 10) : 50;
        const parsedPage = page !== undefined ? parseInt(page, 10) : 1;
        const effectiveLimit = Math.min(Math.max(isNaN(parsedLimit) ? 50 : parsedLimit, 1), 5000);
        const effectiveOffset = Math.max((isNaN(parsedPage) ? 1 : parsedPage - 1) * effectiveLimit, 0);

        console.log(`[getUsers] User ${currentUserId} (${currentUserRole}) requesting users: role=${role || 'all'}, page=${parsedPage}, limit=${effectiveLimit}, search=${search || 'none'}`);

        const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
        const { week_start } = getWeekBoundaries(getISTDate());

        // Cache key with pagination and search
        const cacheKey = `users_${currentUserId}_${role || 'all'}_${req.query.status || 'all'}_${adminId || 'all'}_${fromDate || 'all'}_${toDate || 'all'}_${search || 'all'}_${parsedPage}_${effectiveLimit}`;
        // Separate cache key for total count (shared across pages, longer TTL)
        const countCacheKey = `users_count_${currentUserId}_${role || 'all'}_${req.query.status || 'all'}_${adminId || 'all'}_${fromDate || 'all'}_${toDate || 'all'}_${search || 'all'}`;
        try {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (cacheErr) {
            console.log(`[getUsers] Cache read failed, proceeding with DB query`);
        }

        // ── STEP 0: Build WHERE clause and params ──
        let whereClause = ' WHERE 1=1';
        const params = [];

        // Apply role filter
        if (role) {
            whereClause += ' AND u.role = ?';
            params.push(role);
        }

        // Apply status filter if provided
        if (req.query.status) {
            whereClause += ' AND u.status = ?';
            params.push(req.query.status);
        }

        // Apply search filter across username, full_name, email
        if (search && search.trim()) {
            whereClause += ' AND (u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)';
            const searchPattern = `%${search.trim()}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        // Apply hierarchy filtering based on role
        if (currentUserRole === 'SUPERADMIN') {
            if (role === 'BROKER' && adminId) {
                if (adminId === 'all') {
                    console.log(`[getUsers] SUPERADMIN ${currentUserId} viewing ALL brokers across all admins`);
                } else if (adminId !== 'me' && adminId !== '') {
                    console.log(`[getUsers] SUPERADMIN ${currentUserId} viewing brokers under Admin ID ${adminId}`);
                    whereClause += ' AND u.parent_id = ?';
                    params.push(adminId);
                } else {
                    console.log(`[getUsers] SUPERADMIN ${currentUserId} viewing their own direct brokers`);
                    whereClause += ' AND u.parent_id = ?';
                    params.push(currentUserId);
                }
            } else if (role === 'TRADER') {
                if (adminId && adminId !== 'all' && adminId !== 'me') {
                    whereClause += ' AND u.parent_id = ?';
                    params.push(adminId);
                } else {
                    whereClause += ' AND (u.parent_id = ? OR u.parent_id = 1 OR u.parent_id IS NULL)';
                    params.push(currentUserId);
                }
            } else {
                whereClause += ' AND u.parent_id = ?';
                params.push(currentUserId);
            }
        } else if (currentUserRole === 'ADMIN') {
            whereClause += ' AND (u.parent_id = ? OR u.id IN (SELECT user_id FROM client_settings WHERE broker_id IN (SELECT id FROM users WHERE parent_id = ?)))';
            params.push(currentUserId, currentUserId);
        } else if (currentUserRole === 'BROKER') {
            whereClause += ' AND (u.parent_id = ? OR u.id IN (SELECT user_id FROM client_settings WHERE broker_id = ?))';
            params.push(currentUserId, currentUserId);
        } else {
            whereClause += ' AND u.parent_id = ?';
            params.push(currentUserId);
        }

        // ── TOTAL COUNT: cached across page flips to avoid full-table scan every time ──
        let totalRecords = 0;
        try {
            const cachedTotal = await getFromCache(countCacheKey);
            if (cachedTotal !== null && cachedTotal !== undefined) {
                totalRecords = cachedTotal;
                console.log(`[getUsers] COUNT cache HIT: ${totalRecords}`);
            } else {
                const countQuery = `SELECT COUNT(*) as total FROM users u ${whereClause}`;
                const [countRows] = await db.execute(countQuery, params);
                totalRecords = countRows[0]?.total || 0;
                try { await saveToCache(countCacheKey, totalRecords, 300); } catch (_) { }
                console.log(`[getUsers] COUNT DB: ${totalRecords}`);
            }
        } catch (_) {
            const [countRows] = await db.execute(`SELECT COUNT(*) as total FROM users u ${whereClause}`, params);
            totalRecords = countRows[0]?.total || 0;
        }

        // ── OPTIMISED 3-STEP QUERY ──
        // Previous approach: LEFT JOIN on derived trades table → full-scans ALL millions of trade rows.
        // New approach:
        //   Step 1 → Get 50 user IDs for this page (users table only, instant)
        //   Step 2 → Aggregate trades WHERE user_id IN (50 IDs) — tiny targeted scan
        //   Step 3 → Fetch full user details for those 50 IDs only

        // ── STEP 1: Get paginated user IDs (users table only, no trades) ──
        const idQuery = `SELECT u.id FROM users u ${whereClause} ORDER BY u.id DESC LIMIT ? OFFSET ?`;
        const idParams = [...params, effectiveLimit, effectiveOffset];
        const [idRows] = await db.execute(idQuery, idParams);
        const pageUserIds = idRows.map(r => r.id);

        console.log(`[getUsers] Step1 got ${pageUserIds.length} IDs for page ${parsedPage}`);

        let rows = [];
        if (pageUserIds.length > 0) {
            const idPlaceholders = pageUserIds.map(() => '?').join(',');

            // ── STEP 2: Aggregate trades ONLY for these 50 user IDs ──
            let tradeClosedFilter = `status = 'CLOSED'`;
            if (fromDate && /^\d{4}-\d{2}-\d{2}/.test(fromDate)) {
                tradeClosedFilter += ` AND COALESCE(exit_time, entry_time) >= '${fromDate} 00:00:00'`;
            } else {
                tradeClosedFilter += ` AND COALESCE(exit_time, entry_time) >= '${week_start} 00:00:00'`;
            }
            if (toDate && /^\d{4}-\d{2}-\d{2}/.test(toDate)) {
                tradeClosedFilter += ` AND COALESCE(exit_time, entry_time) <= '${toDate} 23:59:59'`;
            }

            const tradeAggQuery = `
                SELECT
                    user_id,
                    SUM(CASE WHEN ${tradeClosedFilter} THEN pnl ELSE 0 END) as gross_pl,
                    SUM(CASE WHEN ${tradeClosedFilter} THEN brokerage ELSE 0 END) as brokerage,
                    SUM(CASE WHEN ${tradeClosedFilter} THEN swap ELSE 0 END) as swap_charges,
                    SUM(CASE WHEN ${tradeClosedFilter} THEN (pnl - brokerage - swap) ELSE 0 END) as net_pl,
                    SUM(CASE WHEN ${tradeClosedFilter} THEN 1 ELSE 0 END) as closed_trades_count,
                    SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as active_trades_count
                FROM trades
                WHERE user_id IN (${idPlaceholders})
                  AND status IN ('CLOSED', 'OPEN')
                GROUP BY user_id
            `;
            const [tradeRows] = await db.execute(tradeAggQuery, pageUserIds);
            // Index by user_id for O(1) merge
            const tradeStatsMap = {};
            tradeRows.forEach(r => { tradeStatsMap[r.user_id] = r; });

            // ── STEP 3: Fetch full user details for the 50 IDs (no trades) ──
            const fullQuery = `
                SELECT
                    u.*,
                    p.username as parent_username,
                    p.full_name as parent_name,
                    u.balance as ledger_balance,
                    u.credit_limit,
                    IFNULL(ud.kyc_status, 'PENDING') as kycStatus,
                    cs.config_json,
                    cs.broker_id
                FROM users u
                LEFT JOIN users p ON u.parent_id = p.id
                LEFT JOIN user_documents ud ON u.id = ud.user_id
                LEFT JOIN client_settings cs ON u.id = cs.user_id
                WHERE u.id IN (${idPlaceholders})
                ORDER BY u.id DESC
            `;
            const [userRows] = await db.execute(fullQuery, pageUserIds);

            // Merge trade stats into user rows
            rows = userRows.map(u => {
                const stats = tradeStatsMap[u.id] || {};
                return {
                    ...u,
                    gross_pl: parseFloat(stats.gross_pl || 0).toFixed(2),
                    brokerage: parseFloat(stats.brokerage || 0).toFixed(2),
                    swap_charges: parseFloat(stats.swap_charges || 0).toFixed(2),
                    net_pl: parseFloat(stats.net_pl || 0).toFixed(2),
                    closed_trades_count: parseInt(stats.closed_trades_count || 0),
                    active_trades_count: parseInt(stats.active_trades_count || 0),
                };
            });
        }

        console.log(`[getUsers] Returned ${rows.length} users (Total: ${totalRecords})`);
        res.setHeader('X-Total-Count', totalRecords);

        // If client specifically asked for pagination or passed page param, return full pagination payload
        if (paginate === 'true' || req.query.page !== undefined) {
            const resultPayload = {
                users: rows,
                total: totalRecords,
                page: parsedPage,
                limit: effectiveLimit,
                totalPages: Math.ceil(totalRecords / effectiveLimit)
            };
            try { await saveToCache(cacheKey, resultPayload, 120); } catch (_) { }
            return res.json(resultPayload);
        }

        // Default: return array for backward compatibility with existing callers
        try { await saveToCache(cacheKey, rows, 120); } catch (_) { }
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};


const getUserProfile = async (req, res) => {
    try {
        const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
        const { week_start } = getWeekBoundaries(getISTDate());

        const [userRows] = await db.execute(`
            SELECT 
                u.*,
                p.username as parent_username,
                p.full_name as parent_name,
                p.role as parent_role,
                b.id as assigned_broker_id,
                b.username as assigned_broker_username,
                b.full_name as assigned_broker_name,
                IFNULL((SELECT SUM(pnl) FROM trades WHERE user_id = u.id AND status = 'CLOSED' AND COALESCE(exit_time, entry_time) >= COALESCE(u.last_reset_at, '${week_start} 00:00:00')), 0.00) as gross_pl,
                IFNULL((SELECT SUM(brokerage) FROM trades WHERE user_id = u.id AND status = 'CLOSED' AND COALESCE(exit_time, entry_time) >= COALESCE(u.last_reset_at, '${week_start} 00:00:00')), 0.00) as brokerage,
                IFNULL((SELECT SUM(swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED' AND COALESCE(exit_time, entry_time) >= COALESCE(u.last_reset_at, '${week_start} 00:00:00')), 0.00) as swap_charges,
                IFNULL((SELECT SUM(pnl - brokerage - swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED' AND COALESCE(exit_time, entry_time) >= COALESCE(u.last_reset_at, '${week_start} 00:00:00')), 0.00) as net_pl
            FROM users u 
            LEFT JOIN users p ON u.parent_id = p.id
            LEFT JOIN client_settings cs ON u.id = cs.user_id
            LEFT JOIN users b ON cs.broker_id = b.id
            WHERE u.id = ?
        `, [req.params.id]);
        if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });

        const [settingsRows] = await db.execute('SELECT * FROM client_settings WHERE user_id = ?', [req.params.id]);
        const [brokerSharesRows] = await db.execute('SELECT * FROM broker_shares WHERE user_id = ?', [req.params.id]);
        const [segmentRows] = await db.execute('SELECT * FROM user_segments WHERE user_id = ?', [req.params.id]);
        const [docRows] = await db.execute('SELECT * FROM user_documents WHERE user_id = ?', [req.params.id]);

        const settings = settingsRows[0] || {};
        if (settings.config_json) {
            try { settings.config = JSON.parse(settings.config_json); } catch (e) { settings.config = {}; }
        }

        const profile = userRows[0];
        // If assigned_broker_username is not populated via cs.broker_id, try config.broker or config.masterBroker
        if (!profile.assigned_broker_username && settings.config) {
            const rawBroker = settings.config.broker || settings.config.masterBroker;
            if (rawBroker) {
                const brokerIdMatch = String(rawBroker).match(/^(\d+)/);
                if (brokerIdMatch) {
                    const [bRows] = await db.execute('SELECT id, username, full_name FROM users WHERE id = ?', [brokerIdMatch[1]]);
                    if (bRows.length > 0) {
                        profile.assigned_broker_id = bRows[0].id;
                        profile.assigned_broker_username = bRows[0].username;
                        profile.assigned_broker_name = bRows[0].full_name;
                    }
                } else {
                    const [bRows] = await db.execute('SELECT id, username, full_name FROM users WHERE username = ? OR full_name = ?', [rawBroker, rawBroker]);
                    if (bRows.length > 0) {
                        profile.assigned_broker_id = bRows[0].id;
                        profile.assigned_broker_username = bRows[0].username;
                        profile.assigned_broker_name = bRows[0].full_name;
                    }
                }
            }
        }

        const brokerShares = brokerSharesRows[0] || {};
        if (brokerShares.permissions_json) {
            try { brokerShares.permissions = JSON.parse(brokerShares.permissions_json); } catch (e) { brokerShares.permissions = {}; }
        }
        if (brokerShares.segments_json) {
            try { brokerShares.segments = JSON.parse(brokerShares.segments_json); } catch (e) { brokerShares.segments = {}; }
        }

        res.json({
            profile: userRows[0],
            settings,
            brokerShares,
            segments: segmentRows,
            documents: docRows[0] || {}
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateStatus = async (req, res) => {
    const { status } = req.body;
    const targetUserId = req.params.id;
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role;
    try {
        // Brokers can only update status for their own created users or assigned clients
        if (currentUserRole === 'BROKER') {
            const [userRows] = await db.execute(
                'SELECT id FROM users WHERE id = ? AND (parent_id = ? OR broker_id = ?)',
                [targetUserId, currentUserId, currentUserId]
            );
            if (userRows.length === 0) {
                return res.status(403).json({ message: 'You can only update status for your own clients' });
            }
        }

        await db.execute('UPDATE users SET status = ? WHERE id = ?', [status, targetUserId]);

        // Log the action
        await logAction(currentUserId, 'UPDATE_STATUS', 'users', `Updated status of user ID ${targetUserId} to ${status}`);

        // Invalidate caches
        try {
            await invalidateCache(`users_${currentUserId}_all`);
            await invalidateCache(`users_${currentUserId}_TRADER`);
            await invalidateCache(`users_${currentUserId}_BROKER`);
        } catch (e) { }

        res.json({ message: 'Status updated successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

const resetPassword = async (req, res) => {
    const { newPassword } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);

        // Log the action
        await logAction(req.user.id, 'RESET_PASSWORD', 'users', `Reset password for user ID ${req.params.id}`);

        res.json({ message: 'Password reset successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updatePasswords = async (req, res) => {
    const { newPassword, transactionPassword } = req.body;
    try {
        if (newPassword) {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);
        }
        if (transactionPassword) {
            const hashedTransPassword = await bcrypt.hash(transactionPassword, 10);
            await db.execute('UPDATE users SET transaction_password = ? WHERE id = ?', [hashedTransPassword, req.params.id]);
        }
        res.json({ message: 'Passwords updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const deleteUser = async (req, res) => {
    try {
        const targetUserId = req.params.id;
        const currentUserId = req.user.id;
        const currentUserRole = req.user.role;

        // Brokers can only delete their own created users or assigned clients
        if (currentUserRole === 'BROKER') {
            const [userRows] = await db.execute(
                'SELECT id FROM users WHERE id = ? AND (parent_id = ? OR broker_id = ?)',
                [targetUserId, currentUserId, currentUserId]
            );
            if (userRows.length === 0) {
                return res.status(403).json({ message: 'You can only delete your own clients' });
            }
        }

        await db.execute('DELETE FROM users WHERE id = ?', [targetUserId]);

        // Log the action
        await logAction(currentUserId, 'DELETE_USER', 'users', `Deleted user ID ${targetUserId}`);

        // Invalidate caches
        try {
            await invalidateCache(`users_${currentUserId}_all`);
            await invalidateCache(`users_${currentUserId}_TRADER`);
            await invalidateCache(`users_${currentUserId}_BROKER`);
        } catch (e) { }

        res.json({ message: 'User deleted successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── UPDATE USER PROFILE ─────────────────────────────
const updateUser = async (req, res) => {
    const { fullName, email, mobile, city, creditLimit, exposureMultiplier, isDemo, status, parentId } = req.body;
    try {
        const fields = [];
        const values = [];

        if (fullName !== undefined) { fields.push('full_name = ?'); values.push(fullName); }
        if (email !== undefined) { fields.push('email = ?'); values.push(email); }
        if (mobile !== undefined) { fields.push('mobile = ?'); values.push(mobile); }
        if (city !== undefined) { fields.push('city = ?'); values.push(city); }
        if (creditLimit !== undefined) { fields.push('credit_limit = ?'); values.push(creditLimit); }
        if (exposureMultiplier !== undefined) { fields.push('exposure_multiplier = ?'); values.push(exposureMultiplier); }
        if (isDemo !== undefined) { fields.push('is_demo = ?'); values.push(isDemo ? 1 : 0); }
        if (status !== undefined) { fields.push('status = ?'); values.push(status); }
        if (parentId !== undefined) { fields.push('parent_id = ?'); values.push(parseInt(parentId) || null); }

        if (fields.length === 0) return res.status(400).json({ message: 'No fields to update' });

        values.push(req.params.id);
        await db.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

        // Log the action with summary of changes
        const summary = Object.keys(req.body).join(', ');
        await logAction(req.user.id, 'UPDATE_USER', 'users', `Updated user ID ${req.params.id}: modified ${summary}`);

        // Invalidate ALL user list caches to ensure consistency across all admins/brokers
        try {
            await invalidateCache(`users_${req.user.id}_all`);
            await invalidateCache(`users_${req.user.id}_TRADER`);
            await invalidateCache(`users_${req.user.id}_BROKER`);

            // Also invalidate the parent's cache if different
            if (parentId && parseInt(parentId) !== req.user.id) {
                await invalidateCache(`users_${parentId}_all`);
                await invalidateCache(`users_${parentId}_TRADER`);
                await invalidateCache(`users_${parentId}_BROKER`);
            }

            console.log(`[Cache] Cleared user list caches for updater ${req.user.id}`);
        } catch (e) {
            console.log(`[Cache] Clear failed but update succeeded`);
        }

        res.json({ message: 'User updated successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── CLIENT SETTINGS ─────────────────────────────────
const updateClientSettings = async (req, res) => {
    console.log('[DEBUG] REACHED updateClientSettings for user:', req.params.id);
    const {
        allowFreshEntry, allowOrdersBetweenHL, tradeEquityUnits,
        autoCloseEnabled, banAllSegmentLimitOrder,
        autoClosePct, notifyPct, minProfitTime, scalpingSlEnabled,
        brokerId,  // Broker assignment
        config  // full complex config JSON (all segment data)
    } = req.body;

    try {
        let configObj = config || {};
        if (autoCloseEnabled !== undefined) configObj.autoCloseEnabled = autoCloseEnabled;

        // ─── If broker is assigned, fetch & apply broker's segment config ─────
        if (brokerId) {
            console.log(`[updateClientSettings] Broker assigned (ID: ${brokerId}). Fetching broker's segment config...`);
            const [brokerSharesRows] = await db.execute(
                'SELECT segments_json FROM broker_shares WHERE user_id = ?',
                [brokerId]
            );

            if (brokerSharesRows.length > 0 && brokerSharesRows[0].segments_json) {
                try {
                    const brokerSegments = JSON.parse(brokerSharesRows[0].segments_json);
                    if (brokerSegments.segmentConfig) {
                        console.log(`[updateClientSettings] ✅ Applied broker's segment config to client`);
                        // Apply broker's segment configuration to client
                        configObj.brokerSegments = brokerSegments.segmentConfig;
                        configObj.brokerMcxMargins = brokerSegments.mcxMargins || {};
                        configObj.brokerMcxBrokerage = brokerSegments.mcxBrokerage || {};
                    }
                } catch (e) {
                    console.error(`[updateClientSettings] Failed to parse broker segments:`, e);
                }
            }
        }

        const configJson = Object.keys(configObj).length > 0 ? JSON.stringify(configObj) : null;

        const sqlParams = [
            req.params.id,
            allowFreshEntry !== undefined ? (allowFreshEntry == 1 || allowFreshEntry === true || allowFreshEntry === 'true' ? 1 : 0) : 1,
            allowOrdersBetweenHL !== undefined ? (allowOrdersBetweenHL == 1 || allowOrdersBetweenHL === true || allowOrdersBetweenHL === 'true' ? 1 : 0) : 1,
            tradeEquityUnits !== undefined ? (tradeEquityUnits == 1 || tradeEquityUnits === true || tradeEquityUnits === 'true' ? 1 : 0) : 0,
            autoClosePct !== undefined ? autoClosePct : 90,
            notifyPct !== undefined ? notifyPct : 70,
            minProfitTime !== undefined && minProfitTime !== '' ? parseInt(minProfitTime, 10) : (
                configObj.minTimeToBookProfit !== undefined && configObj.minTimeToBookProfit !== '' ? parseInt(configObj.minTimeToBookProfit, 10) : (
                    configObj.equityMinTimeToBookProfit !== undefined && configObj.equityMinTimeToBookProfit !== '' ? parseInt(configObj.equityMinTimeToBookProfit, 10) : (
                        configObj.mcxMinTimeToBookProfit !== undefined && configObj.mcxMinTimeToBookProfit !== '' ? parseInt(configObj.mcxMinTimeToBookProfit, 10) : 0
                    )
                )
            ),
            scalpingSlEnabled !== undefined ? (scalpingSlEnabled === true || scalpingSlEnabled === 'Enabled' || scalpingSlEnabled == 1 ? 1 : 0) : 0,
            banAllSegmentLimitOrder !== undefined ? (banAllSegmentLimitOrder == 1 || banAllSegmentLimitOrder === true || banAllSegmentLimitOrder === 'true' ? 1 : 0) : 0,
            configJson,
            brokerId || null
        ];
        console.log('[DEBUG] SQL Params for Client Settings:', sqlParams);

        await db.execute(`
            INSERT INTO client_settings
                (user_id, allow_fresh_entry, allow_orders_between_hl, trade_equity_units,
                 auto_close_at_m2m_pct, notify_at_m2m_pct, min_time_to_book_profit,
                 scalping_sl_enabled, ban_all_segment_limit_order, config_json, broker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                allow_fresh_entry = VALUES(allow_fresh_entry),
                allow_orders_between_hl = VALUES(allow_orders_between_hl),
                trade_equity_units = VALUES(trade_equity_units),
                auto_close_at_m2m_pct = VALUES(auto_close_at_m2m_pct),
                notify_at_m2m_pct = VALUES(notify_at_m2m_pct),
                min_time_to_book_profit = VALUES(min_time_to_book_profit),
                scalping_sl_enabled = VALUES(scalping_sl_enabled),
                ban_all_segment_limit_order = VALUES(ban_all_segment_limit_order),
                config_json = VALUES(config_json),
                broker_id = VALUES(broker_id)
        `, sqlParams);

        clearSegmentCache(req.params.id);

        // ─── SYNC to user_segments table for mobile app consistency ─────
        if (configObj) {
            const userId = req.params.id;
            const segmentsToSync = [
                { name: 'MCX', enabled: configObj.mcxTrading, bType: configObj.mcxBrokerageType, bVal: configObj.mcxBrokerage, maxLot: configObj.mcxMaxLotScrip, exp: configObj.mcxExposureMultiplier },
                { name: 'MCX_OPT', enabled: configObj.mcxOptionsTrading, bType: 'PER_LOT', bVal: 0, maxLot: 0, exp: 1 },
                { name: 'EQUITY', enabled: configObj.equityTrading, bType: 'PER_LOT', bVal: configObj.equityBrokerage, maxLot: configObj.equityMaxScrip, exp: configObj.equityExposureMultiplier },
                { name: 'OPTIONS', enabled: configObj.indexOptionsTrading || configObj.equityOptionsTrading, bType: configObj.optionsIndexBrokerageType, bVal: configObj.optionsIndexBrokerage, maxLot: configObj.optionsIndexMaxScrip, exp: 1 },
                { name: 'COMEX', enabled: configObj.comexTrading, bType: configObj.comexConfig?.brokerageType || 'PER_LOT', bVal: configObj.comexConfig?.brokerage || configObj.comexBrokerage, maxLot: configObj.comexConfig?.maxLotScrip || configObj.maxLotComex, exp: 1 },
                { name: 'FOREX', enabled: configObj.forexTrading, bType: configObj.forexConfig?.brokerageType || 'PER_LOT', bVal: configObj.forexConfig?.brokerage || configObj.forexBrokerage, maxLot: configObj.forexConfig?.maxLotScrip || configObj.maxLotForex, exp: 1 },
                { name: 'CRYPTO', enabled: configObj.cryptoTrading, bType: configObj.cryptoConfig?.brokerageType || 'PER_LOT', bVal: configObj.cryptoConfig?.brokerage || configObj.cryptoBrokerage, maxLot: configObj.cryptoConfig?.maxLotScrip || configObj.maxLotCrypto, exp: 1 }
            ];

            console.log('[updateClientSettings] Syncing segments for user', userId, ':', segmentsToSync.map(s => ({ name: s.name, enabled: s.enabled, bVal: s.bVal, maxLot: s.maxLot })));

            for (const s of segmentsToSync) {
                if (s.enabled !== undefined || s.bVal !== undefined) {
                    await db.execute(`
                        INSERT INTO user_segments (user_id, segment, is_enabled, brokerage_type, brokerage_value, max_lot_per_scrip, exposure_multiplier)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            is_enabled = IFNULL(VALUES(is_enabled), is_enabled),
                            brokerage_type = IFNULL(VALUES(brokerage_type), brokerage_type),
                            brokerage_value = IFNULL(VALUES(brokerage_value), brokerage_value),
                            max_lot_per_scrip = IFNULL(VALUES(max_lot_per_scrip), max_lot_per_scrip),
                            exposure_multiplier = IFNULL(VALUES(exposure_multiplier), exposure_multiplier)
                    `, [userId, s.name, s.enabled ? 1 : 0, s.bType || 'PER_LOT', s.bVal || 0, s.maxLot || 10, s.exp || 1]);
                }
            }
        }

        res.json({ message: 'Client settings updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── BROKER SHARES ───────────────────────────────────
const getBrokerShares = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM broker_shares WHERE user_id = ?', [req.params.id]);
        const data = rows[0] || {};
        if (data.permissions_json) {
            try { data.permissions = JSON.parse(data.permissions_json); } catch (e) { data.permissions = {}; }
        }
        if (data.segments_json) {
            try { data.segments = JSON.parse(data.segments_json); } catch (e) { data.segments = {}; }
        }
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateBrokerShares = async (req, res) => {
    const {
        sharePL, shareBrokerage, shareSwap, brokerageType,
        tradingClientsLimit, subBrokersLimit, permissions, segments, swapRate
    } = req.body;

    try {
        await db.execute(`
            INSERT INTO broker_shares
                (user_id, share_pl_pct, share_brokerage_pct, share_swap_pct,
                 brokerage_type, trading_clients_limit, sub_brokers_limit,
                 permissions_json, segments_json, swap_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                share_pl_pct = VALUES(share_pl_pct),
                share_brokerage_pct = VALUES(share_brokerage_pct),
                share_swap_pct = VALUES(share_swap_pct),
                brokerage_type = VALUES(brokerage_type),
                trading_clients_limit = VALUES(trading_clients_limit),
                sub_brokers_limit = VALUES(sub_brokers_limit),
                permissions_json = VALUES(permissions_json),
                segments_json = VALUES(segments_json),
                swap_rate = VALUES(swap_rate)
        `, [
            req.params.id,
            sharePL || 0,
            shareBrokerage || 50,
            shareSwap || 10,
            brokerageType || 'Percentage',
            tradingClientsLimit || 10,
            subBrokersLimit || 3,
            permissions ? JSON.stringify(permissions) : null,
            segments ? JSON.stringify(segments) : null,
            swapRate || 5  // Default ₹5 per lot per day
        ]);

        res.json({ message: 'Broker shares updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── DOCUMENTS ───────────────────────────────────────
const getDocuments = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM user_documents WHERE user_id = ?', [req.params.id]);
        res.json(rows[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateDocuments = async (req, res) => {
    const { panNumber, aadharNumber, kycStatus } = req.body;
    const files = req.files || {};

    try {
        // Upload files to ImageKit
        let panScreenshot, aadharFront, aadharBack, bankProof;

        if (files.panScreenshot && files.panScreenshot[0]) {
            const result = await uploadFile(files.panScreenshot[0].buffer, files.panScreenshot[0].originalname, `/traders/kyc/${req.params.id}`);
            panScreenshot = result.url;
        }
        if (files.aadharFront && files.aadharFront[0]) {
            const result = await uploadFile(files.aadharFront[0].buffer, files.aadharFront[0].originalname, `/traders/kyc/${req.params.id}`);
            aadharFront = result.url;
        }
        if (files.aadharBack && files.aadharBack[0]) {
            const result = await uploadFile(files.aadharBack[0].buffer, files.aadharBack[0].originalname, `/traders/kyc/${req.params.id}`);
            aadharBack = result.url;
        }
        if (files.bankProof && files.bankProof[0]) {
            const result = await uploadFile(files.bankProof[0].buffer, files.bankProof[0].originalname, `/traders/kyc/${req.params.id}`);
            bankProof = result.url;
        }

        // Build dynamic upsert
        const setFields = ['user_id = ?'];
        const values = [req.params.id];

        if (panNumber !== undefined) { setFields.push('pan_number = ?'); values.push(panNumber); }
        if (aadharNumber !== undefined) { setFields.push('aadhar_number = ?'); values.push(aadharNumber); }
        if (kycStatus !== undefined) { setFields.push('kyc_status = ?'); values.push(kycStatus); }
        if (panScreenshot !== undefined) { setFields.push('pan_screenshot = ?'); values.push(panScreenshot); }
        if (aadharFront !== undefined) { setFields.push('aadhar_front = ?'); values.push(aadharFront); }
        if (aadharBack !== undefined) { setFields.push('aadhar_back = ?'); values.push(aadharBack); }
        if (bankProof !== undefined) { setFields.push('bank_proof = ?'); values.push(bankProof); }

        // Safety: If no documents are being updated (only user_id is in setFields), return early
        if (setFields.length <= 1 && panNumber === undefined && aadharNumber === undefined && kycStatus === undefined) {
            return res.json({ message: 'No changes detected' });
        }

        await db.execute(`
            INSERT INTO user_documents (${setFields.map(f => f.split(' = ?')[0]).join(', ')})
            VALUES (${values.map(() => '?').join(', ')})
            ON DUPLICATE KEY UPDATE
                ${setFields.filter(f => !f.startsWith('user_id')).join(', ')}
        `, [...values, ...values.slice(1).filter((v, i) => !setFields[i + 1].startsWith('user_id'))]);

        // Return the uploaded URLs so frontend can display them
        res.json({
            message: 'Documents updated',
            urls: {
                panScreenshot: panScreenshot || undefined,
                aadharFront: aadharFront || undefined,
                aadharBack: aadharBack || undefined,
                bankProof: bankProof || undefined
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── USER SEGMENTS ───────────────────────────────────
const getUserSegments = async (req, res) => {
    try {
        const [settingsRows] = await db.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [req.params.id]);

        if (settingsRows.length > 0 && settingsRows[0].config_json) {
            try {
                const config = JSON.parse(settingsRows[0].config_json);

                const mappedSegments = [
                    { segment: 'MCX', is_enabled: config.mcxTrading ? 1 : 0, brokerage_type: config.mcxBrokerageType || 'PER_LOT', brokerage_value: config.mcxBrokerage || 0, max_lot_per_scrip: config.mcxMaxLotScrip || 0, exposure_multiplier: config.mcxExposureMultiplier || 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                    { segment: 'EQUITY', is_enabled: config.equityTrading ? 1 : 0, brokerage_type: 'PER_LOT', brokerage_value: config.equityBrokerage || 0, max_lot_per_scrip: config.equityMaxScrip || 0, exposure_multiplier: config.equityExposureMultiplier || 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                    { segment: 'OPTIONS', is_enabled: (config.indexOptionsTrading || config.equityOptionsTrading) ? 1 : 0, brokerage_type: config.optionsIndexBrokerageType || 'PER_LOT', brokerage_value: config.optionsIndexBrokerage || 0, max_lot_per_scrip: config.optionsIndexMaxScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                    { segment: 'COMEX', is_enabled: config.comexTrading ? 1 : 0, brokerage_type: config.comexConfig?.brokerageType || 'PER_LOT', brokerage_value: config.comexConfig?.brokerage || 0, max_lot_per_scrip: config.comexConfig?.maxLotScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                    { segment: 'FOREX', is_enabled: config.forexTrading ? 1 : 0, brokerage_type: config.forexConfig?.brokerageType || 'PER_LOT', brokerage_value: config.forexConfig?.brokerage || 0, max_lot_per_scrip: config.forexConfig?.maxLotScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                    { segment: 'CRYPTO', is_enabled: config.cryptoTrading ? 1 : 0, brokerage_type: config.cryptoConfig?.brokerageType || 'PER_LOT', brokerage_value: config.cryptoConfig?.brokerage || 0, max_lot_per_scrip: config.cryptoConfig?.maxLotScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime }
                ];

                const finalSegments = mappedSegments.filter(s => s.is_enabled === 1);
                return res.json(finalSegments);
            } catch (e) {
                console.error('[getUserSegments] Parse failed:', e);
            }
        }

        let [rows] = await db.execute('SELECT * FROM user_segments WHERE user_id = ? AND is_enabled = 1', [req.params.id]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateUserSegments = async (req, res) => {
    // segments: array of { segment, isEnabled, brokerageType, brokerageValue, leverage, maxLotPerScrip, marginType, exposureMultiplier, autoSquareOff, squareOffTime }
    const { segments } = req.body;
    if (!Array.isArray(segments)) return res.status(400).json({ message: 'segments must be an array' });

    try {
        for (const seg of segments) {
            await db.execute(`
                INSERT INTO user_segments
                    (user_id, segment, is_enabled, brokerage_type, brokerage_value,
                     leverage, max_lot_per_scrip, margin_type, exposure_multiplier,
                     auto_square_off, square_off_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    is_enabled = VALUES(is_enabled),
                    brokerage_type = VALUES(brokerage_type),
                    brokerage_value = VALUES(brokerage_value),
                    leverage = VALUES(leverage),
                    max_lot_per_scrip = VALUES(max_lot_per_scrip),
                    margin_type = VALUES(margin_type),
                    exposure_multiplier = VALUES(exposure_multiplier),
                    auto_square_off = VALUES(auto_square_off),
                    square_off_time = VALUES(square_off_time)
            `, [
                req.params.id,
                seg.segment,
                seg.isEnabled ? 1 : 0,
                seg.brokerageType || 'PER_LOT',
                seg.brokerageValue || 0,
                seg.leverage || 1,
                seg.maxLotPerScrip || 10,
                seg.marginType || 'PER_LOT',
                seg.exposureMultiplier || 1,
                seg.autoSquareOff ? 1 : 0,
                seg.squareOffTime || null
            ]);
        }
        res.json({ message: 'Segments updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getBrokerClients = async (req, res) => {
    try {
        const brokerId = req.params.id;
        const brokerIdStr = String(brokerId);

        const [rows] = await db.execute(
            `SELECT u.id, u.username, u.full_name, u.email, u.mobile, u.status, u.role,
                    u.balance as ledger_balance, u.created_at, u.is_demo,
                    p.username as parent_username,
                    IFNULL((SELECT SUM(pnl) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as gross_pl,
                    IFNULL((SELECT SUM(brokerage) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as brokerage,
                    IFNULL((SELECT SUM(swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as swap_charges,
                    IFNULL((SELECT SUM(pnl - brokerage - swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as net_pl
             FROM users u
             LEFT JOIN client_settings cs ON cs.user_id = u.id
             LEFT JOIN users p ON u.parent_id = p.id
             WHERE u.role = 'TRADER' AND (
                u.parent_id = ?
                OR cs.broker_id = ?
                OR cs.config_json LIKE CONCAT('%"broker":"', ?, ' :%')
             )
             ORDER BY u.id ASC`,
            [brokerId, brokerId, brokerIdStr]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

/**
 * Reset Account — deletes all trades, refunds margin, resets PnL for a user
 * Ledger balance and fund transactions remain untouched
 */
const resetAccount = async (req, res) => {
    const userId = req.params.id;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get all OPEN trades to refund margin
        const [openTrades] = await connection.execute(
            'SELECT SUM(margin_used) as totalMargin FROM trades WHERE user_id = ? AND status = "OPEN"',
            [userId]
        );
        const marginToRefund = parseFloat(openTrades[0]?.totalMargin || 0);

        // 2. Delete all trades for this user
        const [deleteResult] = await connection.execute(
            'DELETE FROM trades WHERE user_id = ?', [userId]
        );

        // 3. Refund locked margin back to balance
        if (marginToRefund > 0) {
            await connection.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [marginToRefund, userId]
            );
        }

        await connection.commit();

        await logAction(req.user.id, 'RESET_ACCOUNT', 'users',
            `Reset account for user #${userId}. Deleted ${deleteResult.affectedRows} trades, refunded margin: ${marginToRefund}`);

        res.json({
            message: 'Account reset successfully',
            tradesDeleted: deleteResult.affectedRows,
            marginRefunded: marginToRefund
        });
    } catch (err) {
        await connection.rollback();
        console.error('Reset Account Error:', err);
        res.status(500).json({ message: 'Failed to reset account' });
    } finally {
        connection.release();
    }
};

/**
 * Recalculate Brokerage — recalculates brokerage for all closed trades of a user
 * Uses broker's lot-wise brokerage configuration if available
 */
const recalculateBrokerage = async (req, res) => {
    const userId = req.params.id;
    try {
        // Get user's client settings for brokerage config
        const [settingsRows] = await db.execute(
            'SELECT config_json FROM client_settings WHERE user_id = ?', [userId]
        );
        const config = settingsRows.length > 0 ? JSON.parse(settingsRows[0].config_json || '{}') : {};

        // Get all closed trades with market_type, qty, lot and mode columns
        const [trades] = await db.execute(
            'SELECT id, symbol, qty, entry_price, exit_price, type, market_type, qty_input, actual_qty, lot_size_at_entry, trade_mode, equity_units_mode FROM trades WHERE user_id = ? AND status = "CLOSED"',
            [userId]
        );

        // Fetch all segment settings for this user once
        const [segmentSettings] = await db.execute('SELECT * FROM user_segments WHERE user_id = ?', [userId]);
        const segmentMap = {};
        segmentSettings.forEach(s => segmentMap[s.segment] = s);

        let totalBrokerage = 0;

        for (const trade of trades) {
            const mType = (trade.market_type || 'MCX').toUpperCase();
            const seg = segmentMap[mType] || segmentMap[trade.market_type] || segmentMap['MCX'];

            let brokerage = calculateTradeBrokerage({
                symbol: trade.symbol,
                marketType: mType,
                entryPrice: parseFloat(trade.entry_price || 0),
                exitPrice: parseFloat(trade.exit_price || trade.entry_price || 0),
                qty: parseFloat(trade.qty || 0),
                qtyInput: trade.qty_input != null ? parseFloat(trade.qty_input) : null,
                actualQty: trade.actual_qty != null ? parseFloat(trade.actual_qty) : null,
                lotSize: parseFloat(trade.lot_size_at_entry || 1),
                tradeMode: trade.trade_mode,
                equityUnitsMode: trade.equity_units_mode,
                clientConfig: config,
                userSegmentRow: seg
            });

            brokerage = Math.max(0, parseFloat(brokerage || 0));
            totalBrokerage += brokerage;
            await db.execute('UPDATE trades SET brokerage = ? WHERE id = ?', [brokerage.toFixed(2), trade.id]);
        }

        await logAction(req.user.id, 'RECALCULATE_BROKERAGE', 'users',
            `Recalculated brokerage for user #${userId}. Total: ${totalBrokerage.toFixed(2)} across ${trades.length} trades`);

        res.json({
            message: 'Brokerage recalculated successfully',
            tradesUpdated: trades.length,
            totalBrokerage: totalBrokerage.toFixed(2)
        });
    } catch (err) {
        console.error('Recalculate Brokerage Error:', err);
        res.status(500).json({ message: 'Failed to recalculate brokerage' });
    }
};

/**
 * Save user watchlist (pinned symbols)
 */
const saveWatchlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const { watchlist } = req.body; // Array of symbols

        if (!Array.isArray(watchlist)) {
            return res.status(400).json({ message: 'Watchlist must be an array of symbols' });
        }

        await db.execute(`
            INSERT INTO client_settings (user_id, watchlist_json)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE watchlist_json = VALUES(watchlist_json)
        `, [userId, JSON.stringify(watchlist)]);

        res.json({ message: 'Watchlist saved successfully' });
    } catch (err) {
        console.error('Save Watchlist Error:', err);
        res.status(500).json({ message: 'Failed to save watchlist' });
    }
};

/**
 * Get user watchlist
 */
const getWatchlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const [rows] = await db.execute('SELECT watchlist_json FROM client_settings WHERE user_id = ?', [userId]);

        if (!rows.length || !rows[0].watchlist_json) {
            return res.json([]);
        }

        const watchlist = typeof rows[0].watchlist_json === 'string'
            ? JSON.parse(rows[0].watchlist_json)
            : rows[0].watchlist_json;

        res.json(watchlist);
    } catch (err) {
        console.error('Get Watchlist Error:', err);
        res.status(500).json({ message: 'Failed to fetch watchlist' });
    }
};

/**
 * Get user weekly balance (opening/closing balance for current week)
 */
const getWeeklyBalance = async (req, res) => {
    try {
        const userId = req.params.id;
        const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
        const { week_start, week_end } = getWeekBoundaries(getISTDate());
        // 1. First check weekly_settlements table for latest completed settlement
        const [settlementRows] = await db.execute(
            'SELECT * FROM weekly_settlements WHERE user_id = ? AND settlement_status = "COMPLETED" ORDER BY week_end_date DESC LIMIT 1',
            [userId]
        );

        if (settlementRows.length > 0) {
            const s = settlementRows[0];
            return res.json({
                user_id: parseInt(userId),
                week_start: s.week_start_date,
                week_end: s.week_end_date,
                opening_balance: parseFloat(s.opening_balance),
                closing_balance: parseFloat(s.closing_balance)
            });
        }

        // 2. Fetch the record for the current week from weekly_balances
        const [rows] = await db.execute(
            'SELECT * FROM weekly_balances WHERE user_id = ? AND week_end = ?',
            [userId, week_end]
        );

        let weeklyBalance = null;
        if (rows.length > 0) {
            weeklyBalance = rows[0];
        } else {
            // If the weekly closing has not run for this week yet, get the latest available record
            const [latestRows] = await db.execute(
                'SELECT * FROM weekly_balances WHERE user_id = ? ORDER BY week_end DESC LIMIT 1',
                [userId]
            );

            if (latestRows.length > 0) {
                // If there's a previous record, the opening balance for the current week is that week's closing balance
                weeklyBalance = {
                    user_id: parseInt(userId),
                    week_start,
                    week_end,
                    opening_balance: parseFloat(latestRows[0].closing_balance),
                    closing_balance: 0 // Not closed yet
                };
            } else {
                // Otherwise fall back to the user's current balance
                const [userRows] = await db.execute('SELECT balance, credit_limit FROM users WHERE id = ?', [userId]);
                const opening = userRows.length > 0 ? parseFloat(userRows[0].balance || 0) : 0;
                weeklyBalance = {
                    user_id: parseInt(userId),
                    week_start,
                    week_end,
                    opening_balance: opening,
                    closing_balance: opening
                };
            }
        }

        res.json(weeklyBalance);
    } catch (err) {
        console.error('Get Weekly Balance Error:', err);
        res.status(500).json({ message: 'Failed to fetch weekly balance' });
    }
};

module.exports = {
    getUsers, getUserProfile, updateStatus, resetPassword, deleteUser, updatePasswords,
    updateUser, updateClientSettings, getBrokerShares, updateBrokerShares,
    getDocuments, updateDocuments, getUserSegments, updateUserSegments, getBrokerClients,
    resetAccount, recalculateBrokerage,
    saveWatchlist, getWatchlist, getWeeklyBalance
};
