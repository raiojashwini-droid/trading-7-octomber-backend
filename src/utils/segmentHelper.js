/**
 * segmentHelper.js - Fixed isOptionsSymbol to avoid false positives like RELIANCE ending in CE
 */

const INDEX_OPTION_PREFIXES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
const MCX_COMMODITY_PREFIXES = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'];

/**
 * Detect if symbol is an options instrument.
 * Options symbols have a digit before the CE/PE suffix (e.g. BANKNIFTY26OCT56400CE, GOLD78000CE)
 * Plain stocks like RELIANCE, FINANCE end in CE/PE accidentally - exclude them.
 */
function isOptionsSymbol(symbol) {
    const upper = (symbol || '').toUpperCase().split(':').pop().trim();
    // Must end with CE or PE AND have a digit just before CE/PE
    // e.g. 56400CE ✅  RELIANCE ❌  TATASTEEL170CE ✅
    return /\d(CE|PE)$/.test(upper);
}

function getOptionSubType(symbol, marketType) {
    const upper = (symbol || '').toUpperCase().split(':').pop().trim();
    const mType = (marketType || '').toUpperCase();
    if (mType === 'MCX') return 'MCX_OPTION';
    if (INDEX_OPTION_PREFIXES.some(k => upper.startsWith(k))) return 'INDEX_OPTION';
    return 'EQUITY_OPTION';
}

/**
 * Get intraday + holding exposure for a symbol based on client config.
 */
function getSegmentExposure(symbol, marketType, clientConfig) {
    const cfg = clientConfig || {};
    const mType = (marketType || '').toUpperCase();

    const getVal = (...keys) => {
        for (const k of keys) {
            if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '') {
                const parsed = parseFloat(cfg[k]);
                if (!isNaN(parsed) && parsed > 0) return parsed;
            }
        }
        return null;
    };

    // 1. MCX Futures (not options)
    if (mType === 'MCX' && !isOptionsSymbol(symbol)) {
        const expType = cfg.mcxExposureType || cfg.mcx_exposure_type || 'per_lot';
        const isTurnover = expType === 'per_turnover' || expType === 'PER_TURNOVER_BASIS' || expType === 'per_crore';
        return {
            intradayExposure: getVal('mcxIntradayMargin', 'mcx_intraday_margin', 'intradayMarginMCX', 'mcx_intraday_exposure', 'mcxIntradayExposure') || 500,
            holdingExposure:  getVal('mcxHoldingMargin', 'mcx_holding_margin', 'holdingMarginMCX', 'mcx_holding_exposure', 'mcxHoldingExposure') || 100,
            segmentType: 'MCX_FUTURES',
            isTurnover
        };
    }

    // 2. Options instruments
    if (isOptionsSymbol(symbol)) {
        const subType = getOptionSubType(symbol, marketType);
        if (subType === 'MCX_OPTION') {
            return {
                intradayExposure: getVal('optionsMcxIntraday', 'options_mcx_intraday', 'optionsMcxIntradayMargin', 'options_mcx_intraday_margin') || 500,
                holdingExposure:  getVal('optionsMcxHolding', 'options_mcx_holding', 'optionsMcxHoldingMargin', 'options_mcx_holding_margin') || 100,
                segmentType: 'MCX_OPTION', isTurnover: true
            };
        }
        if (subType === 'INDEX_OPTION') {
            return {
                intradayExposure: getVal('optionsIndexIntraday', 'options_index_intraday', 'optionsIndexIntradayMargin', 'options_index_intraday_margin') || 500,
                holdingExposure:  getVal('optionsIndexHolding', 'options_index_holding', 'optionsIndexHoldingMargin', 'options_index_holding_margin') || 100,
                segmentType: 'INDEX_OPTION', isTurnover: true
            };
        }
        return {
            intradayExposure: getVal('optionsEquityIntraday', 'options_equity_intraday', 'optionsEquityIntradayMargin', 'options_equity_intraday_margin', 'equityIntradayMargin') || 500,
            holdingExposure:  getVal('optionsEquityHolding', 'options_equity_holding', 'optionsEquityHoldingMargin', 'options_equity_holding_margin', 'equityHoldingMargin') || 100,
            segmentType: 'EQUITY_OPTION', isTurnover: true
        };
    }

    // 3. NSE Equity / NFO plain stocks
    if (mType === 'NSE' || mType === 'EQUITY' || mType === 'NFO') {
        return {
            intradayExposure: getVal('equityIntradayMargin', 'equity_intraday_margin', 'intradayMarginEquity', 'equityIntradayExposure', 'equity_intraday_exposure') || 500,
            holdingExposure:  getVal('equityHoldingMargin', 'equity_holding_margin', 'holdingMarginEquity', 'equityHoldingExposure', 'equity_holding_exposure') || 100,
            segmentType: 'NSE_EQUITY', isTurnover: true
        };
    }

    // 4. COMEX / FOREX / CRYPTO / COMMODITY
    const segConfig = cfg[mType.toLowerCase() + 'Config'] || cfg[mType.toLowerCase() + '_config'] || {};
    return {
        intradayExposure: parseFloat(segConfig.intradayMargin || segConfig.intraday_margin || segConfig.intradayExposure || 500) || 500,
        holdingExposure:  parseFloat(segConfig.holdingMargin || segConfig.holding_margin || segConfig.holdingExposure || 100) || 100,
        segmentType: mType, isTurnover: true
    };
}

module.exports = { getSegmentExposure, isOptionsSymbol, getOptionSubType };
