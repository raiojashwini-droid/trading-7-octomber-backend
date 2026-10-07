const { isMcxSymbol, calculateSegmentMargin, isOptionsSymbol } = require('./segmentMargin');

const testConfig = {
  mcxIntradayMargin: '400',
  mcxHoldingMargin: '80',
  mcxExposureType: 'per_turnover',
  equityIntradayMargin: '400',
  equityHoldingMargin: '80',
  optionsEquityIntraday: '350',
  optionsEquityHolding: '65',
  optionsIndexIntraday: '300',
  optionsIndexHolding: '75',
};

// 1. GLENMARK 26SEP FUT (qty: 375, price: 2410, marketType: 'NFO')
const glenmark = calculateSegmentMargin({
  marketType: 'NFO',
  symbol: 'NFO:GLENMARK26SEPFUT',
  price: 2410,
  qty: 375,
  lotSize: 375,
  isHolding: false,
  clientConfig: testConfig
});
console.log('GLENMARK Intraday Margin (Expected 2259.38):', glenmark);

// 2. CIPLA 26SEP FUT (qty: 425, price: 1358.80, marketType: 'NFO')
const cipla = calculateSegmentMargin({
  marketType: 'NFO',
  symbol: 'NFO:CIPLA26SEPFUT',
  price: 1358.80,
  qty: 425,
  lotSize: 425,
  isHolding: false,
  clientConfig: testConfig
});
console.log('CIPLA Intraday Margin (Expected 1443.72):', cipla);

// 3. GOLD 26OCT FUT (qty: 1, price: 152327, lotSize: 100, marketType: 'MCX')
const gold = calculateSegmentMargin({
  marketType: 'MCX',
  symbol: 'MCX:GOLD26OCTFUT',
  price: 152327,
  qty: 1,
  lotSize: 100,
  isHolding: false,
  clientConfig: testConfig
});
console.log('GOLD Intraday Margin (Expected 38081.75):', gold);

// 4. SILVER 26DEC FUT (qty: 1, price: 235051, lotSize: 30, marketType: 'MCX')
const silver = calculateSegmentMargin({
  marketType: 'MCX',
  symbol: 'MCX:SILVER26DECFUT',
  price: 235051,
  qty: 1,
  lotSize: 30,
  isHolding: false,
  clientConfig: testConfig
});
console.log('SILVER Intraday Margin (Expected 17628.83):', silver);
