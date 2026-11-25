import { type Plugin, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Starts the downloads the first screen needs at the same moment as the app's own, and paints the page in its theme
 * before any of it has arrived. Only the built page is touched: the dev server serves modules one by one anyway.
 *
 * The app's code is in three files: what every screen needs, the list of blueprints (`ui/Dashboard`), and the editor
 * (`ui/editing`). Left alone, the browser would fetch the first, run it, and only then learn it needs one of the others.
 * The address says which screen it will be, so a few lines in the page ask for it straight away. The font that
 * nearly all text is set in is asked for the same way, instead of being found when the stylesheet has been read.
 */
function firstScreen(): Plugin {
  let base = '/'
  return {
    name: 'first-screen',
    apply: 'build',
    configResolved(config) { base = config.base },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const files = Object.values(ctx.bundle ?? {})
        const chunks = files.filter((f) => f.type === 'chunk')
        const screen = (name: string) => chunks.find((c) => c.name === name)
        // a screen's chunk and everything it imports outright, so none of them is found one after another
        const withImports = (name: string) => {
          const seen = new Set<string>(), first = screen(name)
          const walk = (file: string) => {
            if (seen.has(file)) return
            seen.add(file)
            for (const next of chunks.find((c) => c.fileName === file)?.imports ?? []) walk(next)
          }
          if (first) walk(first.fileName)
          return [...seen].map((f) => base + f)
        }
        // The font nearly all text is set in, for the list of blueprints only. That page is words, and without this they are
        // drawn in a stand-in first and redrawn when the font arrives, which moves the whole page. The editor is mostly
        // drawing, shows no such jump, and would only wait longer for its code if the font were fetched alongside it
        const font = files.find((f) => f.type === 'asset' && /geist-latin-wght-normal/.test(f.fileName))
        const need = { list: withImports('Dashboard'), editor: withImports('editing'), font: font ? base + font.fileName : '' }
        const first = [
          // the theme is known before the stylesheet is: no flash of the wrong one, and no white page while it loads
          `<style>html{background:#0a0a0a}html[data-theme=light]{background:#fafafa}</style>`,
          `<script>(function(){var d=document,t='dark';try{t=JSON.parse(localStorage.getItem('stratum:pref:theme'))||t}catch(e){}d.documentElement.dataset.theme=t;` +
            `var s=${JSON.stringify(need)},e=/^#\\/[ds]\\//.test(location.hash),a=e?s.editor:s.list;` +
            `function p(h,f){var l=d.createElement('link');l.href=h;if(f){l.rel='preload';l.as='font';l.type='font/woff2';l.crossOrigin=''}else l.rel='modulepreload';d.head.appendChild(l)}` +
            `for(var i=0;i<a.length;i++)p(a[i]);if(!e&&s.font)p(s.font,1)})()</script>`,
        ]
        // Ahead of the stylesheet, not after it: a script that follows a stylesheet is not run until the stylesheet has
        // arrived, which is exactly the wait this is here to avoid
        return html.replace(/<meta charset="[^"]*"\s*\/?>/i, (m) => m + first.join(''))
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), firstScreen()],
  // the everyday dev server. The end-to-end tests start their own on other ports: see playwright.config.ts
  server: { port: 5183 },
})
