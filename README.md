# CloudMill Graph

An isometric cloud architecture studio that runs entirely in the browser: draw
infrastructure diagrams that know what they cost, review themselves, and
round-trip with Terraform.

```bash
npm install
npm run dev        # http://localhost:5183
npm test           # unit and component tests
npm run build      # typecheck + production bundle
```

## What it does

- **Isometric canvas**: pan, zoom, orbit, snapping, marquee select, copy and
  paste, undo and redo, resizable components, areas (VPC, subnet, zone, group)
  and text labels.
- **AWS, Google Cloud and Azure**: about 170 components, each with
  configuration and pricing. Search looks across all three clouds.
- **Cloud translation**: the same architecture priced on each cloud, and one
  click to swap every component for its closest equivalent.
- **Budget**: live monthly estimate, region and commitment pricing, a cost
  heatmap and CSV export.
- **Advisor**: well-architected checks with one-click fixes and a score.
- **Terraform**: paste HCL to get a laid-out diagram, export any diagram back
  to HCL (`aws`, `google`, `azurerm`).
- **Export** to PNG, SVG, Terraform, JSON and CSV. **Share** by link: the
  diagram lives in the URL, so nothing is uploaded.
- **Also**: version history, autosave to local storage, command palette (`⌘K`),
  minimap, auto-layout, light and dark themes.

## Design

Black, white and zinc, set in Geist. Colour appears only where it carries
meaning and in the architecture itself. The shell is flat; only what floats over
the canvas is glass. Tokens live at the top of `src/styles.css`.

## Layout

```
src/core     projection maths, catalog and pricing, store, routing, layout,
             advisor, Terraform import and export, storage
src/canvas   isometric models, the pure <Scene/>, the interactive canvas,
             image export
src/ui       editor shell, panels, dialogs, dashboard
```

`<Scene/>` is a pure function of the document and a projection, so one renderer
drives the editor, thumbnails, previews and exports.

## Pricing

Estimates are for comparing designs, and each figure says how far it can be
trusted.

- **AWS rates come from the public AWS Price List API**, per instance type and
  region, on-demand and reserved. Refresh with
  `node scripts/build-rate-card.mjs`. Azure and Google Cloud are held as US list
  prices.
- **Every cost line is Fixed, Usage-based or Estimated.** Estimated lines are
  marked `~` with a note saying what was used instead.
- **Free allowances** are taken off once for the whole blueprint.
- **Assumes** 730 hours a month, US dollars, list price, first pricing tier.
  Not included: data transfer, support plans, backups, tax.

## Editing

Two rules, both held by tests (`e2e/free.spec.ts`):

1. **What is in your hand is drawn, not written.** The blueprint changes once,
   on release. Escape before then puts everything back.
2. **What is on screen when you let go is what stays.** Nothing is rounded,
   pushed, eased or re-planned afterwards, and nothing else moves.

- **Carrying**: a component goes exactly as far as the pointer. Shift keeps to
  one axis, Alt carries a copy.
- **Snapping** is a tool and starts off (`S`). Ctrl flips it for one drag.
- **Connecting**: pull from one of a component's four doors and let go on or
  near another. Let go on open ground to add a new component already connected.
- **Dropping a component onto a line** puts it in the middle of that line.
- **Arranging**: Shift-drag selects a box; the bar above aligns, spaces, groups
  or duplicates.

## Connections

- **A line carries meaning**: a relationship (request, data, event, replication
  or dependency), optionally a protocol and a port.
- **Routing** is right-angled, shortest path with the fewest turns, never
  through a component, deterministic and cached (`src/core/router.ts`).
- **Automatic or Manual.** An automatic line is planned once and again only when
  its own components change. Drag any part and it becomes manual, kept exactly
  where you left it (`src/core/shape.ts`). Neither is re-planned behind your
  back.
- **Shaping**: pull a run sideways, drag a turn, right-click for "Add a bend
  here", double-click a turn to remove it. A run brought level with the next
  merges with it.
- **Straighten** makes a line one straight run and keeps it so; "Line up" moves
  a component when no straight line is possible.
- **Follow the flow** lights everything upstream and downstream.
- **Other shapes**: Direct (one stroke at any angle) or Curved.

## Performance

- **Small blueprints** (up to forty components, traffic on, with a mouse) are
  drawn whole at every frame. It is cheap at that size and is what a screen
  shows most evenly.
- **Larger blueprints** slide an already drawn picture when panned, so a pan
  draws nothing.
- **A zoom draws everything at its own size on every frame**, so it is never
  soft, during or after.
- **Only what is near the screen is drawn** past a few hundred components, and
  from far out components are drawn plainly.
- **Traffic** moves at every frame on a small blueprint, in steps on a larger
  one, and stops after two minutes untouched.

`npm run bench` measures all of it (see [Testing](#testing)).

## On a phone

A narrow screen gets its own layout: a dock in the thumb's reach, the library
and inspector as sheets, and the Back button closing one layer at a time.

| Gesture                      | What it does                         |
|------------------------------|--------------------------------------|
| Drag with one finger         | Move                                 |
| Pinch                        | Zoom about the point between fingers |
| Twist two fingers            | Turn the scene                       |
| Slide two fingers up or down | Tilt                                 |
| Double tap the ground        | Zoom in there                        |
| Tap with two fingers         | Zoom out                             |
| Drag the cube                | Orbit                                |

Tap selects, drag moves, press and hold picks up or opens a menu. Connecting is
two taps: the first component, then the one it talks to. Tablets and touch
laptops get the same gestures with the desktop layout.

## Testing

`npm run verify` runs everything, in order.

| Command                 | What it runs                                         |
|-------------------------|------------------------------------------------------|
| `npm run typecheck`     | TypeScript                                           |
| `npm run lint`          | oxlint                                               |
| `npm test`              | Unit and component tests (Vitest)                    |
| `npm run test:coverage` | The same, with a coverage floor                      |
| `npm run test:e2e`      | End-to-end tests in Google Chrome, on the dev server |
| `npm run test:e2e:prod` | The same, on the production build                    |
| `npm run test:perf`     | Only the performance and stability tests             |
| `npm run test:e2e:ui`   | Playwright's interactive runner                      |
| `npm run bench`         | Frame times and edit latency, 30 to 2,000 components |

- **Unit tests** cover the pure logic in `src/core`.
- **Component tests** render the real components against the real store.
  Only browser boundaries are mocked.
- **End-to-end tests** cover editing, every panel and dialog, six screen sizes,
  four phone profiles with real multi-touch, accessibility (WCAG 2.1 AA) and
  performance. Any page error fails the test.
- **Sharpness** is tested by photographing the screen in the middle of a zoom
  and again at rest: the two must match (`e2e/sharp.spec.ts`).
- **Coverage** is held at 98% of statements, functions and lines and 94% of
  branches.

The first end-to-end run needs Google Chrome (`npx playwright install chrome`).
Safari's engine is opt-in: `npx playwright install --with-deps webkit`, then
`E2E_WEBKIT=1 npm run test:e2e -- --project=safari`.

Prices are estimates from approximate public list prices. CloudMill Graph is an
independent project; AWS, Google Cloud and Azure service names are used for
reference only.
