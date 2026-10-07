/**
 * Standardized USD Segments PnL Calculation Helper Functions (Crypto, Forex, Comex)
 */

/**
 * 1. Base Core USD Segment PnL Calculator
 */
function calculateUsdPnL({
    symbol = '',
    type,
    entryPrice,
    exitPrice,
    qty,
    qtyInput,
    lotSize = 1,
    fallbackUsdInr = 95.1,
    liveBid = null,
    liveAsk = null
}) {
    const entry = parseFloat(entryPrice || 0);
    const exit = parseFloat(exitPrice || 0);
    const lot = parseFloat(lotSize || 1);
    const quantity = parseFloat(qtyInput != null ? qtyInput : qty || 0);

    const priceDiff = (type || '').toUpperCase() === 'BUY' ? (exit - entry) : (entry - exit);
    const pnlRaw = priceDiff * lot * quantity;

    const symClean = String(symbol || '').toUpperCase().replace(/[\s\/\_\-]+/g, '');
    const isDirectInrPair = symClean.endsWith('USDINR') || symClean === 'USDINR';

    let usdInrRate = 1;
    let pnlInr = 0;
    let pnlUsd = 0;

    if (isDirectInrPair) {
        // USD/INR pair prices (e.g. 86.68 -> 105.95) are ALREADY in Indian Rupees (₹/USD).
        // PnL in INR = priceDiff * lotSize * quantity (no double conversion)
        pnlInr = pnlRaw;
        const currentRate = (liveAsk != null && !isNaN(parseFloat(liveAsk))) ? parseFloat(liveAsk) : parseFloat(fallbackUsdInr || 86.65);
        pnlUsd = currentRate > 0 ? (pnlInr / currentRate) : pnlInr;
        usdInrRate = 1;
    } else {
        // Foreign Pairs (EUR/USD, GBP/USD, BTC/USDT, XAU/USD) - prices in USD
        pnlUsd = pnlRaw;
        if (pnlUsd >= 0) {
            usdInrRate = (liveAsk != null && !isNaN(parseFloat(liveAsk)) && parseFloat(liveAsk) > 0)
                ? parseFloat(liveAsk)
                : (parseFloat(fallbackUsdInr || 95.1) * 0.90);
        } else {
            usdInrRate = (liveBid != null && !isNaN(parseFloat(liveBid)) && parseFloat(liveBid) > 0)
                ? parseFloat(liveBid)
                : (parseFloat(fallbackUsdInr || 95.1) * 1.10);
        }
        pnlInr = pnlUsd * usdInrRate;
    }

    return { pnlUsd, pnlInr, usdInrRate };
}

/**
 * 2. Dedicated Crypto PnL Helper (e.g., BTC/USDT, ETH/USDT, SOL/USDT)
 */
function calculateCryptoPnL(params) {
    return calculateUsdPnL(params);
}

/**
 * 3. Dedicated Forex PnL Helper (e.g., EUR/USD, GBP/USD, USD/INR)
 */
function calculateForexPnL(params) {
    return calculateUsdPnL(params);
}

/**
 * 4. Dedicated Comex Commodity PnL Helper (e.g., XAU/USD Gold, XAG/USD Silver, USOIL)
 */
function calculateComexPnL(params) {
    return calculateUsdPnL(params);
}

module.exports = {
    calculateUsdPnL,
    calculateCryptoPnL,
    calculateForexPnL,
    calculateComexPnL
};
