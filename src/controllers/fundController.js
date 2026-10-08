const db = require('../config/db');
const { logAction } = require('./systemController');
const { invalidateCache } = require('../utils/cacheManager');
const MarginUtils = require('../utils/MarginUtils');

const createFund = async (req, res) => {
    const { userId, amount, notes, mode } = req.body;
    const type = mode === 'deposit' ? 'DEPOSIT' : 'WITHDRAW';
    const role = req.user.role;
    const loggedInId = req.user.id;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get Current Balance + verify ownership
        const [userRows] = await connection.execute('SELECT balance, parent_id FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (userRows.length === 0) throw new Error('User not found');

        // Broker can only fund their own directly assigned clients
        if (role === 'BROKER' && userRows[0].parent_id !== loggedInId) {
            await connection.rollback();
            return res.status(403).json({ message: 'You can only manage funds for your own clients' });
        }

        const currentBalance = parseFloat(userRows[0].balance || 0);
        const amountNum = Math.abs(parseFloat(amount));
        if (isNaN(amountNum) || amountNum <= 0) {
            await connection.rollback();
            return res.status(400).json({ message: 'Amount must be a valid number greater than 0' });
        }
        
        if (type === 'WITHDRAW') {
            const [trades] = await connection.execute('SELECT * FROM trades WHERE user_id = ? AND status = "OPEN"', [userId]);
            const [settings] = await connection.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [userId]);
            const clientConfig = settings.length > 0 ? JSON.parse(settings[0].config_json || '{}') : {};

            const blockedMargin = MarginUtils.calculateTotalRequiredHoldingMargin(trades, clientConfig);
            const withdrawable = currentBalance - blockedMargin;

            if (amountNum > withdrawable) {
                await connection.rollback();
                return res.status(400).json({ 
                    message: `Insufficient Withdrawable Balance. Client has open positions requiring holding margin.`,
                    details: {
                        ledgerBalance: currentBalance.toFixed(2),
                        blockedMargin: blockedMargin.toFixed(2),
                        withdrawable: withdrawable.toFixed(2)
                    }
                });
            }
        }

        const newBalance = type === 'DEPOSIT' ? currentBalance + amountNum : currentBalance - amountNum;

        // 2. Record in Ledger
        await connection.execute(
            'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
            [userId, amountNum, type, newBalance, notes]
        );

        // 3. Update User Balance
        await connection.execute(
            'UPDATE users SET balance = ? WHERE id = ?',
            [newBalance, userId]
        );

        await connection.commit();

        // Clear cache on fund transaction (Option A - immediate consistency)
        try {
            await invalidateCache(`users_${userId}_all`);
            await invalidateCache(`m2m_${userId}_TRADER`);
            await invalidateCache(`m2m_${userId}_SUPERADMIN`);
        } catch (e) {
            console.log(`[Cache] Clear failed but transaction completed`);
        }

        res.json({ message: 'Transaction successful', newBalance });

        // Invalidate funds cache for this user
        try {
            await invalidateCache(`funds_${userId}_*`);
            // Also invalidate user-related caches
            await invalidateCache(`users_${userId}_all`);
            await invalidateCache(`users_${userId}_TRADER`);
        } catch (e) {
            console.log('[Cache] Invalidation failed but transaction completed');
        }

        // Log the fund creation
        await logAction(req.user.id, 'CREATE_FUND', 'ledger', `${type} of ${amountNum} for user #${userId}. Notes: ${notes || 'N/A'}`);
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ message: err.message || 'Server Error' });
    } finally {
        connection.release();
    }
};

