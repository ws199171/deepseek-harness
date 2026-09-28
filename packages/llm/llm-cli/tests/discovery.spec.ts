import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { discoverCliModels, parseCodeBuddyModels } from '../src/discovery.ts'

/** One captured discovery spawn, with the listing its handle collects. */
interface Capture {
  specs: SubprocessSpawnSpec[]
  /** The signal the seam was handed, so the caller's cancellation is observable. */
  signals: AbortSignal[]
}

/** A handle that reports `outcome` and collects `listing` on stdout, when given one. */
function handle(outcome: SubprocessOutcome, listing?: string): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: listing === undefined ? {} : {
      stdout: { readFrom: () => ({ text: listing, nextOffset: listing.length, lossy: false }) },
    },
    done: Promise.resolve(outcome),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

/** A spawn stand-in recording every spec it is handed. */
function spawner(behavior: (spec: SubprocessSpawnSpec) => SubprocessHandle, capture: Capture = { specs: [], signals: [] }) {
  return {
    capture,
    spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
      capture.specs.push(spec)
      const signal = spec.signal
      if (signal !== undefined) capture.signals.push(signal)
      return behavior(spec)
    },
  }
}

/** One discovery run with the caller's fields over the standard bounds. */
function request(
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  extra: { configured?: readonly { id: string; name?: string }[]; signal?: AbortSignal } = {},
) {
  return discoverCliModels({
    argv: ['codebuddy', '--help'],
    cwd: '/work',
    timeoutMs: 15_000,
    configured: extra.configured ?? [],
    spawn,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  })
}

/** A CodeBuddy-shaped help listing, as its `--model` option documents it. */
const HELP = [
  'Usage: codebuddy [options] [prompt]',
  '',
  '  --model <model>   Model to use. Currently supported: (gpt-5.6-sol, custom-local:deepseek-v4-pro)',
  '  --print           Non-interactive',
].join('\n')

describe('parseCodeBuddyModels', () => {
  it('reads the ids from the listing the --model option documents', () => {
    expect(parseCodeBuddyModels(HELP)).toEqual([{ id: 'gpt-5.6-sol' }, { id: 'custom-local:deepseek-v4-pro' }])
  })

  it('returns nothing when the listing is absent or empty', () => {
    // No `--model` option at all: a different CLI, or one this parser cannot read.
    expect(parseCodeBuddyModels('Usage: other [options]')).toEqual([])
    expect(parseCodeBuddyModels('--model <model> Model. Currently supported: ()')).toEqual([])
    expect(parseCodeBuddyModels('')).toEqual([])
  })

  it('drops blank entries and repeats without reordering the survivors', () => {
    const help = '--model <model> Model. Currently supported: (b, , a, b,   )'
    expect(parseCodeBuddyModels(help)).toEqual([{ id: 'b' }, { id: 'a' }])
  })

  it('ignores a listing that precedes the --model option it belongs to', () => {
    // The pattern is anchored on the option: an unrelated "Currently supported"
    // earlier in the help must not become the catalog.
    expect(parseCodeBuddyModels('Currently supported: (wrong)\n--model <model> Model. Currently supported: (right)'))
      .toEqual([{ id: 'right' }])
  })
})

describe('discoverCliModels', () => {
  it('offers the discovered ids first and the configured ones the CLI did not report after', async () => {
    const spawn = spawner(() => handle({ exitCode: 0, signal: null }, HELP)).spawn

    expect(await request(spawn, { configured: [{ id: 'gpt-5.6-sol' }, { id: 'house-model', name: 'House Model' }] }))
      .toEqual([
        { id: 'gpt-5.6-sol' },
        { id: 'custom-local:deepseek-v4-pro' },
        // Configured but unreported: still offered, and named as declared.
        { id: 'house-model', name: 'House Model' },
      ])
  })

  it('reports each id once when a configured entry repeats a discovered one', async () => {
    const spawn = spawner(() => handle({ exitCode: 0, signal: null }, HELP)).spawn

    // The discovered id wins, so the configured name does not rename the CLI's
    // own catalog entry.
    expect(await request(spawn, { configured: [{ id: 'gpt-5.6-sol', name: 'Renamed' }] }))
      .toEqual([{ id: 'gpt-5.6-sol' }, { id: 'custom-local:deepseek-v4-pro' }])
  })

  it('falls back to the configured catalog when the listing child reports a failure', async () => {
    const spawn = spawner(() => handle({ exitCode: 2, signal: null }, HELP)).spawn

    expect(await request(spawn, { configured: [{ id: 'house-model' }] })).toEqual([{ id: 'house-model' }])
  })

  it('falls back to the configured catalog when the child collected no stdout', async () => {
    const spawn = spawner(() => handle({ exitCode: 0, signal: null })).spawn

    expect(await request(spawn, { configured: [{ id: 'house-model' }] })).toEqual([{ id: 'house-model' }])
  })

  it('treats an unstartable executable as "nothing discovered" rather than a failure', async () => {
    // A deployment that configures a catalog but has no CLI on PATH must still
    // mount: the route's own catalog is the answer.
    const spawn = (): SubprocessHandle => { throw new Error('ENOENT: codebuddy not found') }

    expect(await request(spawn, { configured: [{ id: 'house-model' }] })).toEqual([{ id: 'house-model' }])
    expect(await request(spawn)).toEqual([])
  })

  it('asks the seam once, in bounded collect mode, for the configured listing command', async () => {
    const { spawn, capture } = spawner(() => handle({ exitCode: 0, signal: null }, HELP))

    await request(spawn)

    expect(capture.specs).toHaveLength(1)
    expect(capture.specs[0]).toMatchObject({
      argv: ['codebuddy', '--help'],
      cwd: '/work',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: 'inherit' },
      // The listing child is bounded by the same deadline the caller set.
      graceMs: 15_000,
    })
  })

  it('cancels its own child when the caller aborts mid-run', async () => {
    const controller = new AbortController()
    const settled = Promise.withResolvers<SubprocessOutcome>()
    const { spawn, capture } = spawner(() => ({
      ...handle({ exitCode: 0, signal: null }, HELP),
      done: settled.promise,
    }))

    const probe = request(spawn, { signal: controller.signal })
    // The run is suspended on the child's outcome, so its signal is live.
    expect(capture.signals[0]?.aborted).toBe(false)
    controller.abort()
    // Discovery owns the deadline; the caller's cancellation reaches the seam
    // through the signal it handed it, which is what terminates the child.
    expect(capture.signals[0]?.aborted).toBe(true)

    settled.resolve({ exitCode: 0, signal: null })
    await expect(probe).resolves.toEqual([{ id: 'gpt-5.6-sol' }, { id: 'custom-local:deepseek-v4-pro' }])
  })

  it('detaches from the caller signal once the run settles', async () => {
    const controller = new AbortController()
    const { spawn, capture } = spawner(() => handle({ exitCode: 0, signal: null }, HELP))

    await request(spawn, { signal: controller.signal })
    controller.abort()

    // The settle path removed the forwarding listener, so a later cancellation
    // cannot reach a child that is already gone, and repeated discovery runs
    // cannot accumulate one listener per caller signal.
    expect(capture.signals[0]?.aborted).toBe(false)
  })
})
