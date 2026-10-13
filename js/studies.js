// js/studies.js — registry of all 85 vendored studies + compute helper.
// The vendor fns in indicators/*.js do NOT share one calling convention:
// most take a trailing opts object, but many take a positional period (or
// deviation) number, and several take no trailing param at all. Array inputs
// vary too (close-only, hl, hlc, hlcv, ohlc, open+close, closes+volume …).
// Each entry therefore declares `inputs` (which row arrays to pass) and `arg`
// (how to pass the trailing param: 'opts' | 'period' | 'deviation' | 'none').
// `opts` holds the vendor defaults (read from each fn's _per calls + doc
// comments); callers may override any key via computeStudy(id, rows, opts).
// `params` holds one editor def per opts key ({key,type,min,max,step}) so the
// modal can build per-instance controls; studies with no opts get params:[].
// Instances are {uid, id, params, color, visible}; color:null means the chart
// falls back to the palette-by-registry-index (stuColor).
import { getLib } from './lib.js';

// Kinds: overlay = price-pane line(s); bands = {upper,lower[,middle]} + fill;
// multiline = N price-pane lines; pane = shared oscillator pane (union scale);
// transform = replaces the candle source, radio behavior (exactly one active).
const INT = (key) => ({ key, type: 'int', min: 1, max: 500, step: 1 });
export const STUDIES = [
  // base — indicators/indicators.js (14), group Trend
  { id: 'sma', label: 'SMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'period', params: [INT('period')] },
  { id: 'ema', label: 'EMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'period', params: [INT('period')] },
  { id: 'macd', label: 'MACD', group: 'Trend', inputs: 'close', kind: 'pane', lines: ['macd', 'signal', 'hist'], opts: { short: 12, long: 26, signal: 9 }, arg: 'opts', params: [INT('short'), INT('long'), { key: 'signal', type: 'int', min: 1, max: 500, step: 1 }] },
  { id: 'bbands', label: 'Bollinger Bands', group: 'Trend', inputs: 'close', kind: 'bands', lines: ['upper', 'middle', 'lower'], fill: ['upper', 'lower'], opts: { period: 20, stddev: 2 }, arg: 'opts', params: [INT('period'), { key: 'stddev', type: 'float', min: 0.1, max: 5, step: 0.1 }] },
  { id: 'stddev', label: 'StdDev', group: 'Trend', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 5 }, arg: 'opts', params: [INT('period')] },
  { id: 'psar', label: 'Parabolic SAR', group: 'Trend', inputs: 'hl', kind: 'overlay', lines: ['line'], opts: { step: 0.02, max: 0.2 }, arg: 'opts', params: [{ key: 'step', type: 'float', min: 0.001, max: 0.2, step: 0.001 }, { key: 'max', type: 'float', min: 0.01, max: 1, step: 0.01 }] },
  { id: 'vwap', label: 'VWAP', group: 'Trend', inputs: 'hlcv', kind: 'overlay', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'zlema', label: 'ZLEMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'opts', params: [INT('period')] },
  { id: 'trima', label: 'TRIMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 30 }, arg: 'opts', params: [INT('period')] },
  { id: 'hma', label: 'HMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 9 }, arg: 'opts', params: [INT('period')] },
  { id: 'renko', label: 'Renko', group: 'Trend', inputs: 'close', kind: 'transform', lines: ['line'], opts: { brickPercent: 1 }, arg: 'opts', params: [{ key: 'brickPercent', type: 'float', min: 0.1, max: 10, step: 0.1 }] },
  { id: 'heikinashi', label: 'Heikin Ashi', group: 'Trend', inputs: 'ohlc', kind: 'transform', lines: ['open', 'high', 'low', 'close'], opts: {}, arg: 'none', params: [] },
  { id: 'ichimoku', label: 'Ichimoku', group: 'Trend', inputs: 'hlc', kind: 'multiline', lines: ['tenkan', 'kijun', 'senkouA', 'senkouB', 'chikou'], opts: { tenkan: 9, kijun: 26, senkouB: 52, displacement: 26 }, arg: 'opts', params: [INT('tenkan'), INT('kijun'), INT('senkouB'), { key: 'displacement', type: 'int', min: -100, max: 100, step: 1 }] },
  { id: 'frama', label: 'FRAMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14, fractalPeriod: 2 }, arg: 'opts', params: [INT('period'), { key: 'fractalPeriod', type: 'int', min: 1, max: 10, step: 1 }] },
  // osc — indicators/indicators-osc.js (11), group Oscillators
  { id: 'rsi', label: 'RSI', group: 'Oscillators', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts', params: [INT('period')] },
  { id: 'stoch', label: 'Stochastic', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['k', 'd'], opts: { kPeriod: 5, kSlowing: 3, dPeriod: 3 }, arg: 'opts', params: [INT('kPeriod'), INT('kSlowing'), INT('dPeriod')] },
  { id: 'aroonosc', label: 'Aroon Oscillator', group: 'Oscillators', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 25 }, arg: 'opts', params: [INT('period')] },
  { id: 'adx', label: 'ADX', group: 'Oscillators', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts', params: [INT('period')] },
  { id: 'atr', label: 'ATR', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts', params: [INT('period')] },
  { id: 'fisher', label: 'Fisher Transform', group: 'Oscillators', inputs: 'hl', kind: 'pane', lines: ['fisher', 'signal'], opts: { period: 9 }, arg: 'opts', params: [INT('period')] },
  { id: 'mfi', label: 'MFI', group: 'Oscillators', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'opts', params: [INT('period')] },
  { id: 'uo', label: 'Ultimate Oscillator', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { short: 7, medium: 14, long: 28 }, arg: 'opts', params: [INT('short'), INT('medium'), INT('long')] },
  { id: 'fosc', label: 'Forecast Oscillator', group: 'Oscillators', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 5 }, arg: 'opts', params: [INT('period')] },
  { id: 'dmi', label: 'DMI', group: 'Oscillators', inputs: 'hlc', kind: 'pane', lines: ['plusDI', 'minusDI'], opts: { period: 14 }, arg: 'opts', params: [INT('period')] },
  { id: 'msw', label: 'Mesa Sine Wave', group: 'Oscillators', inputs: 'close', kind: 'pane', lines: ['sine', 'lead'], opts: { period: 20 }, arg: 'opts', params: [INT('period')] },
  // tulip — indicators/indicators-tulip.js (11), group Averages
  { id: 'dema', label: 'DEMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 21 }, arg: 'period', params: [INT('period')] },
  { id: 'tema', label: 'TEMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 21 }, arg: 'period', params: [INT('period')] },
  { id: 'wma', label: 'WMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 9 }, arg: 'period', params: [INT('period')] },
  { id: 'wilders', label: 'Wilders', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'vidya', label: 'VIDYA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { short: 9, long: 12 }, arg: 'opts', params: [INT('short'), INT('long')] },
  { id: 'vwma', label: 'VWMA', group: 'Averages', inputs: 'closevol', kind: 'overlay', lines: ['line'], opts: { period: 20 }, arg: 'period', params: [INT('period')] },
  { id: 'linreg', label: 'Linear Regression', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'tsf', label: 'Time Series Forecast', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'linregslope', label: 'LinReg Slope', group: 'Averages', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'kama', label: 'KAMA', group: 'Averages', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 10 }, arg: 'period', params: [INT('period')] },
  { id: 'md', label: 'Mean Deviation', group: 'Averages', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  // tmom — indicators/indicators-tmom.js (17), group Momentum
  { id: 'stochrsi', label: 'Stoch RSI', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'adxr', label: 'ADXR', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'aroon', label: 'Aroon', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['up', 'down'], opts: { period: 25 }, arg: 'period', params: [INT('period')] },
  { id: 'cci', label: 'CCI', group: 'Momentum', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 20 }, arg: 'period', params: [INT('period')] },
  { id: 'cmo', label: 'CMO', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'dx', label: 'DX', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'di', label: 'DI', group: 'Momentum', inputs: 'hl', kind: 'pane', lines: ['plus', 'minus'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'mom', label: 'Momentum', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 12 }, arg: 'period', params: [INT('period')] },
  { id: 'roc', label: 'ROC', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 12 }, arg: 'period', params: [INT('period')] },
  { id: 'rocr', label: 'ROCR', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 12 }, arg: 'period', params: [INT('period')] },
  { id: 'trix', label: 'TRIX', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 15 }, arg: 'period', params: [INT('period')] },
  { id: 'ultosc', label: 'Ultimate (Tulip)', group: 'Momentum', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { short: 7, middle: 14, long: 28 }, arg: 'opts', params: [INT('short'), INT('middle'), INT('long')] },
  { id: 'willr', label: 'Williams %R', group: 'Momentum', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'apo', label: 'APO', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { short: 12, long: 26 }, arg: 'opts', params: [INT('short'), INT('long')] },
  { id: 'ppo', label: 'PPO', group: 'Momentum', inputs: 'close', kind: 'pane', lines: ['line'], opts: { short: 12, long: 26 }, arg: 'opts', params: [INT('short'), INT('long')] },
  { id: 'bop', label: 'Balance of Power', group: 'Momentum', inputs: 'ohlc', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'qstick', label: 'Qstick', group: 'Momentum', inputs: 'oc', kind: 'pane', lines: ['line'], opts: { period: 8 }, arg: 'period', params: [INT('period')] },
  // tvol — indicators/indicators-tvol.js (15), group Volume
  { id: 'obv', label: 'OBV', group: 'Volume', inputs: 'closevol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'emv', label: 'Ease of Movement', group: 'Volume', inputs: 'hlvol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'vosc', label: 'Volume Oscillator', group: 'Volume', inputs: 'vol', kind: 'pane', lines: ['line'], opts: { short: 5, long: 10 }, arg: 'opts', params: [INT('short'), INT('long')] },
  { id: 'nvi', label: 'NVI', group: 'Volume', inputs: 'closevol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'pvi', label: 'PVI', group: 'Volume', inputs: 'closevol', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'wad', label: 'WAD', group: 'Volume', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'ad', label: 'A/D Line', group: 'Volume', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'cvi', label: 'Chaikin Volatility', group: 'Volume', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { period: 10 }, arg: 'period', params: [INT('period')] },
  { id: 'natr', label: 'NATR', group: 'Volume', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'mass', label: 'Mass Index', group: 'Volume', inputs: 'hl', kind: 'pane', lines: ['line'], opts: {}, arg: 'none', params: [] },
  { id: 'kvo', label: 'Klinger Oscillator', group: 'Volume', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: { fast: 34, slow: 55 }, arg: 'opts', params: [INT('fast'), INT('slow')] },
  { id: 'adosc', label: 'Chaikin Oscillator', group: 'Volume', inputs: 'hlcv', kind: 'pane', lines: ['line'], opts: { fast: 3, slow: 10 }, arg: 'opts', params: [INT('fast'), INT('slow')] },
  { id: 'dpo', label: 'DPO', group: 'Volume', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 21 }, arg: 'period', params: [INT('period')] },
  { id: 'vhf', label: 'VHF', group: 'Volume', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 28 }, arg: 'period', params: [INT('period')] },
  { id: 'volatility', label: 'Volatility', group: 'Volume', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  // qx — indicators/indicators-qx.js (17), group Custom
  { id: 'vortex', label: 'Vortex', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['plus', 'minus'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'kst', label: 'KST', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['kst', 'signal'], opts: { r1: 10, r2: 15, r3: 20, r4: 30, sig: 9 }, arg: 'opts', params: [INT('r1'), INT('r2'), INT('r3'), INT('r4'), INT('sig')] },
  { id: 'zigzag', label: 'ZigZag', group: 'Custom', inputs: 'close', kind: 'overlay', lines: ['line', 'steps'], opts: { deviation: 5 }, arg: 'deviation', params: [{ key: 'deviation', type: 'float', min: 0.1, max: 20, step: 0.1 }] },
  { id: 'ravi', label: 'RAVI', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['line'], opts: { short: 14, long: 30 }, arg: 'opts', params: [INT('short'), INT('long')] },
  { id: 'aema', label: 'AEMA', group: 'Custom', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 14, alpha: 0.1 }, arg: 'opts', params: [INT('period'), { key: 'alpha', type: 'float', min: 0.01, max: 1, step: 0.01 }] },
  { id: 'tsi', label: 'TSI', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { long: 25, short: 13 }, arg: 'opts', params: [INT('long'), INT('short')] },
  { id: 'smi', label: 'SMI', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['smi', 'signal'], opts: { k: 14, d: 3 }, arg: 'opts', params: [INT('k'), INT('d')] },
  { id: 'eri', label: 'Elder Ray', group: 'Custom', inputs: 'hlc', kind: 'pane', lines: ['bull', 'bear'], opts: { period: 13 }, arg: 'period', params: [INT('period')] },
  { id: 'awesome', label: 'Awesome Oscillator', group: 'Custom', inputs: 'hl', kind: 'pane', lines: ['line'], opts: { short: 5, long: 34 }, arg: 'opts', params: [INT('short'), INT('long')] },
  { id: 'supertrend', label: 'Supertrend', group: 'Custom', inputs: 'hlc', kind: 'overlay', lines: ['trend', 'upper', 'lower'], opts: { period: 14, top: 3, bottom: 3 }, arg: 'opts', params: [INT('period'), { key: 'top', type: 'float', min: 0.5, max: 10, step: 0.5 }, { key: 'bottom', type: 'float', min: 0.5, max: 10, step: 0.5 }] },
  { id: 'arsi', label: 'ARSI', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'keltner', label: 'Keltner Channels', group: 'Custom', inputs: 'hlc', kind: 'bands', lines: ['upper', 'middle', 'lower'], fill: ['upper', 'lower'], opts: { atr: 20, ema: 20, mult: 1.5 }, arg: 'opts', params: [INT('atr'), INT('ema'), { key: 'mult', type: 'float', min: 0.1, max: 5, step: 0.1 }] },
  { id: 'donchian', label: 'Donchian Channels', group: 'Custom', inputs: 'hl', kind: 'bands', lines: ['upper', 'middle', 'lower'], fill: ['upper', 'lower'], opts: { period: 20 }, arg: 'period', params: [INT('period')] },
  { id: 'ulcer', label: 'Ulcer Index', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { period: 14 }, arg: 'period', params: [INT('period')] },
  { id: 'earsi', label: 'Ehlers RSI', group: 'Custom', inputs: 'close', kind: 'pane', lines: ['line'], opts: { min: 10, max: 48, avg: 3 }, arg: 'opts', params: [INT('min'), INT('max'), INT('avg')] },
  { id: 'holtwinters', label: 'Holt-Winters', group: 'Custom', inputs: 'close', kind: 'overlay', lines: ['smooth', 'trend'], opts: { span: 10, beta: 0.3 }, arg: 'opts', params: [INT('span'), { key: 'beta', type: 'float', min: 0, max: 1, step: 0.01 }] },
  { id: 'kagi', label: 'Kagi', group: 'Custom', inputs: 'close', kind: 'transform', lines: ['line'], opts: { deviation: 2 }, arg: 'deviation', params: [{ key: 'deviation', type: 'float', min: 0.1, max: 20, step: 0.1 }] },
];

let uidSeq = 0;
function newUid() {
  uidSeq += 1;
  return 'stu' + Date.now().toString(36) + '_' + uidSeq.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// makeInstance(id, overrides) -> {uid, id, params, color, visible}.
// overrides may carry {uid, params, color, visible} and/or flat param keys
// (e.g. {period:50}) for convenience; registry defaults fill the rest.
export function makeInstance(id, overrides = {}) {
  const meta = STUDIES.find(s => s.id === id);
  if (!meta) throw new Error('unknown study ' + id);
  const { uid, params, color, visible, ...flat } = overrides || {};
  const optKeys = new Set(Object.keys(meta.opts || {}));
  const flatParams = {};
  for (const [k, v] of Object.entries(flat)) {
    if (optKeys.has(k)) flatParams[k] = v;
  }
  return {
    uid: uid || newUid(),
    id,
    params: { ...(meta.opts || {}), ...flatParams, ...(params || {}) },
    color: color !== undefined ? color : null,
    visible: visible !== undefined ? visible : true,
  };
}

function migrateFlags(flags) {
  const out = [];
  if (!flags || typeof flags !== 'object') return out;
  if (flags.sma20) out.push(makeInstance('sma', { params: { period: 20 } }));
  if (flags.sma50) out.push(makeInstance('sma', { params: { period: 50 } }));
  if (flags.ema20) out.push(makeInstance('ema', { params: { period: 20 } }));
  if (flags.rsi) out.push(makeInstance('rsi'));
  return out;
}

// migrateStudies(raw) -> instance array.
// Accepts: string[] (legacy ids), instance[] (normalized), {indicators:{...}}
// (Task-7 flags), {studies, indicators} (combined layout form), null -> [].
// Unknown ids are skipped; nothing throws on legacy input.
export function migrateStudies(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) && typeof raw === 'object') {
    if ('studies' in raw || 'indicators' in raw) {
      return [...migrateStudies(raw.studies || []), ...migrateFlags(raw.indicators || {})];
    }
    return migrateFlags(raw.indicators || raw);
  }
  if (Array.isArray(raw)) {
    const out = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        try { out.push(makeInstance(item)); } catch { /* unknown id — skip */ }
      } else if (item && typeof item === 'object' && typeof item.id === 'string') {
        const meta = STUDIES.find(s => s.id === item.id);
        if (!meta) continue;
        out.push({
          uid: item.uid || newUid(),
          id: item.id,
          params: { ...(meta.opts || {}), ...(item.params || {}) },
          color: 'color' in item ? item.color : null,
          visible: item.visible !== undefined ? item.visible : true,
        });
      }
    }
    return out;
  }
  return [];
}

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