const getFunds = async (req, res) => {
    try {
        const { userId, amount, fromDate, toDate, current_week_only, limit, page } = req.query;
        const role = req.user.role;
        const loggedInId = req.user.id;

        // Generate cache key based on filters
        const cacheKey = `funds_v2_${loggedInId}_${role}_${userId || 'all'}_${amount || 'all'}_${fromDate || 'all'}_${toDate || 'all'}_${current_week_only || 'false'}_${limit || 'default'}_${page || '1'}_${req.query.paginate || 'false'}`;

        // Try cache first
        try {
            const { getFromCache } = require('../utils/cacheManager');
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (e) {
            // Cache failed, continue to DB
        }

        let whereClause = '';
        const params = [];

        // Role-based hierarchy filter:
        // SUPERADMIN: see all funds across the system
        // ADMIN: see direct users and users under their brokers
        // BROKER: see only directly assigned clients
        // TRADER: see only own funds
        if (role === 'SUPERADMIN') {
            // Superadmin views all funds
        } else if (role === 'ADMIN') {
            whereClause += ` AND (u.parent_id = ? OR u.parent_id IN (SELECT id FROM users WHERE parent_id = ?))`;
            params.push(loggedInId, loggedInId);
        } else if (role === 'BROKER') {
            whereClause += ` AND u.parent_id = ?`;
            params.push(loggedInId);
        } else {
            whereClause += ` AND l.user_id = ?`;
            params.push(loggedInId);
        }

        if (userId) {
            whereClause += " AND (u.id = ? OR u.username LIKE ?)";
            params.push(userId, `%${userId}%`);
        }
        if (amount) {
            whereClause += " AND l.amount = ?";
            params.push(amount);
        }
        if (fromDate) {
            whereClause += " AND l.created_at >= ?";
            params.push(fromDate.includes(' ') ? fromDate : `${fromDate} 00:00:00`);
        }
        if (toDate) {
            whereClause += " AND l.created_at <= ?";
            params.push(toDate.includes(' ') ? toDate : `${toDate} 23:59:59`);
        }
        if (current_week_only === 'true' || current_week_only === '1') {
            const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
            const boundaries = getWeekBoundaries(getISTDate());
            whereClause += " AND l.created_at >= ?";
            params.push(boundaries.week_start + ' 00:00:00');
        }

        // 1. Fetch total matching records count
        let total = 0;
        try {
            const countQuery = `SELECT COUNT(*) as total FROM ledger l JOIN users u ON l.user_id = u.id WHERE 1=1 ${whereClause}`;
            const [cRows] = await db.execute(countQuery, params);
            total = parseInt(cRows[0]?.total, 10) || 0;
        } catch (cntErr) {
            console.error('[getFunds] Count error:', cntErr.message);
        }

        // 2. Fetch paginated records
        const parsedLimit = limit && limit !== 'all' ? Math.max(1, parseInt(limit, 10)) : 50;
        const parsedPage = Math.max(1, parseInt(page, 10) || 1);
        const offset = (parsedPage - 1) * parsedLimit;

        const dataQuery = `
            SELECT l.*, u.username, u.full_name
            FROM ledger l
            JOIN users u ON l.user_id = u.id
            WHERE 1=1 ${whereClause}
            ORDER BY l.id DESC
            LIMIT ? OFFSET ?
        `;
        const dataParams = [...params, parsedLimit, offset];

        const [rows] = await db.execute(dataQuery, dataParams);

        // Prepend Opening Balance record at the top of the list for the client if single client is queried
        if (userId) {
            try {
                const [uRows] = await db.execute(
                    'SELECT id, username, full_name, balance FROM users WHERE id = ? OR username = ? LIMIT 1',
                    [userId, userId]
                );
                if (uRows.length > 0) {
                    const targetUser = uRows[0];
                    const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
                    const boundaries = getWeekBoundaries(getISTDate());
                    
                    const [settleRows] = await db.execute(
                        'SELECT closing_balance, opening_balance FROM weekly_settlements WHERE user_id = ? ORDER BY week_end_date DESC LIMIT 1',
                        [targetUser.id]
                    );

                    let openingBal = 0;
                    if (settleRows.length > 0) {
                        openingBal = parseFloat(settleRows[0].closing_balance != null ? settleRows[0].closing_balance : settleRows[0].opening_balance);
                    } else {
                        openingBal = parseFloat(targetUser.balance || 0);
                    }

                    const openingEntry = {
                        id: `opening_${targetUser.id}_${boundaries.week_start}`,
                        user_id: targetUser.id,
                        username: targetUser.username,
                        full_name: targetUser.full_name,
                        amount: openingBal,
                        type: 'OPENING_BALANCE',
                        balance_after: openingBal,
                        remarks: 'Opening Balance',
                        notes: 'Opening Balance',
                        created_at: `${boundaries.week_start} 00:00:00`
                    };

                    rows.unshift(openingEntry);
                }
            } catch (openErr) {
                console.error('[getFunds] Error attaching opening balance:', openErr.message);
            }
        }

        const isPaginated = req.query.paginate === 'true' || Boolean(req.query.page);
        const responsePayload = isPaginated ? {
            data: rows,
            total,
            page: parsedPage,
            limit: parsedLimit,
            totalPages: Math.ceil(total / parsedLimit)
        } : rows;

        // Save to cache with 2 min TTL
        try {
            const { saveToCache } = require('../utils/cacheManager');
            await saveToCache(cacheKey, responsePayload, 120);
        } catch (e) {
            // Cache save failed, but data still sent
        }

        res.json(responsePayload);
    } catch (err) {
        console.error('[getFunds] Error:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

const updateFund = async (req, res) => {
    const { id } = req.params;
    const { amount, notes, mode } = req.body;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get existing entry
        const [rows] = await connection.execute('SELECT * FROM ledger WHERE id = ?', [id]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Fund entry not found' });
        }

        const old = rows[0];
        const oldAmount = Math.abs(parseFloat(old.amount));
        const newAmount = Math.abs(parseFloat(amount));
        if (isNaN(newAmount) || newAmount <= 0) {
            await connection.rollback();
            return res.status(400).json({ message: 'Amount must be a valid number greater than 0' });
        }
        const newType = mode === 'deposit' ? 'DEPOSIT' : 'WITHDRAW';

        // 2. Reverse old balance effect
        const oldReverse = old.type === 'DEPOSIT' ? -oldAmount : oldAmount;

        // 3. Apply new balance effect
        const newEffect = newType === 'DEPOSIT' ? newAmount : -newAmount;

        const balanceChange = oldReverse + newEffect;

        // 3.5 Check if updated withdrawal violates margin rules
        if (newType === 'WITHDRAW') {
            const [userRowsForCheck] = await connection.execute('SELECT balance FROM users WHERE id = ? FOR UPDATE', [old.user_id]);
            const currentBalBeforeNewEffect = parseFloat(userRowsForCheck[0].balance || 0) + oldReverse;
            
            const [trades] = await connection.execute('SELECT * FROM trades WHERE user_id = ? AND status = "OPEN"', [old.user_id]);
            const [settings] = await connection.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [old.user_id]);
            const clientConfig = settings.length > 0 ? JSON.parse(settings[0].config_json || '{}') : {};

            const blockedMargin = MarginUtils.calculateTotalRequiredHoldingMargin(trades, clientConfig);
            const withdrawable = currentBalBeforeNewEffect - blockedMargin;

            if (newAmount > withdrawable) {
                await connection.rollback();
                return res.status(400).json({ 
                    message: `Cannot update withdrawal. Amount exceeds withdrawable balance based on open trades.`,
                    details: { withdrawable: withdrawable.toFixed(2), blockedMargin: blockedMargin.toFixed(2) }
                });
            }
        }

        // 4. Update user balance
        await connection.execute(
            'UPDATE users SET balance = balance + ? WHERE id = ?',
            [balanceChange, old.user_id]
        );

        // 5. Get new balance for ledger
        const [userRows] = await connection.execute('SELECT balance FROM users WHERE id = ?', [old.user_id]);
        const newBalance = parseFloat(userRows[0]?.balance || 0);

        // 6. Update ledger entry
        await connection.execute(
            'UPDATE ledger SET amount = ?, type = ?, remarks = ?, balance_after = ? WHERE id = ?',
            [newAmount, newType, notes || old.remarks, newBalance, id]
        );

        await connection.commit();
        res.json({ message: 'Fund entry updated successfully', newBalance });

        // Invalidate funds cache for this user
        try {
            await invalidateCache(`funds_${old.user_id}_*`);
            await invalidateCache(`users_${old.user_id}_all`);
            await invalidateCache(`users_${old.user_id}_TRADER`);
        } catch (e) {
            console.log('[Cache] Invalidation failed but transaction completed');
        }

        // Log the fund update
        await logAction(req.user.id, 'UPDATE_FUND', 'ledger', `Updated fund entry #${id}. New Amount: ${newAmount}, New Type: ${newType}`);
    } catch (err) {
        await connection.rollback();
        console.error('Update Fund Error:', err);
        res.status(500).json({ message: 'Failed to update fund entry' });
    } finally {
        connection.release();
    }
};

const deleteFund = async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get the ledger entry
        const [rows] = await connection.execute('SELECT * FROM ledger WHERE id = ?', [id]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Fund entry not found' });
        }

        const entry = rows[0];
        const amount = parseFloat(entry.amount);

        // 2. Reverse the balance change
        // If it was DEPOSIT, subtract the amount. If WITHDRAW, add it back.
        const reverseAmount = entry.type === 'DEPOSIT' ? -amount : amount;
        await connection.execute(
            'UPDATE users SET balance = balance + ? WHERE id = ?',
            [reverseAmount, entry.user_id]
        );

        // 3. Delete the ledger entry
        await connection.execute('DELETE FROM ledger WHERE id = ?', [id]);

        await connection.commit();
        res.json({ message: 'Fund entry deleted and balance reversed' });

        // Invalidate funds cache for this user
        try {
            await invalidateCache(`funds_${entry.user_id}_*`);
            await invalidateCache(`users_${entry.user_id}_all`);
            await invalidateCache(`users_${entry.user_id}_TRADER`);
        } catch (e) {
            console.log('[Cache] Invalidation failed but transaction completed');
        }

        // Log the fund deletion
        await logAction(req.user.id, 'DELETE_FUND', 'ledger', `Deleted fund entry #${id} for user #${entry.user_id}. Reversed amount: ${reverseAmount}`);
    } catch (err) {
        await connection.rollback();
        console.error('Delete Fund Error:', err);
        res.status(500).json({ message: 'Failed to delete fund entry' });
    } finally {
        connection.release();
    }
};

module.exports = { createFund, getFunds, updateFund, deleteFund };
