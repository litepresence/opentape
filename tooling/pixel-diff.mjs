// tooling/pixel-diff.mjs — measurement-only pixel diff vs reference PNG.
// Method: render both at native size, center-crop to common size, report
// mean absolute per-channel difference (0-255) + % pixels with Δ>25.
// No parity chase: number is reported honestly for the fix report.
import { execFileSync } from 'node:child_process';

const ref = process.argv[2] || 'Screenshot from 2026-10-12 18-38-59.png';
const shot = process.argv[3] || 'tooling/shots/final-1920.png';
const out = execFileSync('python3', ['tooling/pixel_diff.py', ref, shot], { encoding: 'utf8' });
console.log(out);
