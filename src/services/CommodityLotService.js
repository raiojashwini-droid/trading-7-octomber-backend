const db = require('../config/db');

class CommodityLotService {
    constructor() {
        this.cache = new Map(); // cleanSymbol -> { lot_size, usdinr_value, category }
        this.isLoaded = false;
    }

    async load() {
        try {
            const [rows] = await db.query('SELECT symbol, category, lot_size, usdinr_value FROM commodity_forex_crypto_lot_sizes');
            this.cache.clear();
            for (const row of rows) {
                const clean = this.cleanSymbol(row.symbol);
                const norm = clean.replace(/[\s\/\_\-]+/g, '');
                const itemData = {
                    symbol: row.symbol,
                    category: (row.category || '').toUpperCase(),
                    lot_size: parseFloat(row.lot_size || 1),
                    usdinr_value: parseFloat(row.usdinr_value || 95.1)
                };
                this.cache.set(clean, itemData);
                if (norm && norm !== clean) {
                    this.cache.set(norm, itemData);
                }
            }
            this.isLoaded = true;
            console.log(`💼 Commodity/Forex Lot Sizes loaded: ${this.cache.size} symbols cached.`);
        } catch (err) {
            console.error('❌ Error loading commodity/forex lot sizes:', err.message);
        }
    }

    cleanSymbol(symbol) {
        if (!symbol) return '';
        let clean = symbol.toUpperCase();
        const prefixes = ['COMMODITY:', 'FOREX:', 'CRYPTO:', 'MCX:', 'NSE:', 'NFO:', 'COMEX:'];
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of prefixes) {
                if (clean.startsWith(p)) {
                    clean = clean.substring(p.length);
                    changed = true;
                }
            }
        }
        return clean;
    }

    getLotInfo(symbol) {
        if (!symbol) return null;
        const clean = this.cleanSymbol(symbol);
        const norm = clean.replace(/[\s\/\_\-]+/g, '');
        return this.cache.get(clean) || this.cache.get(norm) || null;
    }

    /**
     * Checks if a symbol or market type belongs to COMMODITY category from the DB config
     */
    isCommodityScrip(symbol, marketType) {
        const mType = (marketType || '').toUpperCase();
        const rawSym = (symbol || '').toUpperCase();

        // 1. Strict segment-based check:
        // If market_type is COMMODITY, COMEX, FOREX, or CRYPTO -> It IS a USD Commodity/Forex segment!
        if (mType === 'COMMODITY' || mType === 'COMEX' || mType === 'FOREX' || mType === 'CRYPTO') {
            return true;
        }

        // 2. If market_type is MCX, NSE, NFO, EQUITY, or OPTIONS -> It is an Indian INR segment!
        if (mType === 'MCX' || mType === 'NSE' || mType === 'NFO' || mType === 'EQUITY' || mType === 'OPTIONS') {
            return false;
        }

        // 3. Check if symbol explicitly starts with MCX:, NSE:, NFO:
        if (rawSym.startsWith('MCX:') || rawSym.startsWith('NSE:') || rawSym.startsWith('NFO:')) {
            return false;
        }

        // 4. Check if symbol is a known MCX base scrip (e.g., COPPER, MCOPPER, LEAD, GOLD, SILVER, CRUDEOIL, etc.)
        const { getMcxBaseScrip } = require('../utils/symbolHelper');
        if (getMcxBaseScrip(symbol)) {
            return false;
        }

        // 5. Fallback check if marketType is unassigned/empty
        const info = this.getLotInfo(symbol);
        if (info) {
            const cat = (info.category || '').toUpperCase();
            if (cat === 'COMMODITY' || cat === 'FOREX' || cat === 'CRYPTO' || cat === 'COMEX') {
                return true;
            }
        }
        return false;
    }

    /**
     * Calculate PnL for COMMODITY using live USD/INR bid/ask from MarketDataService.
     * - Loss  → use bid  (which FastForex sets as ltp × 1.10)
     * - Profit → use ask (which FastForex sets as ltp × 0.90)
     * Falls back to DB usdinr_value if live data is unavailable.
     */
    calculatePnL(symbol, type, entryPrice, cmp, qty) {
        const info = this.getLotInfo(symbol);
        const lotSize = info ? info.lot_size : 1;
        const fallbackUsdInr = info ? info.usdinr_value : 95.1;

        // Get live USD/INR bid & ask from MarketDataService
        let liveBid = null;
        let liveAsk = null;
        try {
            const marketDataService = require('./MarketDataService');
            if (marketDataService && marketDataService.prices) {
                const liveUsdInr = marketDataService.prices['FOREX:USD/INR'] || marketDataService.prices['FOREX:USDINR'];
                if (liveUsdInr) {
                    liveBid = parseFloat(liveUsdInr.bid) || null; // ltp × 1.10 (set by FastForex)
                    liveAsk = parseFloat(liveUsdInr.ask) || null; // ltp × 0.90 (set by FastForex)
                }
            }
        } catch (e) {
            // Silently fall back
        }

        const { calculateUsdPnL } = require('../utils/usdPnL');
        const res = calculateUsdPnL({
            symbol,
            type,
            entryPrice,
            exitPrice: cmp,
            qty,
            lotSize,
            fallbackUsdInr,
            liveBid,
            liveAsk
        });

        return {
            pnlUsd: res.pnlUsd,
            pnlInr: res.pnlInr,
            lotSize,
            usdInr: res.usdInrRate
        };
    }
}

module.exports = new CommodityLotService();
