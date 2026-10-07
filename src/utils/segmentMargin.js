/**
 * Standardized Segment Margin Calculator for Node.js Backend
 */

const getMcxBaseScrip = (symbol = '') => {
  if (!symbol) return '';
  const clean = symbol.toUpperCase().trim();
  return clean.replace(/[0-9]+[A-Z]*/g, '').replace(/FUT$/i, '').trim() || clean;
};

const isMcxSymbol = (symbol = '') => {
  if (!symbol) return false;
  const sym = symbol.toUpperCase();
  const clean = sym.split(':').pop().replace(/[0-9]+[A-Z]*/g, '').replace(/FUT$/i, '').trim();
  return sym.startsWith('MCX:') ||
    ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD',
     'ALUMINIUM', 'MENTHAOIL', 'COTTON', 'BULLDEX', 'MCRUDEOIL', 'MNATURALGAS', 'MGOLD', 'MSILVER', 'SILVERMIC'].some(k => clean.startsWith(k));
};

const isOptionsSymbol = (symbol = '') => {
  if (!symbol) return false;
  const upper = symbol.toUpperCase().split(':').pop().trim();
  return /\d(CE|PE)$/.test(upper) || upper.endsWith('CE') || upper.endsWith('PE');
};

const calculateSegmentMargin = ({
  marketType = 'MCX',
  symbol = '',
  price = 0,
  qty = 1,
  lotSize = 1,
  isHolding = false,
  clientConfig = {},
  isUnitMode = false,
  fallbackUsdInr = 86.68
}) => {
  let mType = (marketType || '').toUpperCase().trim();
  const priceNum = parseFloat(price) || 0;
  const qtyNum = parseFloat(qty) || 0;
  const lotVal = parseFloat(lotSize) || 1;
  const tradeType = isHolding ? 'HOLDING' : 'INTRADAY';

  const cfg = clientConfig || {};

  // Auto-correct marketType if symbol is clearly MCX, FOREX, CRYPTO, COMEX, COMMODITY
  const upperSym = (symbol || '').toUpperCase().trim();
  if (isMcxSymbol(symbol)) {
    mType = 'MCX';
  } else if (upperSym.startsWith('FOREX:') || upperSym.includes('AUD/') || upperSym.includes('EUR/') || upperSym.includes('GBP/') || upperSym.includes('USD/')) {
    mType = 'FOREX';
  } else if (upperSym.startsWith('CRYPTO:') || upperSym.includes('BTC/') || upperSym.includes('ETH/')) {
    mType = 'CRYPTO';
  } else if (upperSym.startsWith('COMEX:') || upperSym.startsWith('COMMODITY:') || upperSym.includes('USOIL') || upperSym.includes('NGAS') || upperSym.includes('XAU/') || upperSym.includes('XAG/')) {
    mType = 'COMEX';
  }

  let exposureType = 'PER_LOT_BASIS';
  let intradayExp = 500;
  let holdingExp = 100;
  let lotMargins = {};

  const isOption = isOptionsSymbol(symbol) || mType === 'OPTIONS';

  const getVal = (...keys) => {
    for (const k of keys) {
      if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '') {
        const parsed = parseFloat(cfg[k]);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    }
    return null;
  };

  if (mType === 'MCX' && !isOption) {
    exposureType = cfg.mcxExposureType || cfg.mcx_exposure_type || 'PER_LOT_BASIS';
    intradayExp = getVal('mcxIntradayMargin', 'mcx_intraday_margin', 'intradayMarginMCX', 'mcx_intraday_exposure', 'mcxIntradayExposure') || 500;
    holdingExp = getVal('mcxHoldingMargin', 'mcx_holding_margin', 'holdingMarginMCX', 'mcx_holding_exposure', 'mcxHoldingExposure') || 100;
    lotMargins = cfg.mcxLotMargins || cfg.mcx_lot_margins || {};
  } else if (isOption) {
    exposureType = cfg.optionsExposureType || cfg.options_exposure_type || 'PER_TURNOVER_BASIS';
    const cleanSym = (symbol || '').toUpperCase().split(':').pop().trim();
    const isIndexOpt = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].some(k => cleanSym.startsWith(k));
    const isMcxOpt = mType === 'MCX' || ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER'].some(k => cleanSym.startsWith(k));

    if (isMcxOpt) {
      intradayExp = getVal('optionsMcxIntraday', 'options_mcx_intraday', 'optionsMcxIntradayMargin', 'options_mcx_intraday_margin') || 500;
      holdingExp = getVal('optionsMcxHolding', 'options_mcx_holding', 'optionsMcxHoldingMargin', 'options_mcx_holding_margin') || 100;
    } else if (isIndexOpt) {
      intradayExp = getVal('optionsIndexIntraday', 'options_index_intraday', 'optionsIndexIntradayMargin', 'options_index_intraday_margin') || 500;
      holdingExp = getVal('optionsIndexHolding', 'options_index_holding', 'optionsIndexHoldingMargin', 'options_index_holding_margin') || 100;
    } else {
      intradayExp = getVal('optionsEquityIntraday', 'options_equity_intraday', 'optionsEquityIntradayMargin', 'options_equity_intraday_margin', 'equityIntradayMargin') || 500;
      holdingExp = getVal('optionsEquityHolding', 'options_equity_holding', 'optionsEquityHoldingMargin', 'options_equity_holding_margin', 'equityHoldingMargin') || 100;
    }
    lotMargins = cfg.optionsLotMargins || cfg.options_lot_margins || {};
  } else if (mType === 'EQUITY' || mType === 'NSE' || mType === 'NFO') {
    exposureType = 'PER_TURNOVER_BASIS';
    intradayExp = getVal('equityIntradayMargin', 'equity_intraday_margin', 'intradayMarginEquity', 'equityIntradayExposure', 'equity_intraday_exposure') || 500;
    holdingExp = getVal('equityHoldingMargin', 'equity_holding_margin', 'holdingMarginEquity', 'equityHoldingExposure', 'equity_holding_exposure') || 100;
    lotMargins = cfg.equityLotMargins || cfg.equity_lot_margins || {};
  } else if (['COMEX', 'FOREX', 'CRYPTO', 'COMMODITY'].includes(mType)) {
    const lowType = mType.toLowerCase();
    
    // Check root-level key aliases first (including comex/commodity cross-aliases)
    const rootIntraday = getVal(
      `${lowType}IntradayMargin`, `${lowType}_intraday_margin`,
      `${lowType}IntradayExposure`, `${lowType}_intraday_exposure`,
      `${lowType}Intraday`, `${lowType}_intraday`,
      'comexIntradayMargin', 'comex_intraday_margin', 'comexIntradayExposure', 'commodityIntradayMargin'
    );
    const rootHolding = getVal(
      `${lowType}HoldingMargin`, `${lowType}_holding_margin`,
      `${lowType}HoldingExposure`, `${lowType}_holding_exposure`,
      `${lowType}Holding`, `${lowType}_holding`,
      'comexHoldingMargin', 'comex_holding_margin', 'comexHoldingExposure', 'commodityHoldingMargin'
    );

    // Also check section configs
    let segConfig = cfg[`${lowType}Config`] || cfg[`${lowType}_config`] || cfg[lowType] || {};
    if (mType === 'CRYPTO') {
      segConfig = cfg.cryptoConfig || cfg.crypto || cfg.crypto_config || cfg.comex_crypto_future || {};
    } else if (mType === 'FOREX') {
      segConfig = cfg.forexConfig || cfg.forex || cfg.forex_config || cfg.comex_currency_future || {};
    } else if (mType === 'COMEX' || mType === 'COMMODITY') {
      segConfig = cfg.comexConfig || cfg.comex || cfg.comex_config || cfg.commodityConfig || cfg.commodity || cfg.commodity_config || cfg.comex_commodity_future || {};
    }

    const secIntraday = parseFloat(segConfig.intradayMargin || segConfig.intraday_margin || segConfig.intradayExposure || segConfig.intraday_exposure || segConfig.intraday || 0) || null;
    const secHolding = parseFloat(segConfig.holdingMargin || segConfig.holding_margin || segConfig.holdingExposure || segConfig.holding_exposure || segConfig.holding || 0) || null;

    intradayExp = rootIntraday || secIntraday || 500;
    holdingExp = rootHolding || secHolding || 100;
    exposureType = segConfig.exposureType || segConfig.exposure_type || 'PER_TURNOVER_BASIS';
    lotMargins = segConfig.lotMargins || segConfig.lot_margins || {};
  }

  // Normalize exposureType terminology
  if (exposureType === 'per_lot' || exposureType === 'Per Lot Basis') {
    exposureType = 'PER_LOT_BASIS';
  } else if (exposureType === 'per_crore' || exposureType === 'per_turnover' || exposureType === 'Per Turnover Basis' || exposureType === 'Per Crore Basis') {
    exposureType = 'PER_TURNOVER_BASIS';
  }

  // Calculate actual quantity correctly without double-multiplying when qty is already total quantity
  let actualQty = qtyNum;
  if (mType === 'MCX') {
    actualQty = isUnitMode ? qtyNum : (qtyNum * lotVal);
  } else if (['EQUITY', 'NSE', 'NFO', 'OPTIONS'].includes(mType)) {
    if (!isUnitMode && qtyNum < lotVal && lotVal > 1) {
      actualQty = qtyNum * lotVal;
    } else {
      actualQty = qtyNum;
    }
  } else {
    // FOREX, COMEX, CRYPTO, COMMODITY
    let effLotSize = lotVal;
    if (effLotSize <= 1) {
      const cleanUpper = upperSym.split(':').pop().replace(/[\s\/\_\-]+/g, '');
      if (['EURUSD', 'GBPUSD', 'USDCHF', 'USDJPY', 'AUDCAD'].some(k => cleanUpper.includes(k))) {
        effLotSize = 100000;
      } else if (['USDINR'].some(k => cleanUpper.includes(k))) {
        effLotSize = 1000;
      } else if (['USOIL', 'UKOIL'].some(k => cleanUpper.includes(k))) {
        effLotSize = 1000;
      } else if (['NGAS'].some(k => cleanUpper.includes(k))) {
        effLotSize = 10000;
      } else if (['XAUUSD'].some(k => cleanUpper.includes(k))) {
        effLotSize = 100;
      } else if (['XAGUSD'].some(k => cleanUpper.includes(k))) {
        effLotSize = 5000;
      } else if (['COPPER'].some(k => cleanUpper.includes(k))) {
        effLotSize = 2500;
      }
    }
    actualQty = isUnitMode ? qtyNum : (qtyNum * effLotSize);
  }

  if (exposureType === 'PER_LOT_BASIS') {
    const baseSym = getMcxBaseScrip(symbol);
    const noSlash = (symbol || '').replace('/', '');
    const symbolConfig = lotMargins[symbol] || lotMargins[baseSym] || lotMargins[noSlash] || {};
    const marginPerLot = parseFloat(
      symbolConfig[tradeType] !== undefined ? symbolConfig[tradeType] : (symbolConfig.intraday_margin || 0)
    );

    if (marginPerLot > 0) {
      const lotCount = (qtyNum >= lotVal && lotVal > 1) ? (qtyNum / lotVal) : qtyNum;
      return lotCount * marginPerLot;
    }
    // Fallback if no specific lot margin defined
    const activeDiv = isHolding ? holdingExp : intradayExp;
    return (priceNum * actualQty) / (parseFloat(activeDiv) || (isHolding ? 100 : 500));
  }

  // PER_TURNOVER_BASIS
  const exposureDivisor = isHolding ? holdingExp : intradayExp;
  const activeDivisor = parseFloat(exposureDivisor) > 0 ? parseFloat(exposureDivisor) : (isHolding ? 100 : 500);

  let turnover = priceNum * actualQty;

  // Currency conversion for international pairs if needed
  if (['FOREX', 'CRYPTO', 'COMEX', 'COMMODITY'].includes(mType)) {
    const cleanSym = (symbol || '').toUpperCase().replace('/', '');
    const isDirectInrPair = cleanSym.endsWith('INR') || cleanSym.endsWith('USDINR');
    if (!isDirectInrPair) {
      turnover = turnover * (parseFloat(fallbackUsdInr) || 86.68);
    }
  }

  return turnover / activeDivisor;
};

module.exports = {
  getMcxBaseScrip,
  isMcxSymbol,
  isOptionsSymbol,
  calculateSegmentMargin
};
