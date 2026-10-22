/* Implementation: MIT, Copyright (c) 2026 KIDENA-Fumiya.
 * Numerical reference: Ghia, Ghia & Shin (1982), Tables I-II, Re=100.
 * https://doi.org/10.1016/0021-9991(82)90058-4
 * Coordinates and velocities below are normalized by cavity size and lid speed.
 * The cited paper is not covered by this implementation's MIT license.
 */
(function (root) {
  'use strict';
  const vertical = [
    [0, 0], [.0547, -.03717], [.0625, -.04192], [.0703, -.04775],
    [.1016, -.06434], [.1719, -.10150], [.2813, -.15662], [.4531, -.21090],
    [.5, -.20581], [.6172, -.13641], [.7344, .00332], [.8516, .23151],
    [.9531, .68717], [.9609, .73722], [.9688, .78871], [.9766, .84123], [1, 1]
  ];
  const horizontal = [
    [0, 0], [.0625, .09233], [.0703, .10091], [.0781, .10890],
    [.0938, .12317], [.1563, .16077], [.2266, .17507], [.2344, .17527],
    [.5, .05454], [.8047, -.24533], [.8594, -.22445], [.9063, -.16914],
    [.9453, -.10313], [.9531, -.08864], [.9609, -.07391], [.9688, -.05906], [1, 0]
  ];
  function sample(frame) {
    const re = frame.options.lid * frame.ly / frame.options.nu;
    if (frame.options.case !== 'cavity' || !Number.isFinite(re) || Math.abs(re-100) > 1e-6
      || Math.abs(frame.lx/frame.ly-1) > 1e-10) return null;
    const speed = frame.options.lid*1000;
    return {
      re: 100,
      u: vertical.map(([y, u]) => ({ x: u*speed, y: y*frame.ly*1000 })),
      v: horizontal.map(([x, v]) => ({ x: x*frame.lx*1000, y: v*speed }))
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { sample };
  else root.GhiaReference = { sample };
})(globalThis);
