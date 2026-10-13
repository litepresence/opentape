// js/lib.js — ESM bridge to the classic-script global. index.html loads
// indicators/*.js before any module, so globalThis.Indicators must exist.
export function getLib() {
  const Lib = globalThis.Indicators;
  if (!Lib) throw new Error('indicators library not loaded — check <script> order in index.html');
  return Lib;
}
