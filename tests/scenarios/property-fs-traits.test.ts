import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, type Step } from "../harness/runner"
import { BASE_TIME, type CreateWorldOptions } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { writeLocalAt, rmLocal } from "../harness/mutations"

/**
 * Property/fuzz sweep UNDER THE REAL-FS TRAITS. Category L already fuzzes well-behaved histories on the
 * default (posix, case-sensitive, stable-inode, integer-ms) memfs volume. Every v3.0.50 field bug was
 * Windows/SMB-only, so this re-runs seeded random histories on each faithful volume trait — SMB `ino: 0`,
 * fractional mtimes, and a case-insensitive volume (with a MIXED-CASE file pool) — asserting the same three
 * meta-invariants: CONVERGENCE (local ≡ remote), IDEMPOTENCE (a settled tree does no more work), and NO DATA
 * LOSS (surviving files present on both sides). Histories stay "well-behaved" (strictly increasing
 * whole-second mtimes, ≤1 touch per path per round, non-empty content, case-fold-DISTINCT names) so any
 * failure is a real bug, not a codified ambiguity. Every case is seeded → deterministic repro.
 */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = Math.imul(state ^ (state >>> 15), 1 | state)

		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type TraitVolume = { name: string; world: Partial<CreateWorldOptions>; pool: readonly string[] }

// A default (case-distinct) pool, and a MIXED-CASE pool for the case-insensitive volume whose entries fold to
// DISTINCT keys (so they never collide on a case-insensitive fs — each is a separate logical file).
const PLAIN_POOL = ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"] as const
const MIXED_CASE_POOL = ["Alpha.txt", "beta.txt", "Gamma.md", "delta.DAT", "Epsilon.log"] as const

const TRAITS: TraitVolume[] = [
	{ name: "SMB ino:0", world: { inodeMode: "zero" }, pool: PLAIN_POOL },
	{ name: "fractional mtime", world: { fractionalMtime: true }, pool: PLAIN_POOL },
	{ name: "case-insensitive volume (mixed-case names)", world: { caseInsensitive: true }, pool: MIXED_CASE_POOL }
]

const ROUNDS = 8
const MAX_MUTATIONS_PER_ROUND = 3
const SETTLE_CYCLES = 4

function buildHistory(seed: number, pool: readonly string[]): { steps: Step[]; survivors: Set<string> } {
	const random = mulberry32(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
	const steps: Step[] = []
	const exists = new Set<string>()
	let clock = BASE_TIME + 2000

	const seedName = pool[0]!
	const seedMtime = clock

	steps.push(localMutate(world => writeLocalAt(world, seedName, "seed", seedMtime)))
	exists.add(seedName)

	for (let round = 0; round < ROUNDS; round++) {
		const touched = new Set<string>()
		const mutations = 1 + Math.floor(random() * MAX_MUTATIONS_PER_ROUND)

		for (let m = 0; m < mutations; m++) {
			const path = pick(pool)

			if (touched.has(path)) {
				continue
			}

			touched.add(path)

			const side = random() < 0.5 ? "local" : "remote"
			const doDelete = exists.has(path) && random() < 0.35

			clock += 1000
			const mtime = clock
			const content = `s${seed}-r${round}-m${m}-${Math.floor(random() * 1_000_000)}`

			if (doDelete) {
				exists.delete(path)

				if (side === "local") {
					steps.push(localMutate(world => rmLocal(world, path)))
				} else {
					steps.push(remoteMutate(world => world.cloud.controls.trashPath(`/${path}`)))
				}
			} else {
				const isAdd = !exists.has(path)

				exists.add(path)

				if (side === "local") {
					steps.push(localMutate(world => writeLocalAt(world, path, content, mtime)))
				} else if (isAdd) {
					steps.push(remoteMutate(world => world.cloud.controls.addFile(`/${path}`, content, { mtimeMs: mtime })))
				} else {
					steps.push(remoteMutate(world => world.cloud.controls.updateFile(`/${path}`, content, { mtimeMs: mtime })))
				}
			}
		}

		steps.push(runCycle())
	}

	for (let cycle = 0; cycle < SETTLE_CYCLES; cycle++) {
		steps.push(runCycle())
	}

	return { steps, survivors: exists }
}

describe("Property sweep under real-fs traits (convergence, idempotence, no data loss)", () => {
	const SEEDS = 8

	for (const trait of TRAITS) {
		for (let i = 0; i < SEEDS; i++) {
			const seed = 0xa1c0 + i * 0x9e37

			it(`[${trait.name}] seed=${seed}: a random history converges, is idempotent, loses nothing`, async () => {
				const { steps, survivors } = buildHistory(seed, trait.pool)

				const result = await runScenario({
					name: `prop-${trait.name}-${seed}`,
					mode: "twoWay",
					...trait.world,
					steps
				})

				// CONVERGENCE + NO DATA LOSS (content-hash equality of the two sides).
				expect(result.finalLocal, `diverged (seed ${seed})`).toEqual(result.finalRemote)

				for (const path of survivors) {
					expect(result.finalRemote[`/${path}`], `lost survivor /${path} (seed ${seed})`).toBeDefined()
				}

				// IDEMPOTENCE: the trailing settle cycles do no work.
				for (const cycle of result.cycles.slice(-2)) {
					expect(allOps(cycle.messages), `settled churn (seed ${seed})`).toEqual([])
				}
			})
		}
	}
})
