const { calculateSegmentMargin } = require('./segmentMargin');

const MarginUtils = {
    /**
     * Calculates the total holding margin required for a list of open trades.
     * Uses standardized segmentMargin calculation engine.
     */
    calculateTotalRequiredHoldingMargin(trades, clientConfig = {}) {
        if (!Array.isArray(trades) || trades.length === 0) return 0;

        let totalMargin = 0;
        const isUnitMode = clientConfig?.tradeEquityUnits === 1 || clientConfig?.tradeEquityUnits === true || clientConfig?.trade_equity_units === 1;

        for (const trade of trades) {
            const qtyNum = Math.abs(parseFloat(trade.qty || 0));
            const entryPrice = parseFloat(trade.entry_price || trade.entryPrice || trade.price || 0);

            if (qtyNum <= 0 || entryPrice <= 0) continue;

            const mType = (trade.market || trade.market_type || trade.marketType || 'MCX').toUpperCase();
            const symbol = trade.symbol || trade.name || trade.displayName || '';
            const lotSize = parseFloat(trade.lot_size || trade.lot_size_at_entry || trade.multiplier || 1);

            const tradeMargin = calculateSegmentMargin({
                marketType: mType,
                symbol: symbol,
                price: entryPrice,
                qty: qtyNum,
                lotSize: lotSize,
                isHolding: true,
                clientConfig: clientConfig || {},
                isUnitMode: isUnitMode
            });

            totalMargin += (tradeMargin > 0 ? tradeMargin : 0);
        }

        return totalMargin;
    },

    getMcxBaseScrip(symbol, configKeys) {
        if (!symbol) return '';
        const s = symbol.split(':').pop().toUpperCase();
        const cleanS = s.replace(/\s+/g, '');

        if (configKeys) {
            const sortedKeys = Object.keys(configKeys).sort((a, b) => b.length - a.length);
            for (const key of sortedKeys) {
                const cleanKey = key.replace(/\s+/g, '').toUpperCase();
                if (cleanS.startsWith(cleanKey)) return key;
            }
        }

        const match = s.match(/^([A-Z]+)/);
        return match ? match[1] : s;
    }
};

module.exports = MarginUtils;
