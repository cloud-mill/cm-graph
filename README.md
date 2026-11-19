# CloudMill Graph

An isometric cloud architecture studio that runs entirely in the browser: draw
infrastructure diagrams that know what they cost, review themselves, and
round-trip with Terraform.

```bash
npm install
npm run dev        # http://localhost:5183
npm test           # core logic tests
npm run build      # typecheck + production bundle
```

## What it does

- **Isometric canvas** with pan, zoom, snapping, marquee select, alt-drag clone,
  copy/paste, undo/redo, resizable components (drag a corner, 50 to 300%), areas (VPC / subnet / zone / group), ground-plane text
  labels and orthogonal connections.
- **Orbit camera**, CAD-style: right-drag (or `⌥`-drag, or the Orbit tool `O`)
  to rotate and tilt the scene around the point under the cursor, `Q` / `E` to
  turn in 45° steps, and a view cube for Top / Front / Back / Left / Right.
  `2` is the top view and `3` the home isometric view. Labels stay upright
  from every angle.
- **AWS, Google Cloud and Azure**: about 170 components across compute,
  database, storage, networking, messaging, analytics, AI, security and
  dev tooling, each with configuration and pricing. The library shows one
  cloud at a time; search looks across all three.
- **Cloud translation**: the inspector prices the same architecture on each
  cloud, and one click swaps every component for its closest equivalent
  (EC2 ↔ Compute Engine ↔ Virtual Machines, and so on), keeping shared sizing.
- **Budget**: live monthly estimate per component and per category, region
  multipliers, on-demand vs 1- and 3-year commitment pricing, a cost heatmap on
  the canvas, and CSV export.
- **Advisor**: static well-architected checks (single-AZ databases, single
  points of failure, exposed data stores, missing WAF, Graviton and arm64
  savings, idle load balancers, missing DLQs…) with one-click fixes and a score.
- **Terraform**: paste HCL to get a laid-out diagram (resources become
  components, references become connections, VPC membership becomes areas), and
  export any diagram back to HCL. Works with the `aws`, `google` and `azurerm`
  providers.
- **Export** to PNG, SVG, Terraform, JSON and CSV. **Share** by link: the
  diagram is compressed into the URL fragment, so nothing is uploaded.
- **Version history**, autosave to local storage, command palette (`⌘K`),
  minimap, auto-layout, light and dark themes.

## Design

Black, white and zinc, set in Geist. White is the only accent; colour appears
where it carries meaning (saved, cheapest, severity) and in the architecture
itself, which is the one colourful thing on screen. The shell is flat and
hairline-ruled: a docked top bar, library and inspector around a framed
canvas. Only what floats over the canvas (toolbar, read-outs, menus, dialogs)
is glass. Panels hide with `[`, `]` and `\`. All tokens live at the top of
`src/styles.css`, with a matching light theme.

## Layout

```
src/core     projection maths, catalog + pricing, store, routing, layout,
             advisor, Terraform import/export, storage, exporters
