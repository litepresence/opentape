# Overlay kinds — fidelity baseline (RED)

Verdicts: `stub` (wrong shape / placeholder), `partial` (right idea, missing
labels/prices/edges/variants), `ok` (faithful). Every `stub`/`partial` is a
failing fidelity test; dispatched agents turn each to `ok`. No stubs survive.

## Lines (`lines()`, js/geometry.js)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| segment | trend, prediction | ok (T1) | stats panel + prediction tail + extension modes |
| ray | ray | ok (T1) | edge-clipped ray-cast, single prim |
| infoline | info | ok (T1) | stats box (abs, %, bars, angle) |
| extended | extended | ok (T1) | slope-projected both-edges line; vertical fallback |
| angle | angle | ok (T1) | fixed wedge + acute label + slope readout |
| hline | horizontal | ok (T1) | price-axis pill + caption, arrows removed |
| hray | hray | ok (T1) | plain ray + price tag, arrows removed |
| vline | vertical | ok (T1) | date pill + caption, arrows removed |
| crossline | crossline | ok (T1) | ring + both axis pills |
| arrow | arrow, arrowmarker, arrmarkup/down | ok (T1) | explicit filled heads per variant |

## Channels / forks (`channels()`)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| channel | parallel | ok (T1) | right-extended outers + dashed median + 0.1 fill |
| disjoint | disjoint | ok (T1) | right-extended rails + fill, time-disjoint kept |
| flattop | flattop | ok (T1) | flat + slope-projected angled side to edge + price labels |
| regression | regression | ok (T1) | ±2σ extended bands + fills + σ/R tags, close-source fit |
| pitchfork | pitchfork, schiff, modschiff, inside | ok (T1) | true O→M median + measured variant offsets, projected right |

## Fibonacci / Gann (`fibs()`)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| fib | fib | ok (T1) | direction-aware levels with prices + trend line + reverse flag |
| fibext | fibext | ok (T2) | extension levels (1.618/2/2.618/3.618/4.236) with prices, extended right |
| fibchannel | fibchannel | ok (T2) | parallel channel lines extended + level labels |
| fibtime | fibtime | ok (T2) | full-height ok; needs level labels + prices |
| fibfan | fibfan | ok (T2) | fan to edge + ratio labels |
| fibtimebased | fibtimebased | ok (T2) | dashed stubs; needs measured trend-based time projection |
| fibcircles | fibcircles | ok (T2) | needs TV level set + labels (0.382/0.5/0.618/1) |
| fibspiral | fibspiral | ok (T2) | generic spiral; needs log-spiral math + level marks |
| fibarcs | fibarcs | ok (T2) | shares spiral path; must be concentric level ARCS instead |
| fibwedge | fibwedge | ok (T2) | wedge convergence + ratio labels per TV |
| pitchfan | pitchfan | ok (T2) | 3-anchor fan + labels |
| gannbox | gannbox, gannsqr, gannsqrfixed | ok (T2) | grid + diagonals ok; needs fans, angles, time/price labels; fixed-square scaling variant |
| gannfan | gannfan | ok (T2) | TV 1x1..1x8 angles + labels to edge |

## Patterns / cycles (`polys()`)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| poly-patterns | xabcd, cypher, headshoulders, abcd, trianglepattern, threedrives, elliott12345/ABC/ABCDE/WXY/WXYXZ | ok (T2) | ratios + dashed completion + fills + neckline |
| poly-draw | path, polyline, triangle, curve, doublecurve | ok (T2) | beziers + auto-close + fills + tangent extend |
| cyclic | cyclic | ok (T2) | repeat spacing + styling per TV |
| sine | sineline | ok (T2) | amplitude/period calibration + labels |

## Forecasting / volume / measurers (`forecast()`)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| position | longpos, shortpos, posforecast | ok (T3) | crude box; needs full risk box (entry/stop/target rows, qty, risk, P&L, blue/red fills, axis tags) |
| barspattern | barspattern | ok (T3) | line + count only; must CLONE past bars forward as ghost projection |
| ghostfeed | ghostfeed | ok (T3) | ticks only; must project future ghost bars from pattern |
| sector | sector | ok (T3) | arc + angle ok; needs TV label/format |
| vwap | vwap | ok (T3) | line ok; needs session reset + band options per TV |
| volprofile | volprofilefixed/anchored | ok (T3) | raw bars only; needs POC line, value-area highlight, side histogram |
| pricerange | pricerange | ok (T3) | band ok; needs compact stats label (abs + %) |
| daterange | daterange (+price variant) | ok (T3) | band ok; needs date/price stats label |

## Shapes (`shapes()`)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| rect | rect | ok (T3) | needs fill support + TV border style |
| rotrect | rotrect | ok (T3) | rotation math ok; needs fill + handles parity |
| ellipse | ellipse (+circle) | ok (T3) | needs fill + circle constraint parity |
| arc | arc | ok (T3) | TV arc is 3-point; needs measured arc + handles |

## Annotations (`annotations()`)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| text | text | ok (T3+T5) | bg/border/wrap + 1–100x size slider, color/Auto + opacity picker |
| note | note (+comment) | ok (T3) | needs sticky-note look + text layout |
| pricenote | pricenote | ok (T3) | leader + label; needs price formatting |
| pricelabel | pricelabel | ok (T4) | same, TV price-label chip style |
| pin | pin | ok (T4) | line + diamond ok; needs TV proportions |
| table | table | ok (T4) | static box; needs real grid rows/cols |
| callout | callout | ok (T4) | box + leader; needs TV bubble style |
| signpost | signpost | ok (T4) | needs TV signpost plate + text |
| flag | flag | ok (T4) | needs flag-mark label treatment |
| image | image | ok (T4) | placeholder only; needs pasted-image render path |
| post | post (+idea) | ok (T4) | needs title/body formatting per TV |
| icon | icon | ok (T4) | emoji + 1–10x slider done; keep size-aware |

## Freehand (`brush()`)

| kind | tools | verdict | gap to perfect |
|---|---|---|---|
| brush | brush, highlighter | ok (T3) | stroke ok; needs TV smoothing + highlighter translucency |
