const db = require('../config/db');
const marketDataService = require('../services/MarketDataService');
const { getMcxBaseScrip } = require('../utils/symbolHelper');
const MarginUtils = require('../utils/MarginUtils');
const { getSegmentExposure } = require('../utils/segmentHelper');
const { calculateSegmentMargin } = require('../utils/segmentMargin');
const { getUserBannedScripsStatus } = require('../utils/bannedHelper');
const { getClientAllowedSegments, isScripSegmentAllowed } = require('../utils/segmentPermissionHelper');
const { getExact } = require('../utils/exactResultCache');
const { getGeneration } = require('../utils/cacheManager');

/**
 * Live Market Prices (Snapshot)
 */
const getLiveMarket = async (req, res) => {
    try {
        const prices = marketDataService.prices;
        res.json(prices);
    } catch (err) {
        console.error('getLiveMarket Error:', err);
        res.status(500).send('Server Error');
    }
};

const instrumentService = require('../services/InstrumentService');
const kiteService = require('../utils/kiteService');

const liveM2mFlight = new Map();
let lotMapCache = { at: 0, map: null };

async function getLotMap() {
    if (lotMapCache.map && Date.now() - lotMapCache.at < 60000) return lotMapCache.map;
    const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
    const map = {};
    lotRows.forEach(r => {
        map[String(r.symbol || '').toUpperCase()] = parseFloat(r.lot_size || 1);
    });
    lotMapCache = { at: Date.now(), map };
    return map;
}

function classifySegment(marketType, symbol) {
    const mType = (marketType || 'MCX').toUpperCase();
    let segment = mType === 'EQUITY' ? 'nse' : mType.toLowerCase();
    if (mType === 'NFO' || mType === 'OPTIONS') {
        const sym = String(symbol || '').toUpperCase();
        segment = (sym.endsWith('CE') || sym.endsWith('PE') || /\d{5,}/.test(sym)) ? 'options' : 'nse';
    }
    if (segment === 'commodity') segment = 'forex';
    return segment;
}

const MCX_NAME_MARKERS = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'];

function applyWeekGroups(stats, groups, getMultiplier) {
    for (const group of groups) {
        const segment = classifySegment(group.market_type, group.symbol);
        if (stats.buyTurnover[segment] === undefined) continue;
        const mType = (group.market_type || 'MCX').toUpperCase();
        const symbol = String(group.symbol || '');
        const lotSize = getMultiplier(symbol, mType, null);
        const isMcx = mType === 'MCX' || symbol.toUpperCase().includes('MCX') ||
            MCX_NAME_MARKERS.some(name => symbol.toUpperCase().includes(name));
        const qtyValue = parseFloat(group.qty_value || 0);
        const actualValue = parseFloat(group.actual_value || 0);
        const fallbackValue = parseFloat(group.fallback_value || 0);
        const tradeValue = isMcx ? qtyValue * lotSize : (actualValue + fallbackValue * lotSize);
        if (String(group.type || '').toUpperCase() === 'BUY') stats.buyTurnover[segment] += tradeValue;
        else stats.sellTurnover[segment] += tradeValue;
        stats.totalTurnover[segment] += tradeValue;
        if (!Number(group.carried)) stats.brokerage[segment] += parseFloat(group.brokerage || 0);
        stats.profitLoss[segment] += parseFloat(group.pnl || 0);
    }
}

let lastPriceSyncAt = 0;
let lastPriceSyncKey = '';

const syncPricesForTrades = async (trades) => {
    try {
        const openSymbols = new Set();
        trades.forEach(t => {
            if ((t.status === 'OPEN' || t.status === 'HOLD') && t.symbol) {
                openSymbols.add(t.symbol.toUpperCase());
            }
        });

        if (openSymbols.size === 0) return;
        const syncKey = [...openSymbols].sort().join('|');
        if (syncKey === lastPriceSyncKey && Date.now() - lastPriceSyncAt < 5000) return;

        const symbolsArr = Array.from(openSymbols);

        // 1. Subscribe in live ticker so we get future updates
        const instrumentsBySymbol = await instrumentService.getInstrumentsBySymbols(symbolsArr);
        symbolsArr.forEach(symbol => {
            const inst = instrumentsBySymbol.get(symbol);
            if (inst) {
                marketDataService.subscribe(symbol, inst.instrument_token);
            }
        });

        // 2. Fetch missing prices from REST API if Kite is connected
        const missingSymbols = symbolsArr.filter(s => !marketDataService.getPrice(s));
        if (missingSymbols.length > 0 && kiteService.isAuthenticated()) {
            console.log(`📡 Dashboard: Fetching quotes for ${missingSymbols.length} symbols...`);
            try {
                const quotes = await kiteService.getQuote(missingSymbols);
                // Seed the cache with REST data so the first load isn't zero
                Object.keys(quotes).forEach(sym => {
                    const q = quotes[sym];
                    if (!marketDataService.prices[sym]) {
                        marketDataService.prices[sym] = {
                            ltp: q.last_price,
                            bid: q.buy_quantity > 0 ? q.depth.buy[0].price : q.last_price,
                            ask: q.sell_quantity > 0 ? q.depth.sell[0].price : q.last_price,
                            change: q.net_change,
                            timestamp: new Date()
                        };
                    }
                });
            } catch (err) {
                console.warn('Dashboard getQuote fallback failed:', err.message);
            }
        }
        lastPriceSyncAt = Date.now();
        lastPriceSyncKey = syncKey;
    } catch (err) {
        console.error('syncPricesForTrades error:', err);
    }
};


/**
 * Superadmin Dashboard - Dynamic Implementation
 * Returns: { clients: [], stats: { buyTurnover, sellTurnover, totalTurnover, activeUsers, profitLoss, brokerage } }
 */
