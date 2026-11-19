import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SCALE, MIN_SCALE, centerOf, emptyDoc, footOf, uid } from './types'

afterEach(() => { vi.useRealTimers() })

describe('types', () => {
  it('sizes a component from its scale', () => {
    expect(footOf({})).toBe(2)
    expect(footOf({ scale: 1 })).toBe(2)
    expect(footOf({ scale: MIN_SCALE })).toBe(1)
    expect(footOf({ scale: MAX_SCALE })).toBe(6)
    expect(centerOf({ x: 4, y: -2 })).toEqual([5, -1])
    expect(centerOf({ x: 0, y: 0, scale: 3 })).toEqual([3, 3])
    expect(centerOf({ x: 1, y: 1, scale: 0.5 })).toEqual([1.5, 1.5])
  })
  it('creates short url-safe ids that do not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, uid))
    expect(ids.size).toBe(2000)
    for (const id of [...ids].slice(0, 50)) expect(id).toMatch(/^[a-z0-9]{5,10}$/)
  })
  it('creates an empty blueprint stamped with the current time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'))
    const d = emptyDoc()
    expect(d).toMatchObject({ name: 'Untitled blueprint', region: 'us-east-1', nodes: [], edges: [], areas: [], labels: [] })
    expect(d.createdAt).toBe(Date.parse('2026-01-02T03:04:05Z'))
    expect(d.updatedAt).toBe(d.createdAt)
    expect(emptyDoc('Mine').name).toBe('Mine')
    expect(emptyDoc().nodes).not.toBe(d.nodes)
  })
})
