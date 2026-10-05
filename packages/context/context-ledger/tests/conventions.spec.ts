import { describe, expect, it } from 'vitest'
import { conventionCandidates, renderConventions } from '../src/conventions.ts'

const ROOT = '/work/demo'

describe('conventionCandidates', () => {
  it('runs from the touched file directory up to the project root', () => {
    const candidates = conventionCandidates({
      touchedPath: '/work/demo/packages/inner/src/a.ts',
      projectRoot: ROOT,
      fileNames: ['CONTEXT.md'],
    })
    expect(candidates).toEqual([
      '/work/demo/packages/inner/src/CONTEXT.md',
      '/work/demo/packages/inner/CONTEXT.md',
      '/work/demo/packages/CONTEXT.md',
      '/work/demo/CONTEXT.md',
    ])
  })

  it('gives a file directly in the project root exactly one candidate', () => {
    expect(conventionCandidates({
      touchedPath: '/work/demo/a.ts',
      projectRoot: ROOT,
      fileNames: ['CONTEXT.md'],
    })).toEqual(['/work/demo/CONTEXT.md'])
  })

  it('makes every configured file name a candidate at every level', () => {
    // The touched file's own directory is the project root, so both names appear
    // once, in configured order.
    expect(conventionCandidates({
      touchedPath: '/work/demo/a.ts',
      projectRoot: ROOT,
      fileNames: ['CONTEXT.md', 'NOTES.md'],
    })).toEqual(['/work/demo/CONTEXT.md', '/work/demo/NOTES.md'])
  })

  it('gives a file outside the project no candidates', () => {
    expect(conventionCandidates({
      touchedPath: '/elsewhere/a.ts',
      projectRoot: ROOT,
      fileNames: ['CONTEXT.md'],
    })).toEqual([])
  })
})

describe('renderConventions', () => {
  it('includes every document that fits, nearest first', () => {
    const text = renderConventions({
      documents: [
        { path: '/work/demo/packages/CONTEXT.md', text: 'inner' },
        { path: '/work/demo/CONTEXT.md', text: 'root' },
      ],
      projectRoot: ROOT,
      maxBytes: 65536,
    }).text
    expect(text.startsWith('Conventions for directories this session has touched:')).toBe(true)
    expect(text).toContain('## packages/CONTEXT.md')
    expect(text).toContain('inner')
    expect(text).toContain('## CONTEXT.md')
    expect(text.indexOf('inner')).toBeLessThan(text.indexOf('root'))
  })

  it('heads the project root itself without a blank or absolute path', () => {
    const text = renderConventions({
      documents: [{ path: '/work/demo/CONTEXT.md', text: 'root' }],
      projectRoot: ROOT,
      maxBytes: 65536,
    }).text
    expect(text).toContain('## CONTEXT.md')
    expect(text).not.toContain('## /work/demo')
  })

  it('trims trailing whitespace on a body so the message is stable', () => {
    const text = renderConventions({
      documents: [{ path: '/work/demo/CONTEXT.md', text: 'body\n\n\n' }],
      projectRoot: ROOT,
      maxBytes: 65536,
    }).text
    expect(text.endsWith('body')).toBe(true)
  })

  it('drops later documents when the ceiling binds, and says how many', () => {
    const documents = [
      { path: '/work/demo/a/CONTEXT.md', text: 'first'.repeat(10) },
      { path: '/work/demo/CONTEXT.md', text: 'second'.repeat(10) },
    ]
    const full = renderConventions({ documents, projectRoot: ROOT, maxBytes: 65536 })
    expect(full.included).toBe(2)
    expect(full.omitted).toBe(0)

    const kept = renderConventions({ documents, projectRoot: ROOT, maxBytes: Buffer.byteLength(full.text, 'utf8') - 1 })
    expect(kept.included).toBe(1)
    expect(kept.omitted).toBe(1)
    expect(kept.text).toContain('first')
    expect(kept.text).not.toContain('second')
    expect(kept.text).toMatch(/1 further convention file in these directories was too large/u)
  })

  it('contributes nothing, not a fragment, when the ceiling cannot hold one document', () => {
    const rendered = renderConventions({
      documents: [{ path: '/work/demo/CONTEXT.md', text: 'body' }],
      projectRoot: ROOT,
      maxBytes: 8,
    })
    expect(rendered.text).toBe('')
    expect(rendered.included).toBe(0)
    expect(rendered.omitted).toBe(1)
  })

  it('contributes nothing for no documents', () => {
    expect(renderConventions({ documents: [], projectRoot: ROOT, maxBytes: 65536 }))
      .toEqual({ text: '', included: 0, omitted: 0 })
  })

  it('is deterministic for identical inputs', () => {
    const input = {
      documents: [{ path: '/work/demo/CONTEXT.md', text: 'body' }],
      projectRoot: ROOT,
      maxBytes: 65536,
    }
    expect(renderConventions(input).text).toBe(renderConventions(input).text)
  })
})

describe('heading and footer edges', () => {
  it('falls back to the absolute path when a document is the project root itself', () => {
    const text = renderConventions({
      documents: [{ path: ROOT, text: 'root' }],
      projectRoot: ROOT,
      maxBytes: 65536,
    }).text
    expect(text).toContain(`## ${ROOT}`)
  })

  it('pluralises the omission note when more than one document is left out', () => {
    const nearest = { path: '/work/demo/a/CONTEXT.md', text: 'first'.repeat(10) }
    const documents = [
      nearest,
      { path: '/work/demo/b/CONTEXT.md', text: 'second'.repeat(10) },
      { path: '/work/demo/CONTEXT.md', text: 'third'.repeat(10) },
    ]
    // Derive the ceiling from a one-document render, so exactly one fits.
    const single = renderConventions({ documents: [nearest], projectRoot: ROOT, maxBytes: 65536 })
    const kept = renderConventions({
      documents,
      projectRoot: ROOT,
      maxBytes: Buffer.byteLength(single.text, 'utf8'),
    })
    expect(kept.included).toBe(1)
    expect(kept.omitted).toBe(2)
    expect(kept.text).toMatch(/2 further convention files in these directories were too large/u)
  })
})
