// Canonical print geometry shared with tool/businessCardDesign.py. Values are
// authoring metres, not a request to measure the user's actual paper size.
const pattern = {
  bagBreakup: { accent: [0, 135, 156], left: ["AOI", "I_A", "OA_", "AIO", "OIA"], right: ["IA_", "OIA", "_OI", "IAO"] },
  oscillatingDroplet: { accent: [233, 173, 42], left: ["AI_", "OAI", "I_A", "AIO", "IOA"], right: ["OAI", "_IA", "AO_", "IAO"] },
  windWave: { accent: [102, 82, 161], left: ["AIO", "OA_", "IOA", "_AI", "AOI"], right: ["A_O", "IAO", "OI_", "AOI"] },
  medullaryCavity: { accent: [143, 54, 92], left: ["_IA", "AOI", "IAO", "OA_", "AIO"], right: ["OIA", "A_O", "IAO", "_OI"] }
};
const colorName = { A: "accent", I: "ink", O: "orange" };
const cache = new Map();

export function getCardPointLayout(caseId) {
  if (!Object.hasOwn(pattern, caseId)) return null;
  if (cache.has(caseId)) return cache.get(caseId);
  const definition = pattern[caseId];
  const points = [];
  const missingCells = [];
  for (const [side, origin] of [["left", [5.5, 4.5]], ["right", [68.5, 18.5]]]) {
    definition[side].forEach((row, rowIndex) => {
      [...row].forEach((value, column) => {
        // The print origin is the square's top-left corner; detect its centre.
        const cell = Object.freeze({
          id: `${side}-${rowIndex}-${column}`, side, row: rowIndex, column,
          x: (origin[0] + column * 7 + 1.5 - 91 / 2) / 1000,
          y: (55 / 2 - origin[1] - rowIndex * 7 - 1.5) / 1000,
          color: colorName[value] || null
        });
        (cell.color ? points : missingCells).push(cell);
      });
    });
  }
  const layout = Object.freeze({
    caseId, width: 0.091, height: 0.055, cellSize: 0.003, pitch: 0.007,
    points: Object.freeze(points), missingCells: Object.freeze(missingCells),
    palette: Object.freeze({
      accent: Object.freeze([...definition.accent]),
      ink: Object.freeze([10, 28, 42]), orange: Object.freeze([217, 84, 50])
    })
  });
  cache.set(caseId, layout);
  return layout;
}

export const cardPointCaseIds = Object.freeze(Object.keys(pattern));