const getClientLiveM2M = async (req, res) => {
    const flightKey = `${req.user && req.user.id}:${req.query.userId || req.query.id || ''}`;
    const existing = liveM2mFlight.get(flightKey);
    if (existing) {
        try {
            return res.json(await existing);
        } catch (err) {
            console.error('getClientLiveM2M Error:', err);
            return res.status(500).json({ message: 'Server Error' });
        }
    }
    let finish;
    const flight = new Promise((resolve, reject) => {
        finish = { resolve, reject };
    });
    liveM2mFlight.set(flightKey, flight);
    try {
        const { id: userId, role } = req.user;
        const filterUserId = req.query.userId || req.query.id;

        let filterUserRole = null;
        if (filterUserId) {
            const [userRows] = await db.execute('SELECT role FROM users WHERE id = ?', [filterUserId]);
            if (userRows.length > 0) {
                filterUserRole = userRows[0].role;
            }
        }

        let isBrokerList = false;
        let brokers = [];
        let clientToBrokerMap = {};

        // 1. Fetch all relevant trades (Non-Deleted)
        let tradeQuery = `
            SELECT t.*, u.username, u.full_name, u.role as user_role, u.balance, u.is_demo, u.last_reset_at, cs.config_json as user_config
            FROM trades t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN client_settings cs ON u.id = cs.user_id
            WHERE t.status != 'DELETED'
        `;
        let tradeParams = [];

        if ((role === 'SUPERADMIN' || role === 'ADMIN') && !filterUserId) {
            isBrokerList = true;
            let brokerQuery = "SELECT id, username, full_name, role FROM users WHERE role = 'BROKER'";
            let brokerParams = [];
            if (role === 'ADMIN') {
                brokerQuery = "SELECT id, username, full_name, role FROM users WHERE role = 'BROKER' AND parent_id = ?";
                brokerParams.push(userId);
            } else if (role === 'SUPERADMIN') {
                brokerQuery = `SELECT id, username, full_name, role FROM users 
                    WHERE role = 'ADMIN' 
                    OR (role = 'BROKER' AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM users WHERE role = 'ADMIN')))`;
            }
            const [bRows] = await db.execute(brokerQuery, brokerParams);
            brokers = bRows;

            const brokerIds = brokers.map(b => b.id);

            if (role === 'ADMIN') {
                tradeQuery += ` AND (t.created_by = ? OR t.user_id = ? OR cs.broker_id = ? OR cs.broker_id IN (${brokerIds.length > 0 ? brokerIds.join(',') : '-1'}) OR t.user_id IN (${brokerIds.length > 0 ? brokerIds.join(',') : '-1'}))`;
                tradeParams.push(userId, userId, userId);
            }
        } else if (filterUserId) {
            if (filterUserRole === 'ADMIN') {
                isBrokerList = true;
                const [bRows] = await db.execute(
                    "SELECT id, username, full_name, role FROM users WHERE role = 'BROKER' AND parent_id = ?",
                    [filterUserId]
                );
                brokers = bRows;

                tradeQuery += ` AND (t.user_id IN (
                    SELECT u.id FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id IN (SELECT id FROM users WHERE parent_id = ? AND role = 'BROKER')
                        OR cs.broker_id IN (SELECT id FROM users WHERE parent_id = ? AND role = 'BROKER')
                    )
                ) OR t.user_id = ? OR t.user_id IN (SELECT id FROM users WHERE parent_id = ? AND role = 'BROKER'))`;
                tradeParams.push(filterUserId, filterUserId, filterUserId, filterUserId);
            } else if (filterUserRole === 'BROKER') {
                tradeQuery += ` AND (t.user_id IN (
                    SELECT u.id FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id = ?
                        OR cs.broker_id = ?
                    )
                ) OR t.user_id = ?)`;
                tradeParams.push(filterUserId, filterUserId, filterUserId);
            } else {
                tradeQuery += ' AND t.user_id = ?';
                tradeParams.push(filterUserId);
            }
        } else if (role === 'BROKER') {
            tradeQuery += ' AND (t.created_by = ? OR t.user_id = ? OR cs.broker_id = ?)';
            tradeParams.push(userId, userId, userId);
        } else {
            tradeQuery += ' AND t.user_id = ?';
            tradeParams.push(userId);
        }

        // Live M2M only needs open/hold rows plus the current week for turnover.
        // All-time closed P/L is aggregated in SQL so historical trades are not
        // hydrated into Node (that path OOMs around 15 lakh trades).
        const isSingleTraderRequest = (role === 'TRADER') || (filterUserId && filterUserRole === 'TRADER');
        const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
        const { week_start } = getWeekBoundaries(getISTDate());
        const weekStartTs = `${week_start} 00:00:00`;

        let closedPlQuery = tradeQuery.replace(
            /SELECT[\s\S]+?FROM trades t/,
            'SELECT t.user_id, u.role AS user_role, u.username, u.balance, SUM(IFNULL(t.pnl, 0)) AS closed_pl FROM trades t'
        );
        closedPlQuery += ` AND t.status = 'CLOSED'`;
        if (!isSingleTraderRequest) {
            closedPlQuery += ' AND IFNULL(u.is_demo, 0) = 0';
        }
        closedPlQuery += ' GROUP BY t.user_id, u.role, u.username, u.balance';
        const closedWhere = closedPlQuery.slice(closedPlQuery.indexOf('WHERE'));
        if (!closedWhere.includes('cs.')) {
            closedPlQuery = closedPlQuery.replace(/\s*LEFT JOIN client_settings cs ON u\.id = cs\.user_id/i, '');
        }
        const closedPlParams = [...tradeParams];

        // Open rows drive live P/L. This week's turnover is a small grouped
        // query, cached, instead of loading every closed trade into Node.
        const openQuery = tradeQuery.replace(
            /SELECT[\s\S]+?FROM trades t/,
            `SELECT t.user_id, t.symbol, t.type, t.qty, t.qty_input, t.actual_qty, t.entry_price,
                    t.market_type, t.status, t.is_pending, t.is_carried_forward, t.last_settlement_price,
                    t.margin_used, t.brokerage, t.pnl, t.exit_time, t.entry_time, t.trade_mode, t.equity_units_mode,
                    u.username, u.role AS user_role, u.balance, u.is_demo, u.last_reset_at, cs.config_json AS user_config
             FROM trades t`
        ) + ` AND t.status IN ('OPEN', 'HOLD')`;

        const tradeWhere = tradeQuery.slice(tradeQuery.indexOf('WHERE'));
        let weekQuery = `
            SELECT t.market_type, t.symbol, t.type, IFNULL(t.is_carried_forward, 0) AS carried,
                   SUM(ABS(t.qty) * IFNULL(t.entry_price, 0)) AS qty_value,
                   SUM(CASE WHEN IFNULL(t.actual_qty, 0) > 0 THEN IFNULL(t.entry_price, 0) * t.actual_qty ELSE 0 END) AS actual_value,
                   SUM(CASE WHEN IFNULL(t.actual_qty, 0) > 0 THEN 0 ELSE ABS(t.qty) * IFNULL(t.entry_price, 0) END) AS fallback_value,
                   SUM(IFNULL(t.brokerage, 0)) AS brokerage,
                   SUM(IFNULL(t.pnl, 0)) AS pnl
            FROM trades t FORCE INDEX (idx_trades_status_exit)
            JOIN users u ON t.user_id = u.id
        `;
        if (tradeWhere.includes('cs.')) {
            weekQuery += ' LEFT JOIN client_settings cs ON u.id = cs.user_id ';
        }
        weekQuery += tradeWhere;
        weekQuery += ` AND t.status = 'CLOSED' AND t.exit_time >= ? AND COALESCE(t.exit_time, t.entry_time) >= GREATEST(COALESCE(u.last_reset_at, ?), ?)`;
        if (!isSingleTraderRequest) weekQuery += ' AND IFNULL(u.is_demo, 0) = 0';
        weekQuery += ' GROUP BY t.market_type, t.symbol, t.type, IFNULL(t.is_carried_forward, 0)';
        const weekParams = [...tradeParams, weekStartTs, weekStartTs, weekStartTs];

        const financialGen = await getGeneration('financial');
        const loadRows = (sql, params) => getExact(financialGen, sql + JSON.stringify(params), async () => {
            const [rows] = await db.execute(sql, params);
            return rows;
        });
        // Cold cache waits for the real aggregate. A warm cache returns the
        // last exact rows until a trade, ledger, or user write bumps the generation.
        const [closedPlRows, weekGroups, openRows] = await Promise.all([
            loadRows(closedPlQuery, closedPlParams),
            loadRows(weekQuery, weekParams),
            loadRows(openQuery, tradeParams)
        ]);
        const trades = openRows;

        // Price sync hits Kite only for symbols the ticker does not have yet.
        // Do not hold the dashboard response on that network call.
        syncPricesForTrades(trades);

        const lotMap = await getLotMap();

        const { MCX_LOT_SIZES, getMcxBaseScrip } = require('../utils/symbolHelper');

        const getMultiplier = (symbol, marketType, userConfig = null) => {
            const sym = symbol.toUpperCase();
            const mType = (marketType || 'MCX').toUpperCase();

            // 1. NSE/Equity/Options/NFO generally use point-to-point (multiplier 1)
            const isMcxSymbol = mType === 'MCX' || sym.startsWith('MCX:') ||
                ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'].some(k => sym.includes(k));
            if (!isMcxSymbol && (mType === 'EQUITY' || mType === 'NSE' || mType === 'NFO' || mType === 'OPTIONS')) {
                return 1;
            }

            // 2. Try Hardcoded MCX_LOT_SIZES (Point Values)
            // CRITICAL SYNC: The mobile app uses hardcoded multipliers for P/L.
            // We follow the same logic here to ensure cross-platform consistency.
            const base = getMcxBaseScrip(symbol);
            if (base && MCX_LOT_SIZES[base]) return MCX_LOT_SIZES[base];

            // Try trimmed symbol (e.g. SILVER26MAYFUT -> SILVER)
            const symTrimmed = symbol.split(':').pop().toUpperCase().replace(/\d+.*/, '');
            if (MCX_LOT_SIZES[symTrimmed]) return MCX_LOT_SIZES[symTrimmed];

            // NOTE: mcxLotMargins[scrip].LOT is the per-user position LIMIT (max lots allowed),
            // NOT the exchange lot size. It must never be used as a P&L/turnover multiplier.
            // Skipping that fallback intentionally.

            // 4. Try Scrip Data Table (Fallback)
            const cleanSym = symbol.includes(':') ? symbol.split(':')[1] : symbol;
            if (lotMap[cleanSym.toUpperCase()] && lotMap[cleanSym.toUpperCase()] > 0) return lotMap[cleanSym.toUpperCase()];

            return 1; // Default fallback
        };

        // 3. Map for MarketDataService prefixes
        const PREFIX_MAP = {
            'EQUITY': 'NSE',
            'NFO': 'NFO',
            'MCX': 'MCX',
            'OPTIONS': 'NFO',
            'CRYPTO': 'CRYPTO',
            'FOREX': 'FOREX',
            'COMEX': 'COMEX',
            'COMMODITY': 'FOREX'
        };

        const finalizedStats = {
            buyTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            sellTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            totalTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            profitLoss: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            activeUsers: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            brokerage: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            activeBuy: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            activeSell: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 }
        };

        const stats = {
            buyTurnover: {}, sellTurnover: {}, totalTurnover: {}, activeUsers: {}, profitLoss: {}, brokerage: {},
            activeBuy: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            activeSell: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 }
        };

        const segments = ['mcx', 'nse', 'options', 'comex', 'forex', 'crypto'];
        segments.forEach(s => {
            stats.buyTurnover[s] = 0; stats.sellTurnover[s] = 0; stats.totalTurnover[s] = 0;
            stats.activeUsers[s] = new Set(); stats.profitLoss[s] = 0; stats.brokerage[s] = 0;
        });

        const brokerStatsMap = {};
        const clientParents = {};
        const userParentMap = {};
        const userRoleMap = {};

        if (isBrokerList) {
            brokers.forEach(b => {
                brokerStatsMap[b.id] = {
                    id: b.id,
                    username: b.username,
                    fullName: b.full_name,
                    role: b.role,
                    activePL: 0,
                    activeTrades: 0,
                    closedPL: 0,
                    margin: 0,
                    marginUsed: 0
                };
            });

            // Load hierarchy
            const [allUsers] = await db.execute("SELECT id, role, parent_id FROM users");
            allUsers.forEach(u => {
                userParentMap[u.id] = u.parent_id;
                userRoleMap[u.id] = u.role;
            });

            const [clientBrokerRows] = await db.execute(`
                SELECT u.id as client_id, u.parent_id as client_parent_id, cs.broker_id as assigned_broker_id
                FROM users u
                LEFT JOIN client_settings cs ON u.id = cs.user_id
                WHERE u.role = 'TRADER'
            `);

            clientBrokerRows.forEach(row => {
                let brokerId = row.assigned_broker_id || row.client_parent_id;
                let adminId = null;
                if (brokerId) {
                    if (userRoleMap[brokerId] === 'ADMIN') {
                        adminId = brokerId;
                        brokerId = null;
                    } else if (userRoleMap[brokerId] === 'BROKER') {
                        const parentOfBroker = userParentMap[brokerId];
                        if (parentOfBroker && userRoleMap[parentOfBroker] === 'ADMIN') {
                            adminId = parentOfBroker;
                        }
                    }
                }
                clientParents[row.client_id] = { brokerId, adminId };
            });
        }

        const clientMap = {};

        // Pre-populate clientMap for Broker / Admin / Superadmin so all clients appear even with 0 trades
        if (!isBrokerList) {
            let clientsToFetchQuery = '';
            let clientsToFetchParams = [];

            if (filterUserId && (filterUserRole === 'BROKER' || filterUserRole === 'ADMIN')) {
                clientsToFetchQuery = `
                    SELECT u.id, u.username, u.balance
                    FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id = ?
                        OR cs.broker_id = ?
                    )
                `;
                clientsToFetchParams = [filterUserId, filterUserId];
            } else if (!filterUserId && role === 'BROKER') {
                clientsToFetchQuery = `
                    SELECT u.id, u.username, u.balance
                    FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id = ?
                        OR cs.broker_id = ?
                    )
                `;
                clientsToFetchParams = [userId, userId];
            }

            if (clientsToFetchQuery) {
                const [cRows] = await db.execute(clientsToFetchQuery, clientsToFetchParams);
                cRows.forEach(c => {
                    clientMap[c.id] = {
                        id: c.id,
                        username: c.username,
                        activePL: 0,
                        activeTrades: 0,
                        margin: 0,
                        marginUsed: 0,
                        balance: parseFloat(c.balance || 0),
                        positions: {}
                    };
                });
            }
        }

        closedPlRows.forEach(row => {
            const amount = parseFloat(row.closed_pl || 0);
            const uId = row.user_id;
            const userRole = row.user_role;
            if (isBrokerList) {
                if (userRole === 'ADMIN' || userRole === 'BROKER') {
                    if (brokerStatsMap[uId]) brokerStatsMap[uId].closedPL += amount;
                    if (userRole === 'BROKER') {
                        const parentId = userParentMap[uId];
                        if (parentId && brokerStatsMap[parentId]) brokerStatsMap[parentId].closedPL += amount;
                    }
                } else {
                    const parents = clientParents[uId];
                    if (parents) {
                        if (parents.brokerId && brokerStatsMap[parents.brokerId]) brokerStatsMap[parents.brokerId].closedPL += amount;
                        if (parents.adminId && brokerStatsMap[parents.adminId]) brokerStatsMap[parents.adminId].closedPL += amount;
                    }
                }
            } else if (userRole === 'TRADER') {
                if (!clientMap[uId]) {
                    clientMap[uId] = {
                        id: uId,
                        username: row.username,
                        activePL: 0,
                        activeTrades: 0,
                        closedPL: 0,
                        margin: 0,
                        marginUsed: 0,
                        balance: parseFloat(row.balance || 0)
                    };
                }
                clientMap[uId].closedPL = (clientMap[uId].closedPL || 0) + amount;
            }
        });

        applyWeekGroups(stats, weekGroups, getMultiplier);

        const livePriceCache = new Map();
        const userConfigCache = new Map();
        const commodityLotService = require('../services/CommodityLotService');
        const { calculateEquityPnL, calculateMcxPnL } = require('../utils/equityPnL');

        const resolveLivePrice = (trade, mType) => {
            const cacheKey = `${mType}|${trade.symbol}`;
            if (livePriceCache.has(cacheKey)) return livePriceCache.get(cacheKey);
            const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
            const PREFIX_MAP = { MCX: 'MCX', NSE: 'NSE', NFO: 'NFO', EQUITY: 'NSE', OPTIONS: 'NFO', NIFTY: 'NFO' };
            const prefix = PREFIX_MAP[mType] || mType;
            const searchPatterns = [
                trade.symbol,
                `${prefix}:${cleanSymbol}`,
                cleanSymbol,
                cleanSymbol.replace(/FUT$/i, ''),
                `${prefix}:${cleanSymbol.replace(/FUT$/i, '')}`,
                `NSE:${cleanSymbol}`,
                `NFO:${cleanSymbol}`,
                `MCX:${cleanSymbol}`
            ];
            let liveData = null;
            for (const pattern of searchPatterns) {
                liveData = marketDataService.getPrice(pattern);
                if (liveData) break;
            }
            // Same contract only. An expired GOLD26OCT quote must not use GOLD26DEC.
            livePriceCache.set(cacheKey, liveData);
            return liveData;
        };

        trades.forEach(trade => {
            // Exclude demo trades for global aggregations / broker dashboards
            if (trade.is_demo === 1 && !isSingleTraderRequest) {
                return;
            }

            const mType = (trade.market_type || 'MCX').toUpperCase();
            let segment = mType === 'EQUITY' ? 'nse' : mType.toLowerCase();

            if (mType === 'NFO' || mType === 'OPTIONS') {
                const sym = trade.symbol.toUpperCase();
                if (sym.endsWith('CE') || sym.endsWith('PE') || /\d{5,}/.test(sym)) {
                    segment = 'options';
                } else {
                    segment = 'nse';
                }
            }

            // Map commodity to forex stats since frontend dashboard doesn't have commodity tab
            if (segment === 'commodity') {
                segment = 'forex';
            }

            const isBuy = trade.type === 'BUY';
            const qty = Math.abs(trade.qty);
            const entryPrice = parseFloat(trade.entry_price || 0);

            // Parse user config if available
            let userConfig = null;
            if (userConfigCache.has(trade.user_id)) {
                userConfig = userConfigCache.get(trade.user_id);
            } else if (trade.user_config) {
                try {
                    userConfig = typeof trade.user_config === 'string' ? JSON.parse(trade.user_config) : trade.user_config;
                } catch (e) {
                    console.error('Failed to parse user config for P/L calculation:', e);
                }
                userConfigCache.set(trade.user_id, userConfig);
            } else {
                userConfigCache.set(trade.user_id, null);
            }

            const lotSize = getMultiplier(trade.symbol, mType, userConfig);

            // App Sync logic: 
            // For MCX, totalUnits is ALWAYS qty * multiplier (lotSize)
            // For NSE, qty is already the number of units/shares.
            let totalUnits = qty * lotSize;

            // Fallback to actual_qty only for non-MCX if it exists
            const isMcxTrade = mType === 'MCX' || (trade.symbol || '').toUpperCase().includes('MCX') ||
                ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'].some(k => (trade.symbol || '').toUpperCase().includes(k));
            if (!isMcxTrade && trade.actual_qty && parseFloat(trade.actual_qty) > 0) {
                totalUnits = parseFloat(trade.actual_qty);
            }

            const tradeValue = entryPrice * totalUnits;

            // Scope Dashboard Turnover and Brokerage stats to Current Active Week / Last Reset Cycle (Full Timestamp Comparison)
            const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
            const { week_start } = getWeekBoundaries(getISTDate());

            const tradeTimeMs = trade.exit_time ? new Date(trade.exit_time).getTime() : (trade.entry_time ? new Date(trade.entry_time).getTime() : 0);
            const resetTimeMs = trade.last_reset_at ? new Date(trade.last_reset_at).getTime() : new Date(`${week_start} 00:00:00`).getTime();
            const weekStartTimeMs = new Date(`${week_start} 00:00:00`).getTime();

            const effectiveResetMs = Math.max(resetTimeMs, weekStartTimeMs);
            const isTradeInCurrentWeek = tradeTimeMs >= effectiveResetMs;

            if (isTradeInCurrentWeek) {
                if (isBuy) stats.buyTurnover[segment] += tradeValue;
                else stats.sellTurnover[segment] += tradeValue;
                stats.totalTurnover[segment] += tradeValue;

                // Carried forward / HOLD trades do not count duplicate brokerage in the new week
                if (!trade.is_carried_forward && trade.status !== 'HOLD') {
                    stats.brokerage[segment] += parseFloat(trade.brokerage || 0);
                }
            }

            if (trade.status === 'CLOSED') {
                const rawClosedPnl = parseFloat(trade.pnl || 0);
                if (isTradeInCurrentWeek) {
                    stats.profitLoss[segment] += rawClosedPnl;
                }
                // All-time closedPL is applied from closedPlRows above.
                // This loop only sees the current week, so it must not add closedPL again.
            }

            if ((trade.status === 'OPEN' || trade.status === 'HOLD') && !trade.is_pending) {
                stats.activeUsers[segment].add(trade.user_id);
                if (isBuy) stats.activeBuy[segment] += 1;
                else stats.activeSell[segment] += 1;

                const liveData = resolveLivePrice(trade, mType);

                const baselinePrice = (trade.is_carried_forward || trade.status === 'HOLD') && trade.last_settlement_price !== null && trade.last_settlement_price !== undefined
                    ? parseFloat(trade.last_settlement_price)
                    : entryPrice;

                // Use BID for BUY trades (exit by selling), ASK for SELL trades
                const exitPrice = isBuy
                    ? (liveData?.bid || liveData?.ltp || baselinePrice)
                    : (liveData?.ask || liveData?.ltp || baselinePrice);

                let unrealizedPnl = 0;
                if (commodityLotService.isCommodityScrip(trade.symbol, mType)) {
                    const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, baselinePrice, exitPrice, qty);
                    unrealizedPnl = calc.pnlInr;
                } else {
                    const isMcxTrade = mType === 'MCX' || (trade.symbol || '').toUpperCase().startsWith('MCX:') ||
                        ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'].some(k => (trade.symbol || '').toUpperCase().includes(k));
                    if (isMcxTrade) {
                        unrealizedPnl = calculateMcxPnL({
                            type: trade.type,
                            entryPrice: baselinePrice,
                            exitPrice: exitPrice,
                            qty: qty,
                            qtyInput: trade.qty_input,
                            lotSize: lotSize
                        });
                    } else {
                        unrealizedPnl = calculateEquityPnL({
                            type: trade.type,
                            entryPrice: baselinePrice,
                            exitPrice: exitPrice,
                            qty: qty,
                            qtyInput: trade.qty_input,
                            actualQty: trade.actual_qty,
                            lotSize: lotSize,
                            tradeMode: trade.trade_mode,
                            equityUnitsMode: trade.equity_units_mode
                        });
                    }
                }

                // ✅ FIX: Calculate marginUsed & holdingMargin dynamically using standardized calculateSegmentMargin helper
                const mktType = (trade.market || trade.market_type || '').toUpperCase();
                let dynamicMarginUsed = parseFloat(trade.margin_used || 0); // default: DB value
                let dynamicMargin = 0;
                try {
                    const calcMarginUsed = calculateSegmentMargin({
                        marketType: mktType,
                        symbol: trade.symbol,
                        price: entryPrice,
                        qty: qty,
                        lotSize: lotSize,
                        isHolding: false,
                        clientConfig: userConfig || {}
                    });
                    const calcHoldingMargin = calculateSegmentMargin({
                        marketType: mktType,
                        symbol: trade.symbol,
                        price: entryPrice,
                        qty: qty,
                        lotSize: lotSize,
                        isHolding: true,
                        clientConfig: userConfig || {}
                    });
                    if (calcMarginUsed > 0) dynamicMarginUsed = calcMarginUsed;
                    if (calcHoldingMargin > 0) dynamicMargin = calcHoldingMargin;
                } catch (e) { /* keep DB value on error */ }

                if (isBrokerList) {
                    if (trade.user_role === 'ADMIN' || trade.user_role === 'BROKER') {
                        const uId = trade.user_id;
                        if (brokerStatsMap[uId]) {
                            brokerStatsMap[uId].activePL += unrealizedPnl;
                            brokerStatsMap[uId].activeTrades += 1;
                            brokerStatsMap[uId].margin += dynamicMargin;
                            brokerStatsMap[uId].marginUsed += dynamicMarginUsed;
                        }
                        if (trade.user_role === 'BROKER') {
                            const parentId = userParentMap[uId];
                            if (parentId && brokerStatsMap[parentId]) {
                                brokerStatsMap[parentId].activePL += unrealizedPnl;
                                brokerStatsMap[parentId].activeTrades += 1;
                                brokerStatsMap[parentId].margin += dynamicMargin;
                                brokerStatsMap[parentId].marginUsed += dynamicMarginUsed;
                            }
                        }
                    } else {
                        const parents = clientParents[trade.user_id];
                        if (parents) {
                            const { brokerId, adminId } = parents;
                            if (brokerId && brokerStatsMap[brokerId]) {
                                brokerStatsMap[brokerId].activePL += unrealizedPnl;
                                brokerStatsMap[brokerId].activeTrades += 1;
                                brokerStatsMap[brokerId].margin += dynamicMargin;
                                brokerStatsMap[brokerId].marginUsed += dynamicMarginUsed;
                            }
                            if (adminId && brokerStatsMap[adminId]) {
                                brokerStatsMap[adminId].activePL += unrealizedPnl;
                                brokerStatsMap[adminId].activeTrades += 1;
                                brokerStatsMap[adminId].margin += dynamicMargin;
                                brokerStatsMap[adminId].marginUsed += dynamicMarginUsed;
                            }
                        }
                    }
                } else if (trade.user_role === 'TRADER') {
                    if (!clientMap[trade.user_id]) {
                        clientMap[trade.user_id] = {
                            id: trade.user_id, username: trade.username,
                            activePL: 0, activeTrades: 0, closedPL: 0, margin: 0, marginUsed: 0, balance: parseFloat(trade.balance || 0)
                        };
                    }
                    clientMap[trade.user_id].activePL += unrealizedPnl;
                    clientMap[trade.user_id].activeTrades += 1;

                    // --- Individual Position Tracking (for detail view) ---
                    if (filterUserId) {
                        if (!clientMap[trade.user_id].positions) clientMap[trade.user_id].positions = {};
                        const sym = trade.symbol;
                        if (!clientMap[trade.user_id].positions[sym]) {
                            clientMap[trade.user_id].positions[sym] = {
                                symbol: sym,
                                buyQty: 0, sellQty: 0, buyTotal: 0, sellTotal: 0,
                                buyShareValue: 0, sellShareValue: 0, buyShares: 0, sellShares: 0,
                                actualBuyQty: 0, actualSellQty: 0,
                                pnl: 0, margin: 0, marginUsed: 0, cmp: exitPrice,
                                type: trade.type, avgPrice: 0
                            };
                        }
                        const p = clientMap[trade.user_id].positions[sym];
                        // NSE stores shares in qty for both lots and qty mode.
                        // The number outside the bracket is qty_input (lots, or shares in qty mode).
                        const parsedInput = parseFloat(trade.qty_input);
                        const displayLots = (!Number.isNaN(parsedInput) && parsedInput !== 0)
                            ? Math.abs(parsedInput)
                            : qty;
                        const parsedActual = parseFloat(trade.actual_qty);
                        const shareQty = (!Number.isNaN(parsedActual) && parsedActual > 0)
                            ? Math.abs(parsedActual)
                            : qty;
                        if (isBuy) {
                            p.buyQty += displayLots;
                            p.buyShareValue += entryPrice * shareQty;
                            p.buyShares += shareQty;
                            p.actualBuyQty += (!Number.isNaN(parsedActual) ? Math.abs(parsedActual) : 0);
                        }
                        else {
                            p.sellQty += displayLots;
                            p.sellShareValue += entryPrice * shareQty;
                            p.sellShares += shareQty;
                            p.actualSellQty += (!Number.isNaN(parsedActual) ? Math.abs(parsedActual) : 0);
                        }
                        p.pnl += unrealizedPnl;
                        p.margin += dynamicMargin;
                        p.marginUsed += dynamicMarginUsed;
                        p.cmp = exitPrice;
                    }

                    clientMap[trade.user_id].margin += dynamicMargin;
                    clientMap[trade.user_id].marginUsed += dynamicMarginUsed;
                }
            }
        });

        // 5. Finalize Stats Structure
        const formatValue = (val) => `${(val / 100000).toFixed(2)} Lakhs`;
        const formatValOnly = (val) => val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        segments.forEach(s => {
            finalizedStats.buyTurnover[s] = formatValue(stats.buyTurnover[s]);
            finalizedStats.sellTurnover[s] = formatValue(stats.sellTurnover[s]);
            finalizedStats.totalTurnover[s] = formatValue(stats.totalTurnover[s]);
            finalizedStats.profitLoss[s] = formatValOnly(stats.profitLoss[s]);
            finalizedStats.brokerage[s] = formatValOnly(stats.brokerage[s]);
            finalizedStats.activeUsers[s] = stats.activeUsers[s].size.toString();
            finalizedStats.activeBuy[s] = stats.activeBuy[s].toString();
            finalizedStats.activeSell[s] = stats.activeSell[s].toString();
        });

        const formattedClients = Object.values(clientMap).map(c => {
            const netCapital = c.balance + c.activePL;
            let shortfall = 0;
            if (c.margin > netCapital && netCapital > 0) {
                shortfall = c.margin - netCapital;
            }

            // Finalize positions array if exists
            let positions = [];
            if (c.positions) {
                positions = Object.values(c.positions).map(p => {
                    const netQty = p.buyQty - p.sellQty;
                    const buyAvg = p.buyShares > 0 ? (p.buyShareValue / p.buyShares) : 0;
                    const sellAvg = p.sellShares > 0 ? (p.sellShareValue / p.sellShares) : 0;
                    // Keep buyTotal / buyQty equal to the share average so the page rate stays the trade price.
                    p.buyTotal = buyAvg * p.buyQty;
                    p.sellTotal = sellAvg * p.sellQty;
                    const netShares = p.buyShares - p.sellShares;
                    const avgPrice = netShares > 0 ? buyAvg : (netShares < 0 ? sellAvg : 0);
                    const isCryptoForex = p.symbol.startsWith('CRYPTO:') || p.symbol.startsWith('FOREX:');
                    const decimals = isCryptoForex ? 4 : 2;
                    const { buyShareValue, sellShareValue, buyShares, sellShares, ...position } = p;
                    return {
                        ...position,
                        netQty,
                        avgPrice: avgPrice.toFixed(decimals),
                        pnl: p.pnl.toFixed(decimals),
                        margin: p.margin.toFixed(2),
                        marginUsed: p.marginUsed.toFixed(2)
                    };
                });
            }

            return {
                ...c,
                ledger: c.balance.toFixed(2),
                m2m: netCapital.toFixed(2),
                activePL: c.activePL.toFixed(2),
                closedPL: (c.closedPL || 0).toFixed(2),
                margin: c.margin.toFixed(2),
                marginUsed: (c.marginUsed || 0).toFixed(2),
                marginShortfall: shortfall.toFixed(2),
                positions
            };
        });

        if (isBrokerList) {
            const formattedBrokers = Object.values(brokerStatsMap)
                .filter(b => b.activeTrades > 0)
                .map(b => {
                    return {
                        ...b,
                        activePL: b.activePL.toFixed(2),
                        closedPL: b.closedPL.toFixed(2),
                        margin: b.margin.toFixed(2),
                        marginUsed: b.marginUsed.toFixed(2)
                    };
                });
            const brokerPayload = {
                isBrokerList: true,
                isBroker: true,
                clients: formattedBrokers,
                stats: finalizedStats
            };
            finish.resolve(brokerPayload);
            return res.json(brokerPayload);
        }

        let resultClients = formattedClients;
        if (filterUserRole === 'BROKER' || filterUserRole === 'ADMIN' || (!filterUserId && role === 'BROKER')) {
            resultClients = formattedClients.filter(c => (c.activeTrades || 0) > 0);
        }

        const clientPayload = {
            isBroker: (filterUserRole === 'BROKER' || filterUserRole === 'ADMIN'),
            clients: resultClients,
            stats: finalizedStats
        };
        finish.resolve(clientPayload);
        res.json(clientPayload);

    } catch (err) {
        console.error('getClientLiveM2M Error:', err);
        if (finish) finish.reject(err);
        if (!res.headersSent) res.status(500).send('Server Error');
    } finally {
        if (liveM2mFlight.get(flightKey) === flight) liveM2mFlight.delete(flightKey);
    }
};

