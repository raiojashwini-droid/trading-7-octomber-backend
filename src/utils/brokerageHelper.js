/**
 * Standardized Centralized Brokerage Calculation Helper
 * Supports all segments: EQUITY, NFO FUTURES, NFO OPTIONS, MCX, COMEX, FOREX, CRYPTO.
 * Handles both Lot Mode and Unit Mode seamlessly without breaking existing functionality.
 */

function cleanSymbolName(symbol) {
    if (!symbol) return '';
    const str = String(symbol).toUpperCase();
    return str.includes(':') ? str.split(':')[1] : str;
}

function calcBrokerageFromRate({
    rate,
    brokerageType = 'PER_CRORE',
    qty = 0,
    qtyInput = null,
    actualQty = null,
    lotSize = 1,
    entryPrice = 0,
    exitPrice = 0,
    isUnitMode = false,
    isIndianSegment = true,
    usdInrRate = 83.5
}) {
    const r = Math.abs(parseFloat(rate || 0));
    if (r <= 0 || isNaN(r)) return 0;

    const entry = parseFloat(entryPrice || 0);
    const exit = parseFloat(exitPrice || entry || 0);
    const lot = parseFloat(lotSize || 1);
    const type = (brokerageType || 'PER_CRORE').toUpperCase().replace(/\s+/g, '_');

    let baseLotsCount = parseFloat(qtyInput != null ? qtyInput : qty || 0);
    let totalSharesOrUnits = 0;

    if (actualQty != null && !isNaN(parseFloat(actualQty)) && parseFloat(actualQty) > 0) {
        totalSharesOrUnits = parseFloat(actualQty);
        if (isIndianSegment && isUnitMode && lot > 0) {
            baseLotsCount = totalSharesOrUnits / lot; // Proportional fraction of a lot!
        }
    } else if (isIndianSegment) {
        if (isUnitMode) {
            totalSharesOrUnits = baseLotsCount;
            baseLotsCount = lot > 0 ? (totalSharesOrUnits / lot) : totalSharesOrUnits; // Proportional fraction of a lot!
        } else {
            totalSharesOrUnits = baseLotsCount * lot;
        }
    } else {
        totalSharesOrUnits = baseLotsCount * lot;
    }

    if (type === 'PER_LOT' || type === 'PER_UNIT') {
        return Math.max(0, baseLotsCount * r);
    }

    // PER_CRORE (Turnover based)
    let turnoverInr = (entry + exit) * totalSharesOrUnits;
    if (!isIndianSegment) {
        turnoverInr = turnoverInr * usdInrRate;
    }

    const calculated = (turnoverInr / 10000000) * r;
    return Math.max(0, calculated);
}

