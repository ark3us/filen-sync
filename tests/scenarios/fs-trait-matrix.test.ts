import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, type Step } from "../harness/runner"
import { BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { writeLocalAt, renameLocal, rmLocal } from "../harness/mutations"

/**
 * Real-fs TRAIT MATRIX. The entire mocked suite runs on memfs — posix, case-sensitive, unique/stable inodes,
 * integer-ms clocks. Every v3.0.50 field bug was Windows/SMB-only, i.e. a behavior memfs cannot produce, so a
 * memfs-only suite is structurally blind to that whole class. This runs a battery of representative sync
 * shapes under each faithful volume trait — SMB `ino: 0`, the lstat-vs-stat mtime skew, sub-ms fractional
 * mtimes, a case-insensitive volume, and their combination — and asserts the three invariants that the field
 * bugs violated: CONVERGENCE (local ≡ remote after settling), IDEMPOTENCE (a settled tree transfers nothing
 * more), and NO DATA LOSS (every file that went in is still present). add-only.
 */
type Trait = { name: string; world: Partial<CreateWorldOptions> }

const TRAITS: Trait[] = [
	{ name: "baseline (stable inodes, integer mtime)", world: {} },
	{ name: "SMB ino:0 (no stable inodes)", world: { inodeMode: "zero" } },
	{ name: "real-fs fractional mtime", world: { fractionalMtime: true } },
	{ name: "case-insensitive volume", world: { caseInsensitive: true } },
	{ name: "SMB combo (ino:0 + fractional mtime)", world: { inodeMode: "zero", fractionalMtime: true } }
]

type Shape = {
	name: string
	initialLocal: Record<string, { content: string; mtimeMs: number }>
	mutate?: (world: World) => unknown
	// The relative paths (no "/local") that must survive on both sides at the end.
	survivors: string[]
}

const SHAPES: Shape[] = [
	{
		name: "fresh nested tree",
		initialLocal: {
			"/local/a.txt": { content: "a", mtimeMs: BASE_TIME },
			"/local/dir/b.txt": { content: "bb", mtimeMs: BASE_TIME },
			"/local/dir/deep/c.txt": { content: "ccc", mtimeMs: BASE_TIME }
		},
		survivors: ["/a.txt", "/dir/b.txt", "/dir/deep/c.txt"]
	},
	{
		name: "modify a file",
		initialLocal: { "/local/f.txt": { content: "one", mtimeMs: BASE_TIME } },
		mutate: world => writeLocalAt(world, "f.txt", "one-longer-content", BASE_TIME + 10000),
		survivors: ["/f.txt"]
	},
	{
		name: "rename a directory with a child",
		initialLocal: { "/local/docs/note.txt": { content: "n", mtimeMs: BASE_TIME } },
		mutate: world => renameLocal(world, "docs", "Papers"),
		survivors: ["/Papers/note.txt"]
	},
	{
		name: "delete one of two files",
		initialLocal: {
			"/local/keep.txt": { content: "k", mtimeMs: BASE_TIME },
			"/local/gone.txt": { content: "g", mtimeMs: BASE_TIME }
		},
		mutate: world => rmLocal(world, "gone.txt"),
		survivors: ["/keep.txt"]
	}
]

describe("Real-fs trait matrix — convergence, idempotence, no data loss under SMB/real-fs traits", () => {
	for (const trait of TRAITS) {
		for (const shape of SHAPES) {
			it(`[${trait.name}] ${shape.name}`, async () => {
				const steps: Step[] = [runCycle()]

				if (shape.mutate) {
					steps.push(localMutate(shape.mutate), runCycle())
				}

				// Converge, then two idempotency probes.
				steps.push(runCycle(), runCycle())

				const result = await runScenario({
					name: `matrix-${trait.name}-${shape.name}`,
					mode: "twoWay",
					initialLocal: shape.initialLocal,
					...trait.world,
					steps
				})

				// CONVERGENCE: local ≡ remote.
				expect(result.finalLocal, "local and remote diverged").toEqual(result.finalRemote)

				// NO DATA LOSS: every expected survivor is present on both sides.
				for (const path of shape.survivors) {
					expect(result.finalRemote[path], `survivor ${path} missing on remote`).toMatchObject({ type: "file" })
					expect(result.finalLocal[path], `survivor ${path} missing on local`).toMatchObject({ type: "file" })
				}

				// IDEMPOTENCE: the last two cycles are complete no-ops.
				for (const cycle of result.cycles.slice(-2)) {
					expect(allOps(cycle.messages), "a settled cycle churned").toEqual([])
				}
			})
		}
	}
})
