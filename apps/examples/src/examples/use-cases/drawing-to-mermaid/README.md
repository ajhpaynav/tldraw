---
title: Sketch to Mermaid with TypeSafe
component: ./DrawingToMermaidExample.tsx
priority: 7
keywords:
  [mermaid, flowchart, sketch, handwriting, draw, recognition, classifier, typesafe, ai, image]
---

Sketch a flowchart by hand or with tldraw's shapes and arrows, then turn it into Mermaid source and a Mermaid diagram, with TypeSafe judging the hand-drawn parts.

---

Draw boxes, diamonds, circles and other shapes with the draw tool, join them with lines or arrows, and label them by hand or with the text tool. tldraw's own shapes, sticky notes, arrows and lines work too, and can be mixed with drawing. Press **Sketch to Mermaid**. The diagram appears to the right of the sketch, and the panel shows its Mermaid source. Edit the source and press **Redraw diagram** to fix anything that came out wrong. To convert part of the page, select those shapes first.

[TypeSafe](https://typesafe.ai)'s Jev model answers typed questions about images: it picks one option from a list, or gives the probability that a statement is true. It doesn't write text. So the example splits the work this way:

- `convertSketch.ts` reads the page. tldraw shapes and arrows already say what they are: a rectangle's shape and label, an arrow's ends and arrowheads. Those are used exactly, and only the hand-drawn parts are sent to TypeSafe.
- `segmentSketch.ts` uses geometry only to work out which strokes are nodes, which are connectors and which are labels. Outlines can be drawn in one stroke or several.
- `questions.ts` holds every question asked and the thresholds the answers are read with. For each node, TypeSafe picks its shape (rectangle, rounded rectangle, stadium, diamond, circle, cylinder, parallelogram or hexagon). For each connector, it says which end has an arrowhead, from a picture where the node at each end is drawn in its own color.
- `readLabel.ts` reads handwritten labels. TypeSafe first picks the label from a list: common flowchart words plus anything typed into the panel's labels field. That's fast and reliable. Labels that aren't on the list are read one character at a time, keeping several readings and letting TypeSafe pick and check the best one. That's slower and less reliable, so the panel lists labels TypeSafe wasn't sure about. Text typed with the text tool is used as is.
- `buildMermaid.ts` makes the decisions from those answers and writes the Mermaid source. It also picks the chart direction from the way most connectors run. `@tldraw/mermaid` then draws the source as tldraw shapes.

The TypeSafe API key must stay on a server, so requests go through a small proxy in the examples app's dev server (`apps/examples/vite.config.ts`). To run the example, add `TYPESAFE_API_KEY=...` to `apps/examples/.env.local` and restart `pnpm dev`. The proxy only answers this app, opened at `localhost` on the same machine: not other sites open in the browser, other machines on the network, or tunnels. It doesn't exist on the hosted examples site, so the example only works locally.
