import { getCardPointLayout as getExistingLayout } from "../cardPointLayout.js";

// Public print geometry only. The Test Box card has its own asymmetric colour
// order and holes, while keeping the established 91 x 55 mm card geometry.
export const testBoxPattern = Object.freeze({
  accent: Object.freeze([57, 155, 99]),
  left: Object.freeze(["AIO", "O_A", "IAO", "AO_", "OAI"]),
  right: Object.freeze(["IOA", "A_O", "OIA", "IA_"]),
});
const colorName = { A: "accent", I: "ink", O: "orange" };
const points = [], missingCells = [];
for (const [side, origin] of [["left", [5.5, 4.5]], ["right", [68.5, 18.5]]]) {
  testBoxPattern[side].forEach((row, rowIndex) => {
    [...row].forEach((value, column) => {
      const cell = Object.freeze({
        id: `${side}-${rowIndex}-${column}`, side, row: rowIndex, column,
        x: (origin[0] + column * 7 + 1.5 - 91 / 2) / 1000,
        y: (55 / 2 - origin[1] - rowIndex * 7 - 1.5) / 1000,
        color: colorName[value] || null,
      });
      (cell.color ? points : missingCells).push(cell);
    });
  });
}
const testBoxLayout = Object.freeze({
  caseId: "testBox", width: 0.091, height: 0.055, cellSize: 0.003, pitch: 0.007,
  points: Object.freeze(points), missingCells: Object.freeze(missingCells),
  palette: Object.freeze({ accent: testBoxPattern.accent,
    ink: Object.freeze([10, 28, 42]), orange: Object.freeze([217, 84, 50]) }),
});

export function getCardPointLayout(caseId) {
  return caseId === "testBox" ? testBoxLayout : getExistingLayout(caseId);
}
