// house-style shared script: KaTeX auto-render (offline, local files) + fit wide equations
// Math pages load katex.min.js + auto-render.min.js + this file, all with `defer`.

function fitEquations() {
  // Wide display equations are scaled down to fit their container (.eq{overflow:hidden}),
  // instead of scrolling. Inline math is left as-is.
  document.querySelectorAll('.eq').forEach(function (box) {
    var disp = box.querySelector('.katex-display');
    if (!disp) return;
    var inner = disp.querySelector('.katex');
    if (!inner) return;
    // reset any previous fit before measuring
    disp.style.transform = '';
    disp.style.height = '';
    var avail = box.clientWidth;
    var w = inner.getBoundingClientRect().width;
    if (avail > 0 && w > avail) {
      var s = avail / w;
      disp.style.transformOrigin = 'center top';
      disp.style.transform = 'scale(' + s + ')';
      // shrink the reserved height so the scaled equation doesn't leave a gap
      disp.style.height = disp.getBoundingClientRect().height * s + 'px';
    }
  });
}

document.addEventListener('DOMContentLoaded', function () {
  if (typeof renderMathInElement === 'function') {
    renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false
    });
  }
  fitEquations();
});

// re-fit on resize (debounced) so rotating a phone / resizing keeps equations in-frame
var _fitTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(fitEquations, 150);
});
