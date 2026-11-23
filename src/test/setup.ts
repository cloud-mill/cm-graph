/**
 * Runs before every unit and component test file (`setupFiles` in vitest.config.ts), in plain Node and in jsdom
 * alike. Everything that needs a DOM is inside the check for one further down.
 */
import { afterEach, beforeEach } from 'vitest'

/** In-memory Web Storage, for the Node environment and for a clean slate between tests. */
class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
}

const g = globalThis as any
// only where there is no usable localStorage already (one with a working `clear`)
if (typeof g.localStorage === 'undefined' || typeof g.localStorage.clear !== 'function') {
  Object.defineProperty(g, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true })
}

beforeEach(() => { localStorage.clear() })

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // loaded here and not at the top, so tests in plain Node never import the DOM matchers or React Testing Library
  await import('@testing-library/jest-dom/vitest')
  const { cleanup } = await import('@testing-library/react')

  // browser APIs that jsdom does not implement
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as any
  const proto = Element.prototype as any
  proto.scrollIntoView ??= function () {}
  proto.setPointerCapture ??= function () {}
  proto.releasePointerCapture ??= function () {}
  proto.hasPointerCapture ??= () => false
  ;(document as any).elementFromPoint ??= () => null
  ;(document as any).execCommand ??= () => false
  // jsdom stamps animation frames on its own clock, which starts later than Node's performance.now();
  // browsers use one clock for both, so give the tests one too
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id)
  window.requestAnimationFrame = g.requestAnimationFrame
  window.cancelAnimationFrame = g.cancelAnimationFrame
  // jsdom's Blob has no stream(); share links compress through one
  ;(Blob.prototype as any).stream ??= function (this: Blob) {
    const bytes = () => this.arrayBuffer()
    return new ReadableStream({ async start(c) { c.enqueue(new Uint8Array(await bytes())); c.close() } })
  }
  URL.createObjectURL ??= () => 'blob:test'
  URL.revokeObjectURL ??= () => {}

  // unmount what the test rendered, and undo what the app writes outside React: the route and the theme
  afterEach(() => {
    cleanup()
    location.hash = ''
    delete document.documentElement.dataset.theme
  })
}
