/**
 * Standardized PnL Calculation Helper Functions
 */

/**
 * 1. Equity & NFO Futures/Options Dedicated Helper
 */
function calculateEquityPnL({
    type,
    entryPrice,
    exitPrice,
    qty,
    qtyInput,
    actualQty,
    lotSize = 1,
    tradeMode = null,
    equityUnitsMode = 0
}) {
    const entry = parseFloat(entryPrice || 0);
    const exit = parseFloat(exitPrice || 0);
    const lot = parseFloat(lotSize || 1);

    const isUnitMode =
        tradeMode === 'UNITS' ||
        equityUnitsMode === 1 ||
        equityUnitsMode === true ||
        equityUnitsMode === '1' ||
        equityUnitsMode === 'true';

    let totalShares = 0;
    if (actualQty != null && !isNaN(parseFloat(actualQty)) && parseFloat(actualQty) > 0) {
        totalShares = parseFloat(actualQty);
    } else if (qtyInput != null && !isNaN(parseFloat(qtyInput))) {
        const qIn = parseFloat(qtyInput);
        totalShares = isUnitMode ? qIn : (qIn * lot);
    } else {
        const q = parseFloat(qty || 0);
        totalShares = isUnitMode ? q : (q * lot);
    }

    const priceDiff = (type || '').toUpperCase() === 'BUY' ? (exit - entry) : (entry - exit);
    return priceDiff * totalShares;
}

/**
 * 2. MCX Commodities Dedicated Helper
 */
function calculateMcxPnL({
    type,
    entryPrice,
    exitPrice,
    qty,
    qtyInput,
    lotSize = 1
}) {
    const entry = parseFloat(entryPrice || 0);
    const exit = parseFloat(exitPrice || 0);
    const lot = parseFloat(lotSize || 1);
    const lotsCount = parseFloat(qtyInput != null ? qtyInput : qty || 0);

    // MCX is strictly traded in Lots * LotSize
    const totalUnits = lotsCount * lot;

    const priceDiff = (type || '').toUpperCase() === 'BUY' ? (exit - entry) : (entry - exit);
    return priceDiff * totalUnits;
}

module.exports = { calculateEquityPnL, calculateMcxPnL };
