<div align="center">

# CloudMill Graph

**Draw cloud architecture that knows what it costs.**

An isometric design studio for AWS, Google Cloud and Azure. It prices your
architecture as you draw, reviews it for you, and turns it into Terraform.<br>
It runs entirely in your browser. No account, no server, nothing uploaded.

[**Open the app**](https://graph.cloud-mill.com) · [Features](#features) · [Quick start](#quick-start)

</div>

<picture>
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/editor-light.webp">
  <img src=".github/assets/editor-dark.webp" alt="A Kubernetes architecture on the CloudMill Graph canvas, with its monthly cost on AWS, Google Cloud and Azure in the inspector">
</picture>

## Why

Most architecture diagrams are pictures. They cannot tell you what the system
costs, whether it survives a zone going down, or how to build it, and they are
out of date the day after they are drawn.

CloudMill Graph treats the diagram as a model. Every component is configured
and priced. Every connection says what travels along it. The whole design can be
reviewed, compared across clouds, and exported as infrastructure code.

## Features

### Draw in three dimensions

A real orbit camera over an isometric scene, not a flat board with tilted
icons.

- **169 components** across AWS, Google Cloud and Azure, each with its own
  configuration and price.
- **Orbit, tilt and turn** around any point, snap to standard views with the
  view cube, or switch to a flat top view in one click.
- **Six starter blueprints**, from a three-tier web app to a streaming data
  platform, or begin on a blank canvas.
- **What you place stays put.** Nothing is nudged, re-routed or tidied behind
  your back: what is on screen when you let go is what is saved.

### Connections that mean something

- **Every line carries a relationship** (request, data, event, replication or
  dependency), with a protocol and a port.
- **Lines route themselves** in clean right angles around everything in the
  way, and moving dots show which way traffic runs.
- **Shape any line by hand** and it is kept exactly as you left it.
- **Follow the flow** lights up everything upstream and downstream of a
  component.

### Know the cost before you build

![The budget panel beside a canvas coloured by cost](.github/assets/budget.webp)

- **A live monthly estimate** for the whole blueprint and for every component
  and category.
- **Real AWS rates**, read from the public AWS Price List per instance type and
  region, with on-demand, one-year and three-year pricing.
- **A cost heatmap** on the canvas shows where the money goes.
- **Honest figures.** Each line is marked fixed, usage-based or estimated, and
  free allowances are taken off once for the whole design.

### One architecture, three clouds

The inspector prices the same design on AWS, Google Cloud and Azure, side by
side. One click moves the whole blueprint, swapping every component for its
closest equivalent, and one undo brings it back.

### A reviewer built in

![The advisor scoring a three-tier web app and listing what to fix](.github/assets/advisor.webp)

- **Thirteen checks** for reliability, security, cost and hygiene: single
  points of failure, databases in one zone, exposed data stores, missing
  firewalls, cheaper processors, idle load balancers and more.
- **A score, and what it would save.** Findings are ranked by severity, with
  the monthly saving beside each one.
- **One-click fixes**, one at a time or all the recommended ones together.

### Terraform, both ways

Paste HCL and get a laid-out diagram: resources become components, references
become connections, and VPC membership becomes areas. Export any blueprint back
to HCL for the `aws`, `google` and `azurerm` providers.

### Yours, and easy to share

<img src=".github/assets/phone.webp" alt="CloudMill Graph on a phone, with a component selected" width="230" align="right">

- **Nothing leaves your browser.** Blueprints autosave locally, with version
  history.
- **Share by link.** The whole diagram is compressed into the URL, so there is
  nothing to upload and nothing to sign in to.
- **Export** to PNG, SVG, Terraform, JSON and CSV.
- **At home on a phone.** A layout of its own with map-style gestures: drag,
  pinch, twist to turn, two fingers to tilt. It installs to the home screen.
- **Fast to drive.** A command palette (`⌘K` or `Ctrl K`), keyboard shortcuts
  throughout, undo and redo, auto-layout, a minimap, and light and dark themes.

<br clear="all">

## Quick start

Try it now at [graph.cloud-mill.com](https://graph.cloud-mill.com), or run it
locally with Node 20 or newer:

```bash
npm install
npm run dev
```

Open <http://localhost:5183> and start from a sample blueprint.

## Development

| Command            | What it does                                      |
|--------------------|---------------------------------------------------|
| `npm run dev`      | Start the dev server                              |
| `npm run build`    | Typecheck and build for production                |
| `npm test`         | Unit and component tests                          |
| `npm run test:e2e` | End-to-end tests in Google Chrome                 |
| `npm run verify`   | Everything: types, lint, tests, build, end-to-end |
| `npm run bench`    | Measure frame times on blueprints of any size     |

The project is held to a high bar: more than 1,300 unit and component tests,
about 600 end-to-end tests across desktop and four phone profiles, a 98%
coverage floor, WCAG 2.1 AA checks in both themes, and tests that photograph
the canvas to prove it stays sharp at every frame of a zoom.

## Under the hood

React 19, TypeScript, Zustand and Vite. The canvas is plain SVG with no drawing
library, and there is no backend.

```
src/core     projection maths, catalog and pricing, routing, layout, advisor,
             Terraform import and export, storage
src/canvas   isometric models, the renderer, the interactive canvas, image export
src/ui       editor shell, panels, dialogs, dashboard
```

One pure renderer draws the editor, the thumbnails, the previews and the
exports, so what you export is what you saw.

---

Cost figures are estimates from public list prices. CloudMill Graph is an
independent project; AWS, Google Cloud and Azure service names are used for
reference only.
