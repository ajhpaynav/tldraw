---
title: Snap drawings to shapes
component: ./SnapDrawingsToShapesExample.tsx
category: use-cases
priority: 6
keywords:
  [
    shape recognition,
    sketch,
    freehand,
    draw,
    convert,
    geo,
    arrow,
    binding,
    actions,
    context menu,
    keyboard shortcut,
  ]
---

Sketch freely, then turn the strokes you select into hand-drawn geo shapes, lines and connected arrows.

---

Draw with the draw tool, switch to the select tool, select some strokes and press `Shift+S`, or right-click and choose **Convert to shapes**. Each stroke the recognizer is confident about is replaced:

- A closed stroke becomes a rectangle, ellipse, triangle or diamond, fitted to the stroke and snapped upright when it was drawn within about 10° of axis-aligned.
- A straight stroke becomes a line, or an arrow if either end touches a shape or you drew an arrowhead. Arrowheads can be a hook at the end of the same stroke, or a separate small V near one end.
- Arrows are bound to the shapes they touch, including shapes converted in the same pass, and an arced stroke becomes a bent arrow.

New shapes keep the stroke's color, size, fill, opacity and place in the stacking order, and use the `draw` dash style so they still look hand-drawn. Anything the recognizer isn't sure about stays as ink, and the whole conversion is a single undo step.

`recognizeStroke.ts` is a pure function from page-space points to a result, so it can be tuned against the generated fixtures in `recognizeStroke.test.ts` without an editor. `convertDrawings.ts` reads the selected strokes, calls the recognizer and creates the shapes and bindings. The example component adds the action through the `overrides` prop and shows it in the context menu.