const getMarketWatch = async (req, res) => {
    try {
        const [scrips] = await db.execute('SELECT * FROM scrip_data WHERE status = "OPEN"');
        res.json(scrips);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getIndices = async (req, res) => {
    try {
        const kiteService = require('../utils/kiteService');

        // Step 1: Try WebSocket prices (live, when market open)
        let nifty = marketDataService.getPrice('NSE:NIFTY 50') || {};
        let banknifty = marketDataService.getPrice('NSE:NIFTY BANK') || {};
        let finnifty = marketDataService.getPrice('NSE:NIFTY FIN SERVICE') || {};

        console.log('📊 Getting Indices - Kite Auth:', kiteService.isAuthenticated());
        console.log('📊 WebSocket Data:', { nifty: nifty.ltp, banknifty: banknifty.ltp, finnifty: finnifty.ltp });

        // Step 2: Always fetch from Kite REST API for full quote data (not just LTP)
        if (kiteService.isAuthenticated()) {
            try {
                const instruments = ['NSE:NIFTY 50', 'NSE:NIFTY BANK', 'NSE:NIFTY FIN SERVICE'];
                console.log('🔄 Fetching quotes from Zerodha Kite:', instruments);

                const quotes = await kiteService.getQuote(instruments);
                console.log('✅ Kite quotes received:', Object.keys(quotes || {}));

                if (quotes && typeof quotes === 'object') {
                    if (quotes['NSE:NIFTY 50']) {
                        const q = quotes['NSE:NIFTY 50'];
                        console.log('📈 NIFTY 50 Quote:', { ltp: q.last_price, bid: q.depth?.buy?.[0]?.price, ask: q.depth?.sell?.[0]?.price });
                        nifty = {
                            ltp: q.last_price || q.ohlc?.close || 0,
                            bid: q.depth?.buy?.[0]?.price || q.last_price || 0,
                            ask: q.depth?.sell?.[0]?.price || q.last_price || 0,
                            change: q.last_price && q.ohlc?.close ? q.last_price - q.ohlc.close : 0,
                            chg_pct: q.last_price && q.ohlc?.close ? (((q.last_price - q.ohlc.close) / q.ohlc.close) * 100).toFixed(2) : 0,
                            ohlc: q.ohlc || {}
                        };
                    }
                    if (quotes['NSE:NIFTY BANK']) {
                        const q = quotes['NSE:NIFTY BANK'];
                        banknifty = {
                            ltp: q.last_price || q.ohlc?.close || 0,
                            bid: q.depth?.buy?.[0]?.price || q.last_price || 0,
                            ask: q.depth?.sell?.[0]?.price || q.last_price || 0,
                            change: q.last_price && q.ohlc?.close ? q.last_price - q.ohlc.close : 0,
                            chg_pct: q.last_price && q.ohlc?.close ? (((q.last_price - q.ohlc.close) / q.ohlc.close) * 100).toFixed(2) : 0,
                            ohlc: q.ohlc || {}
                        };
                    }
                    if (quotes['NSE:NIFTY FIN SERVICE']) {
                        const q = quotes['NSE:NIFTY FIN SERVICE'];
                        finnifty = {
                            ltp: q.last_price || q.ohlc?.close || 0,
                            bid: q.depth?.buy?.[0]?.price || q.last_price || 0,
                            ask: q.depth?.sell?.[0]?.price || q.last_price || 0,
                            change: q.last_price && q.ohlc?.close ? q.last_price - q.ohlc.close : 0,
                            chg_pct: q.last_price && q.ohlc?.close ? (((q.last_price - q.ohlc.close) / q.ohlc.close) * 100).toFixed(2) : 0,
                            ohlc: q.ohlc || {}
                        };
                    }
                }
            } catch (restErr) {
                console.error('🔴 Kite API Error:', restErr.message);
            }
        } else {
            console.warn('⚠️  Kite NOT authenticated. Check /api/kite/status');
        }

        const toIndex = (raw, name) => {
            const ltp = raw.ltp || 0;
            return {
                name,
                ltp,
                bid: raw.bid || ltp,
                ask: raw.ask || ltp,
                change: raw.change || 0,
                chg_pct: raw.chg_pct || 0,
                high: raw.ohlc?.high || 0,
                low: raw.ohlc?.low || 0,
                open: raw.ohlc?.open || 0,
                close: raw.ohlc?.close || 0,
            };
        };

        const result = [
            toIndex(nifty, 'NIFTY 50'),
            toIndex(banknifty, 'NIFTY BANK'),
            toIndex(finnifty, 'NIFTY FIN SERVICE'),
        ];

        console.log('📊 Final Indices Response:', result.map(r => ({ name: r.name, ltp: r.ltp })));
        res.json(result);
    } catch (err) {
        console.error('🔴 getIndices Error:', err.message, err.stack);
        res.status(500).json({ error: err.message });
    }
};

const getWatchlist = async (req, res) => {
    try {
        const { hideSet, markSet } = await getUserBannedScripsStatus(req.user?.id, req.user?.role);
        const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
        const lotMap = {};
        lotRows.forEach(r => {
            lotMap[r.symbol.toUpperCase()] = parseFloat(r.lot_size || 1);
        });

        function isHidden(sym) {
            if (!sym || hideSet.size === 0) return false;
            const cleanSym = sym.includes(':') ? sym.split(':')[1] : sym;
            for (const h of hideSet) {
                const cleanH = h.includes(':') ? h.split(':')[1] : h;
                if (h === sym || cleanH === cleanSym) return true;
            }
            return false;
        }

        function isMarked(sym) {
            if (!sym || markSet.size === 0) return false;
            const cleanSym = sym.includes(':') ? sym.split(':')[1] : sym;
            for (const m of markSet) {
                const cleanM = m.includes(':') ? m.split(':')[1] : m;
                if (m === sym || cleanM === cleanSym) return true;
            }
            return false;
        }

        const allowedSegments = await getClientAllowedSegments(req.user?.id, req.user?.role);
        const prices = marketDataService.prices;
        const filteredKeys = Object.keys(prices).filter(symbol => {
            if (isHidden(symbol)) return false;
            if (!isScripSegmentAllowed(symbol, allowedSegments)) return false;
            if (symbol.startsWith('CRYPTO:') || symbol.startsWith('FOREX:') || symbol.startsWith('COMMODITY:')) {
                return symbol.includes('/');
            }
            return true;
        });

        const watchlist = filteredKeys.map((symbol, index) => {
            const data = prices[symbol];
            const symOnly = symbol.split(':')[1] || symbol;
            return {
                id: (index + 1).toString(),
                symbol: symbol,
                name: symOnly,
                category: data.type || 'NSE',
                ltp: data.ltp,
                bid: data.bid,
                ask: data.ask,
                change: data.chg_pct || 0,
                lotSize: lotMap[symOnly.toUpperCase()] || 1,
                isBanned: isMarked(symbol)
            };
        });
        res.json(watchlist);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = {
    getLiveMarket,
    getClientLiveM2M,
    getMarketWatch,
    getIndices,
    getWatchlist,
    getBrokerM2M: async (req, res) => {
        try {
            const brokerId = req.user.id;
            const db = require('../config/db');
            const mockEngine = require('../utils/mockEngine');
            const { getMcxBaseScrip } = require('../utils/symbolHelper');

            // 1. Get all traders under this broker (excluding demo accounts)
            const [traders] = await db.execute(
                'SELECT id, username, balance FROM users WHERE parent_id = ? AND role = "TRADER" AND is_demo = 0',
                [brokerId]
            );

            if (!traders.length) {
                return res.json([]);
            }

            const traderIds = traders.map(t => t.id);

            // 2. Get all open trades for these traders
            const [trades] = await db.execute(
                `SELECT t.id, t.user_id, t.symbol, t.type, t.qty, t.entry_price, t.market_type,
                        u.username
                 FROM trades t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.status IN ('OPEN', 'HOLD') AND t.user_id IN (${traderIds.join(',')})`,
                []
            );

            // 3. Calculate M2M for each trader
            const INSTRUMENT_META = {
                'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10,
                'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500, 'ZINC': 5000,
                'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
                'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1
            };

            const traderM2M = {};
            traders.forEach(t => {
                traderM2M[t.id] = {
                    user_id: t.id,
                    username: t.username,
                    live_pnl: 0,
                    active_trades: 0,
                    margin_used: 0
                };
            });

            // 4. Calculate P/L for each open trade
            for (const trade of trades) {
                let currentPrice = trade.entry_price;
                try {
                    const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
                    const marketType = (trade.market_type || 'MCX').toUpperCase();
                    const prefix = marketType === 'EQUITY' ? 'NSE' : (marketType === 'OPTIONS' ? 'NFO' : marketType);

                    const possibleSymbols = [trade.symbol, `${prefix}:${cleanSymbol}`, cleanSymbol];
                    let liveData = null;
                    for (const s of possibleSymbols) {
                        liveData = marketDataService.getPrice(s);
                        if (liveData) break;
                    }

                    if (liveData && liveData.ltp) {
                        currentPrice = liveData.ltp;
                    }
                } catch (_) { }

                let pnl = 0;
                const baselinePrice = (trade.is_carried_forward || trade.status === 'HOLD') && trade.last_settlement_price !== null && trade.last_settlement_price !== undefined
                    ? parseFloat(trade.last_settlement_price)
                    : parseFloat(trade.entry_price);

                const commodityLotService = require('../services/CommodityLotService');
                if (commodityLotService.isCommodityScrip(trade.symbol, trade.market_type)) {
                    const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, baselinePrice, currentPrice, trade.qty);
                    pnl = calc.pnlInr;
                } else {
                    const { calculateEquityPnL, calculateMcxPnL } = require('../utils/equityPnL');
                    const mktType = (trade.market_type || '').toUpperCase();
                    const isMcx = mktType === 'MCX' || (trade.symbol || '').toUpperCase().startsWith('MCX:') ||
                        ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'].some(k => (trade.symbol || '').toUpperCase().includes(k));
                    const tradeLot = trade.lot_size_at_entry || trade.lot_size || getMultiplier(trade.symbol, mktType) || 1;
                    if (isMcx) {
                        pnl = calculateMcxPnL({
                            type: trade.type,
                            entryPrice: baselinePrice,
                            exitPrice: currentPrice,
                            qty: trade.qty,
                            qtyInput: trade.qty_input,
                            lotSize: tradeLot
                        });
                    } else {
                        pnl = calculateEquityPnL({
                            type: trade.type,
                            entryPrice: baselinePrice,
                            exitPrice: currentPrice,
                            qty: trade.qty,
                            qtyInput: trade.qty_input,
                            actualQty: trade.actual_qty,
                            lotSize: tradeLot,
                            tradeMode: trade.trade_mode,
                            equityUnitsMode: trade.equity_units_mode
                        });
                    }
                }

                if (traderM2M[trade.user_id]) {
                    traderM2M[trade.user_id].live_pnl += pnl;
                    traderM2M[trade.user_id].active_trades += 1;
                }
            }

            // 5. Return as array
            const result = Object.values(traderM2M);
            res.json(result);
        } catch (err) {
            console.error('getBrokerM2M error:', err);
            res.status(500).json({ error: err.message });
        }
    }
};

