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

## Pricing

Cost estimates are for comparing designs, and they say how far each figure can
be trusted.

**Where the prices come from.** AWS rates are not typed in by hand. `node
scripts/build-rate-card.mjs` reads the public AWS Price List Bulk API for all
eight regions and writes `src/core/pricing/aws-rates.json`, with each price
file's publication date beside it. Re-run it to refresh. On-demand and reserved
(standard, no upfront) rates are both loaded, per instance type and per region,
so a region or a commitment changes each line by its own published price rather
than by a blanket percentage. Azure rates were checked against the Azure Retail
Prices API and Google Cloud rates against the published pricing pages; both are
held as US list prices.

**What each line rests on.** Every cost line is one of:

| | Meaning |
| --- | --- |
| Fixed | A published rate for capacity that runs all month: instances, allocated storage, gateways. |
| Usage-based | A published rate times a volume you entered: requests, gigabytes, invocations. |
| Estimated | The rate is not verified here: a service or region whose price list is not loaded, or a size that is not sold. Shown with `~` and a note saying what was used instead. |

**Free allowances** (Lambda's first million requests, CloudFront's first
terabyte, and so on) belong to the account, not to each resource, so they are
taken off once for the whole blueprint and listed in the Budget panel.

**Assumptions.** 730 hours a month; US dollars; list price; first pricing tier
for usage-priced services. Not included: data transfer between zones and
services, support plans, backups, tax. Google Cloud and Azure components in a
non-US region are priced at US rates and marked as estimates.

## Connections

A line between two components is a claim about the system, so it carries
meaning as well as a path.

**What a line says.** Each connection has a relationship (request, data, event,
replication or dependency), optionally a protocol and a port, and a record of
where it came from: drawn by hand, read from infrastructure code, or inferred
while importing. The relationship sets the default line style and the sentence
shown in the inspector ("web reads and writes db over PostgreSQL 5432"). None of
it is measured traffic, and the interface says so. A dependency never animates,
because nothing travels along it.

**How a line runs.** `src/core/router.ts` routes every connection in right
angles on the ground:

- each end leaves from a port on the side facing where the line is going;
- lines that share a side are spread along it in the order of where they lead,
  and turn in channels of their own, so they fan out instead of piling up;
- between the ports the route is the shortest one with the fewest turns that
  does not pass through any component;
- the result is deterministic and cached, so nothing jumps between redraws.

**Shaping one by hand.** Select a connection and pull the dot on any straight
run to bend it there; drag a waypoint to move it, drop it back on the line (or
double-click it) to remove it; drag an end onto another component to reconnect
it, or onto another side of the same one to pin that side. A line you have
shaped is yours: it keeps its waypoints when components move and is never
re-planned, until you choose "Route automatically" (or tidy the whole layout).
Every step is one undo step, and undo keeps the line selected.

**Following the flow.** "Follow the flow" on a component or a connection lights
everything upstream and downstream of it and steps the rest of the diagram back.
Escape, the Stop button or the phone's Back button ends it.

**On a phone** the same handles have finger-sized invisible targets, a tap near
a line selects it at any zoom, and the dock offers Edit, Follow, Bend and
Reverse.

Older blueprints open unchanged: every new field is optional, and a connection
without them is a plain automatic one.

## On a phone

A narrow screen gets its own layout rather than a squeezed desktop one.

- **Dock.** One bar in the thumb's reach with three faces: tools, a prompt while
  a tool is in use, and the actions for whatever is selected.
- **Adding components.** The library is a sheet built for a thumb: the cloud
  switch in its header, one search field that looks across all three clouds, a
  row of category chips to flick through, then the catalogue. A finger anywhere
  on the list scrolls it; a tap adds the component where you can see it. Pictures
  are drawn as their tiles come near the screen, so the sheet opens at once.
- **Back.** The phone's Back button (or the edge swipe) takes away whatever is
  open before it takes away the page: a drop-down, then the sheet it was in,
  then a dialog, a menu, a tool waiting for a tap. One press, one layer. With
  nothing open it is the browser's ordinary Back. All of it goes through
  `src/core/nav.ts`, the only code that touches browser history: pages are real
  history entries, and while anything is open there is exactly one extra entry
  on top, so history never fills with dead steps.
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