src/canvas   procedural isometric models, the pure <Scene/>, the interactive canvas
src/ui       editor shell, panels, dialogs, dashboard
```

`<Scene/>` is a pure function of the document and a projection, so the same
renderer drives the editor, dashboard thumbnails, dialog previews and exports.

## On a phone

A narrow screen gets its own layout rather than a squeezed desktop one.

- **Dock.** One bar in the thumb's reach with three faces: tools, a prompt while
  a tool is in use, and the actions for whatever is selected.
- **Sheets.** The library and the inspector rise over the canvas, can be pulled
  taller or flicked away, and leave the canvas live above them. Sideways, they
  dock to the right edge. The on-screen keyboard lifts them instead of covering them.
- **Getting around** works the way maps do. The ground under your fingers stays
  under your fingers.

  | Gesture | What it does |
  | --- | --- |
  | Drag with one finger | Move. A flick coasts; a touch stops it. |
  | Pinch | Zoom about the point between your fingers. |
  | Twist two fingers | Turn the scene the way your fingers turn, about that point. A pinch never turns by accident: the twist has to be meant. |
  | Slide two fingers up or down, side by side | Tilt, from near the horizon to straight overhead. |
  | Double tap the ground | Zoom in on that spot. Keep the second tap down and slide to zoom with one thumb. |
  | Tap with two fingers | Zoom out. |
  | Drag the cube | Orbit with one thumb. Its faces are the standard views. |

  A read-out shows the angle while you turn or tilt. Once the camera is off its
  home angle a compass button appears and takes you back; if the diagram slides
  out of sight, so does "Back to diagram". The gestures are drawn once on a first
  visit and live under Menu, "Touch gestures".
- **Editing.** Tap selects. Drag a selected component to move it, or press and
  hold any component to pick it up in one motion. Press and hold the ground for a menu.
- **Connecting** is two taps: the first component, then the one it talks to.
- **Guides** appear while a component being moved lines up with another.

Touch gestures follow the pointer in use, so tablets and touch laptops get them
with the desktop layout. The app can be added to a phone's home screen.

## Testing

Three layers, all run by `npm run verify`.

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript, over the app, the tests and the config |
| `npm run lint` | oxlint: correctness, React hooks and accessibility rules |
| `npm test` | Unit and component tests (Vitest) |
| `npm run test:coverage` | The same, with a coverage report in `coverage/` and a floor that fails the run |
| `npm run test:e2e` | End-to-end tests in Google Chrome (Playwright), against the dev server |
| `npm run test:e2e:prod` | The same tests against the production build |
| `npm run test:perf` | Only the performance and stability tests |
| `npm run test:e2e -- --project=android` | Only the phone tests on one profile (`android`, `iphone`, `small-phone`, `landscape`) |
| `npm run test:e2e:ui` | Playwright's interactive runner, for debugging |
| `npm run verify` | Everything above, in order |

**Unit tests** (`src/core/*.test.ts`) cover the pure logic in plain Node:
projection maths, routing, layout, pricing for every component and option,
advisor rules and their fixes, Terraform import and export for all three
clouds, storage, share links and every store action.

**Component tests** (`src/ui`, `src/canvas`, `src/App.test.tsx`) render the
real components against the real store in jsdom. Nothing of the app is mocked;
only browser boundaries are (clipboard, file downloads, image rasterising).

**End-to-end tests** (`e2e/`) drive Google Chrome. They start their own server
on a separate port, so their saved blueprints never mix with yours. Every test
also fails if the page logs an error. They cover the dashboard, canvas editing,
the library, every panel and dialog, the camera, persistence and failure
handling, six screen sizes from 320 to 1920 pixels wide, automated WCAG 2.1 AA
checks (axe) in both themes, and performance: frame time on a 300-component
blueprint, no redrawing of components that did not change, and no growth in
listeners, DOM or memory across repeated open and close cycles.

The phone tests run on four device profiles (Pixel 7, iPhone 15, iPhone SE and
a phone held sideways) and send real multi-touch input through Chrome, so
pinch, twist and press-and-hold are exercised the way a screen delivers them.
These are Chrome with each phone's size, pixel ratio, touch and user agent.
Safari's own engine is opt-in, because it needs system libraries:
`npx playwright install --with-deps webkit`, then `E2E_WEBKIT=1 npm run test:e2e -- --project=safari`.

The first end-to-end run needs Google Chrome installed (`npx playwright install chrome`
if it is not). `.github/workflows/ci.yml` runs the whole set on every push and
pull request.

Coverage is held at 98% of statements, functions and lines and 94% of branches
by `vitest.config.ts`; the suite currently sits above 99.5% and 96.5%.

Prices are estimates from approximate public list prices. CloudMill Graph is an
independent project; AWS, Google Cloud and Azure service names are used for
reference only.
