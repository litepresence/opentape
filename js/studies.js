// js/studies.js — registry of all 85 vendored studies + compute helper.
// The vendor fns in indicators/*.js do NOT share one calling convention:
// most take a trailing opts object, but many take a positional period (or
// deviation) number, and several take no trailing param at all. Array inputs
// vary too (close-only, hl, hlc, hlcv, ohlc, open+close, closes+volume …).
// Each entry therefore declares `inputs` (which row arrays to pass) and `arg`
// (how to pass the trailing param: 'opts' | 'period' | 'deviation' | 'none').
// `opts` holds the vendor defaults (read from each fn's _per calls + doc
// comments); callers may override any key via computeStudy(id, rows, opts).
import { getLib } from './lib.js';

// Kinds: overlay = price-pane line(s); bands = {upper,lower[,middle]} + fill;
// multiline = N price-pane lines; pane = shared oscillator pane (union scale);
// transform = replaces the candle source, radio behavior (exactly one active).
export const STUDIES = [
  // base — indicators/indicators.js (14), group Trend
  { id: 'sma', label: 'SMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'period' },
  { id: 'ema', label: 'EMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'period' },
  { id: 'macd', label: 'MACD', group: 'Trend', inputs: 'close', kind: 'pane', lines: ['macd', 'signal', 'hist'], opts: { short: 12, long: 26, signal: 9 }, arg: 'opts' },
  { id: 'bbands', label: 'Bollinger Bands', group: 'Trend', inputs: 'close', kind: 'bands', lines: ['upper', 'middle', 'lower'], fill: ['upper', 'lower'], opts: { period: 20, stddev: 2 }, arg: 'opts' },
  { id: 'stddev', label: 'StdDev', group: 'Trend', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 5 }, arg: 'opts' },
  { id: 'psar', label: 'Parabolic SAR', group: 'Trend', inputs: 'hl', kind: 'overlay', lines: ['line'], opts: { step: 0.02, max: 0.2 }, arg: 'opts' },
  { id: 'vwap', label: 'VWAP', group: 'Trend', inputs: 'hlcv', kind: 'overlay', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'zlema', label: 'ZLEMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'opts' },
  { id: 'trima', label: 'TRIMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 30 }, arg: 'opts' },
  { id: 'hma', label: 'HMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 9 }, arg: 'opts' },
  { id: 'renko', label: 'Renko', group: 'Trend', inputs: 'close', kind: 'transform', lines: ['line'], opts: { brickPercent: 1 }, arg: 'opts' },
  { id: 'heikinashi', label: 'Heikin Ashi', group: 'Trend', inputs: 'ohlc', kind: 'transform', lines: ['open', 'high', 'low', 'close'], opts: {}, arg: 'none' },
  { id: 'ichimoku', label: 'Ichimoku', group: 'Trend', inputs: 'hlc', kind: 'multiline', lines: ['tenkan', 'kijun', 'senkouA', 'senkouB', 'chikou'], opts: { tenkan: 9, kijun: 26, senkouB: 52, displacement: 26 }, arg: 'opts' },
  { id: 'frama', label: 'FRAMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14, fractalPeriod: 2 }, arg: 'opts' },
  // osc — indicators/indicators-osc.js (11), group Oscillators
  { id: 'rsi', label: 'RSI', group: 'Oscillators', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts' },
  { id: 'stoch', label: 'Stochastic', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['k', 'd'], opts: { kPeriod: 5, kSlowing: 3, dPeriod: 3 }, arg: 'opts' },
  { id: 'aroonosc', label: 'Aroon Oscillator', group: 'Oscillators', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 25 }, arg: 'opts' },
  { id: 'adx', label: 'ADX', group: 'Oscillators', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts' },
  { id: 'atr', label: 'ATR', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts' },
  { id: 'fisher', label: 'Fisher Transform', group: 'Oscillators', inputs: 'hl', kind: 'pane', lines: ['fisher', 'signal'], opts: { period: 9 }, arg: 'opts' },
  { id: 'mfi', label: 'MFI', group: 'Oscillators', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts' },
  { id: 'uo', label: 'Ultimate Oscillator', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { short: 7, medium: 14, long: 28 }, arg: 'opts' },
  { id: 'fosc', label: 'Forecast Oscillator', group: 'Oscillators', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 5 }, arg: 'opts' },
  { id: 'dmi', label: 'DMI', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['plusDI', 'minusDI'], opts: { period: 14 }, arg: 'opts' },
  { id: 'msw', label: 'Mesa Sine Wave', group: 'Oscillators', inputs: 'close', kind: 'pane', lines: ['sine', 'lead'], opts: { period: 20 }, arg: 'opts' },
  // tulip — indicators/indicators-tulip.js (11), group Averages
  { id: 'dema', label: 'DEMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 21 }, arg: 'period' },
  { id: 'tema', label: 'TEMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 21 }, arg: 'period' },
  { id: 'wma', label: 'WMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 9 }, arg: 'period' },
  { id: 'wilders', label: 'Wilders', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'vidya', label: 'VIDYA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { short: 9, long: 12 }, arg: 'opts' },
  { id: 'vwma', label: 'VWMA', group: 'Averages', inputs: 'closevol', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'period' },
  { id: 'linreg', label: 'Linear Regression', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'tsf', label: 'Time Series Forecast', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'linregslope', label: 'LinReg Slope', group: 'Averages', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'kama', label: 'KAMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 10 }, arg: 'period' },
  { id: 'md', label: 'Mean Deviation', group: 'Averages', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  // tmom — indicators/indicators-tmom.js (17), group Momentum
  { id: 'stochrsi', label: 'Stoch RSI', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'adxr', label: 'ADXR', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'aroon', label: 'Aroon', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['up', 'down'], opts: { period: 25 }, arg: 'period' },
  { id: 'cci', label: 'CCI', group: 'Momentum', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 20 }, arg: 'period' },
  { id: 'cmo', label: 'CMO', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'dx', label: 'DX', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'di', label: 'DI', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['plus', 'minus'], opts: { period: 14 }, arg: 'period' },
  { id: 'mom', label: 'Momentum', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 12 }, arg: 'period' },
  { id: 'roc', label: 'ROC', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 12 }, arg: 'period' },
  { id: 'rocr', label: 'ROCR', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 12 }, arg: 'period' },
  { id: 'trix', label: 'TRIX', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 15 }, arg: 'period' },
  { id: 'ultosc', label: 'Ultimate (Tulip)', group: 'Momentum', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { short: 7, middle: 14, long: 28 }, arg: 'opts' },
  { id: 'willr', label: 'Williams %R', group: 'Momentum', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'apo', label: 'APO', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { short: 12, long: 26 }, arg: 'opts' },
  { id: 'ppo', label: 'PPO', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { short: 12, long: 26 }, arg: 'opts' },
  { id: 'bop', label: 'Balance of Power', group: 'Momentum', inputs: 'ohlc', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'qstick', label: 'Qstick', group: 'Momentum', inputs: 'oc', kind: 'pane', lines: ['line'], opts: { period: 8 }, arg: 'period' },
  // tvol — indicators/indicators-tvol.js (15), group Volume
  { id: 'obv', label: 'OBV', group: 'Volume', inputs: 'closevol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'emv', label: 'Ease of Movement', group: 'Volume', inputs: 'hlvol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'vosc', label: 'Volume Oscillator', group: 'Volume', inputs: 'vol', kind: 'pane', lines: ['line'], opts: { short: 5, long: 10 }, arg: 'opts' },
  { id: 'nvi', label: 'NVI', group: 'Volume', inputs: 'closevol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'pvi', label: 'PVI', group: 'Volume', inputs: 'closevol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'wad', label: 'WAD', group: 'Volume', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'ad', label: 'A/D Line', group: 'Volume', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'cvi', label: 'Chaikin Volatility', group: 'Volume', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 10 }, arg: 'period' },
  { id: 'natr', label: 'NATR', group: 'Volume', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'mass', label: 'Mass Index', group: 'Volume', inputs: 'hl', kind: 'pane', lines: ['line'], opts: {}, arg: 'none' },
  { id: 'kvo', label: 'Klinger Oscillator', group: 'Volume', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: { fast: 34, slow: 55 }, arg: 'opts' },
  { id: 'adosc', label: 'Chaikin Oscillator', group: 'Volume', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: { fast: 3, slow: 10 }, arg: 'opts' },
  { id: 'dpo', label: 'DPO', group: 'Volume', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 21 }, arg: 'period' },
  { id: 'vhf', label: 'VHF', group: 'Volume', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 28 }, arg: 'period' },
  { id: 'volatility', label: 'Volatility', group: 'Volume', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  // qx — indicators/indicators-qx.js (17), group Custom
  { id: 'vortex', label: 'Vortex', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['plus', 'minus'], opts: { period: 14 }, arg: 'period' },
  { id: 'kst', label: 'KST', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['kst', 'signal'], opts: { r1: 10, r2: 15, r3: 20, r4: 30, sig: 9 }, arg: 'opts' },
  { id: 'zigzag', label: 'ZigZag', group: 'Custom', inputs: 'close', kind: 'overlay', lines: ['line', 'steps'], opts: { deviation: 5 }, arg: 'deviation' },
  { id: 'ravi', label: 'RAVI', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { short: 14, long: 30 }, arg: 'opts' },
  { id: 'aema', label: 'AEMA', group: 'Custom', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14, alpha: 0.1 }, arg: 'opts' },
  { id: 'tsi', label: 'TSI', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { long: 25, short: 13 }, arg: 'opts' },
  { id: 'smi', label: 'SMI', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['smi', 'signal'], opts: { k: 14, d: 3 }, arg: 'opts' },
  { id: 'eri', label: 'Elder Ray', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['bull', 'bear'], opts: { period: 13 }, arg: 'period' },
  { id: 'awesome', label: 'Awesome Oscillator', group: 'Custom', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { short: 5, long: 34 }, arg: 'opts' },
  { id: 'supertrend', label: 'Supertrend', group: 'Custom', inputs: 'hlc', kind: 'overlay', lines: ['trend', 'upper', 'lower'], opts: { period: 14, top: 3, bottom: 3 }, arg: 'opts' },
  { id: 'arsi', label: 'ARSI', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'keltner', label: 'Keltner Channels', group: 'Custom', inputs: 'hlc', kind: 'bands', lines: ['upper', 'middle', 'lower'], fill: ['upper', 'lower'], opts: { atr: 20, ema: 20, mult: 1.5 }, arg: 'opts' },
  { id: 'donchian', label: 'Donchian Channels', group: 'Custom', inputs: 'hl', kind: 'bands', lines: ['upper', 'middle', 'lower'], fill: ['upper', 'lower'], opts: { period: 20 }, arg: 'period' },
  { id: 'ulcer', label: 'Ulcer Index', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period' },
  { id: 'earsi', label: 'Ehlers RSI', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { min: 10, max: 48, avg: 3 }, arg: 'opts' },
  { id: 'holtwinters', label: 'Holt-Winters', group: 'Custom', inputs: 'close', kind: 'overlay', lines: ['smooth', 'trend'], opts: { span: 10, beta: 0.3 }, arg: 'opts' },
  { id: 'kagi', label: 'Kagi', group: 'Custom', inputs: 'close', kind: 'transform', lines: ['line'], opts: { deviation: 2 }, arg: 'deviation' },
];

export function computeStudy(id, rows, opts = {}) {
  const Lib = getLib();
  const meta = STUDIES.find(s => s.id === id);
  if (!meta || typeof Lib[id] !== 'function') throw new Error('unknown study ' + id);
  const open = rows.map(r => r.o), closes = rows.map(r => r.c);
  const high = rows.map(r => r.h), low = rows.map(r => r.l), vol = rows.map(r => r.v);
  const byInputs = {
    close: [closes],
    vol: [vol],
    hl: [high, low],
    hlc: [high, low, closes],
    hlcv: [high, low, closes, vol],
    ohlc: [open, high, low, closes],
    oc: [open, closes],
    closevol: [closes, vol],
    hlvol: [high, low, vol],
  };
  const args = [...(byInputs[meta.inputs] || [closes])];
  const merged = { ...(meta.opts || {}), ...opts };
  if (meta.arg === 'opts') args.push(merged);
  else if (meta.arg === 'period') args.push(merged.period);
  else if (meta.arg === 'deviation') args.push(merged.deviation);
  const out = Lib[id](...args);
  return { id, series: Array.isArray(out) ? { line: out } : out };
}