function calculateTradeBrokerage({
    symbol = '',
    marketType = 'EQUITY',
    entryPrice = 0,
    exitPrice = 0,
    qty = 0,
    qtyInput = null,
    actualQty = null,
    lotSize = 1,
    tradeMode = null,
    equityUnitsMode = 0,
    clientConfig = {},
    userSegmentRow = null,
    usdInrRate = 83.5
}) {
    const cleanSym = cleanSymbolName(symbol);
    let mType = (marketType || 'EQUITY').toUpperCase();
    if (mType === 'COMMODITY') mType = 'COMEX';

    const isOption = cleanSym.endsWith('CE') || cleanSym.endsWith('PE') || mType === 'OPTIONS';
    const isMcx = mType === 'MCX';
    const isIndian = ['MCX', 'EQUITY', 'NSE', 'NFO', 'OPTIONS'].includes(mType);

    const isUnitMode =
        tradeMode === 'UNITS' ||
        tradeMode === 'UNIT' ||
        equityUnitsMode === 1 ||
        equityUnitsMode === true ||
        equityUnitsMode === '1' ||
        equityUnitsMode === 'true' ||
        clientConfig.trade_equity_units === 1 ||
        clientConfig.trade_equity_units === '1' ||
        clientConfig.trade_equity_units === true ||
        (actualQty != null && parseFloat(actualQty) > 0 && parseFloat(actualQty) < lotSize);

    // 1. Scrip-Specific Flat Rate from Config (Priority 1)
    let scripRate = undefined;
    if (isMcx) {
        const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
        if (brokerageType === 'per_lot') {
            const lotBrokerageMap = { ...clientConfig.brokerMcxBrokerage, ...clientConfig.mcxLotBrokerage };
            if (lotBrokerageMap[cleanSym] !== undefined) {
                scripRate = parseFloat(lotBrokerageMap[cleanSym]);
            } else {
                const sortedKeys = Object.keys(lotBrokerageMap).sort((a, b) => b.length - a.length);
                for (const key of sortedKeys) {
                    if (cleanSym.startsWith(key.toUpperCase().replace(/\s+/g, ''))) {
                        scripRate = parseFloat(lotBrokerageMap[key]);
                        break;
                    }
                }
            }
        }
    } else if (mType === 'EQUITY' || mType === 'NSE' || mType === 'NFO') {
        const equityMap = clientConfig.brokerEquityBrokerage || {};
        if (typeof equityMap === 'object' && equityMap !== null && !Array.isArray(equityMap)) {
            if (equityMap[cleanSym] !== undefined) {
                scripRate = parseFloat(equityMap[cleanSym]);
            } else {
                const sortedKeys = Object.keys(equityMap).sort((a, b) => b.length - a.length);
                for (const key of sortedKeys) {
                    if (cleanSym.startsWith(key.toUpperCase())) {
                        scripRate = parseFloat(equityMap[key]);
                        break;
                    }
                }
            }
        }
    }

    if (scripRate !== undefined && !isNaN(scripRate) && scripRate > 0) {
        return calcBrokerageFromRate({
            rate: scripRate,
            brokerageType: 'PER_LOT',
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode,
            isIndianSegment: isIndian,
            usdInrRate
        });
    }

    // 2. user_segments table row (Priority 2)
    if (userSegmentRow && parseFloat(userSegmentRow.brokerage_value) > 0) {
        let segType = (userSegmentRow.brokerage_type || 'PER_LOT').toUpperCase();
        // Equity Futures & Stocks are ALWAYS PER_CRORE
        if (mType === 'EQUITY' || mType === 'NSE' || (mType === 'NFO' && !isOption)) {
            segType = 'PER_CRORE';
        }
        return calcBrokerageFromRate({
            rate: userSegmentRow.brokerage_value,
            brokerageType: segType,
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode,
            isIndianSegment: isIndian,
            usdInrRate
        });
    }

    // 3. client_settings config fallback (Priority 3)
    if (isMcx) {
        const bType = (clientConfig.mcxBrokerageType || 'per_crore').toUpperCase();
        const rate = parseFloat(clientConfig.mcxBrokerage || 0);
        return calcBrokerageFromRate({
            rate,
            brokerageType: bType,
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode: false,
            isIndianSegment: true,
            usdInrRate
        });
    }

    if (isOption) {
        let rate = 0;
        let bType = 'PER_LOT';
        if (cleanSym.includes('NIFTY') || cleanSym.includes('BANKNIFTY') || cleanSym.includes('FINNIFTY') || cleanSym.includes('SENSEX')) {
            rate = parseFloat(
                clientConfig.brokerOptionsIndexBrokerage ||
                clientConfig.optionsIndexBrokerage ||
                clientConfig.options_index_brokerage ||
                20
            );
            bType = (clientConfig.optionsIndexBrokerageType || clientConfig.options_index_brokerage_type || 'PER_LOT').toUpperCase();
        } else if (cleanSym.includes('MCX')) {
            rate = parseFloat(
                clientConfig.brokerOptionsMcxBrokerage ||
                clientConfig.optionsMcxBrokerage ||
                clientConfig.options_mcx_brokerage ||
                20
            );
            bType = (clientConfig.optionsMcxBrokerageType || clientConfig.options_mcx_brokerage_type || 'PER_LOT').toUpperCase();
        } else {
            rate = parseFloat(
                clientConfig.brokerOptionsEquityBrokerage ||
                clientConfig.optionsEquityBrokerage ||
                clientConfig.options_equity_brokerage ||
                20
            );
            bType = (clientConfig.optionsEquityBrokerageType || clientConfig.options_equity_brokerage_type || 'PER_LOT').toUpperCase();
        }
        return calcBrokerageFromRate({
            rate,
            brokerageType: bType,
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode,
            isIndianSegment: true,
            usdInrRate
        });
    }

    // Equity Futures & Cash Stocks -> ALWAYS PER_CRORE
    if (mType === 'EQUITY' || mType === 'NSE' || mType === 'NFO') {
        const rate = parseFloat(
            clientConfig.equityBrokerage ||
            clientConfig.brokerEquityBrokerage ||
            clientConfig.equity_brokerage ||
            clientConfig.broker_equity_brokerage ||
            800
        );
        return calcBrokerageFromRate({
            rate,
            brokerageType: 'PER_CRORE',
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode,
            isIndianSegment: true,
            usdInrRate
        });
    }

    if (mType === 'COMEX') {
        const comexCfg = clientConfig.comexConfig || {};
        const rate = parseFloat(comexCfg.brokerage || clientConfig.comexBrokerage || 0);
        const bType = comexCfg.brokerageType || clientConfig.comexBrokerageType || 'per_lot';
        return calcBrokerageFromRate({
            rate,
            brokerageType: bType,
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode: false,
            isIndianSegment: false,
            usdInrRate
        });
    }

    if (mType === 'FOREX') {
        const forexCfg = clientConfig.forexConfig || {};
        const rate = parseFloat(forexCfg.brokerage || clientConfig.forexBrokerage || 0);
        const bType = forexCfg.brokerageType || clientConfig.forexBrokerageType || 'per_lot';
        return calcBrokerageFromRate({
            rate,
            brokerageType: bType,
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode: false,
            isIndianSegment: false,
            usdInrRate
        });
    }

    if (mType === 'CRYPTO') {
        const cryptoCfg = clientConfig.cryptoConfig || {};
        const rate = parseFloat(cryptoCfg.brokerage || clientConfig.cryptoBrokerage || 0);
        const bType = cryptoCfg.brokerageType || clientConfig.cryptoBrokerageType || 'per_lot';
        return calcBrokerageFromRate({
            rate,
            brokerageType: bType,
            qty,
            qtyInput,
            actualQty,
            lotSize,
            entryPrice,
            exitPrice,
            isUnitMode: false,
            isIndianSegment: false,
            usdInrRate
        });
    }

    return 0;
}

module.exports = {
    cleanSymbolName,
    calcBrokerageFromRate,
    calculateTradeBrokerage
};
