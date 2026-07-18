import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate, type Step } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { writeLocalAt, renameLocal, rmLocal } from "../harness/mutations"
import { type SyncMode } from "../../src/types"
import type { VfsSpec } from "../fakes/virtual-fs"
import type { CloudSpec } from "../fakes/fake-cloud"

/**
 * Systemic IDEMPOTENCY sweep. The v3.0.50 field reports were dominated by a re-upload LOOP — "a folder that
 * never changes is uploaded continuously; as soon as it finishes it starts again". A cycle that transfers
 * anything for an UNCHANGED tree is the signature of that whole bug family, and no single existing scenario
 * pins it across shapes. This runs each representative shape to convergence, then two MORE no-mutation cycles,
 * and asserts BOTH are complete no-ops (`allOps` empty — file transfers AND dir create/delete/rename). A
 * settled tree must never move again. add-only.
 */
type SweepCase = {
	name: string
	mode?: SyncMode
	caseInsensitive?: boolean
	initialLocal?: VfsSpec
	initialRemote?: CloudSpec
	// Mutations to apply before settling (each followed by a runCycle by the driver).
	mutate?: Step[]
}

const CASES: SweepCase[] = [
	{
		name: "fresh two-way sync of a nested tree",
		initialLocal: {
			"/local/a.txt": { content: "a", mtimeMs: BASE_TIME },
			"/local/dir/b.txt": { content: "bb", mtimeMs: BASE_TIME },
			"/local/dir/deep/c.txt": { content: "ccc", mtimeMs: BASE_TIME }
		}
	},
	{
		name: "after a local modify (size + mtime change)",
		initialLocal: { "/local/f.txt": { content: "one", mtimeMs: BASE_TIME } },
		mutate: [localMutate(w => writeLocalAt(w, "f.txt", "one-longer", BASE_TIME + 5000))]
	},
	{
		name: "after a local file rename",
		initialLocal: { "/local/old.txt": { content: "x", mtimeMs: BASE_TIME } },
		mutate: [localMutate(w => renameLocal(w, "old.txt", "new.txt"))]
	},
	{
		name: "after a local directory rename with a child",
		initialLocal: { "/local/docs/note.txt": { content: "n", mtimeMs: BASE_TIME } },
		mutate: [localMutate(w => renameLocal(w, "docs", "Documents"))]
	},
	{
		name: "after a local delete",
		initialLocal: {
			"/local/keep.txt": { content: "k", mtimeMs: BASE_TIME },
			"/local/gone.txt": { content: "g", mtimeMs: BASE_TIME }
		},
		mutate: [localMutate(w => rmLocal(w, "gone.txt"))]
	},
	{
		name: "after a remote-side edit is pulled",
		initialLocal: { "/local/r.txt": { content: "v1", mtimeMs: BASE_TIME } },
		mutate: [remoteMutate(w => w.cloud.controls.updateFile("/r.txt", "v2-remote"))]
	},
	{
		name: "case divergence between disk and cloud (the reported loop)",
		initialLocal: { "/local/report.txt": { content: "same", mtimeMs: BASE_TIME } },
		initialRemote: { "/Report.txt": { content: "same", mtimeMs: BASE_TIME } }
	},
	{
		name: "case divergence on a case-insensitive volume",
		caseInsensitive: true,
		initialLocal: { "/local/photos/pic.jpg": { content: "img", mtimeMs: BASE_TIME } },
		initialRemote: { "/Photos/pic.jpg": { content: "img", mtimeMs: BASE_TIME } }
	}
]

describe("Idempotency sweep — a settled tree never transfers again", () => {
	for (const testCase of CASES) {
		it(`IDEM: ${testCase.name}`, async () => {
			const mutateSteps = (testCase.mutate ?? []).flatMap(step => [step, runCycle()])

			const result = await runScenario({
				name: `idem-${testCase.name}`,
				mode: testCase.mode ?? "twoWay",
				...(testCase.caseInsensitive !== undefined ? { caseInsensitive: testCase.caseInsensitive } : {}),
				...(testCase.initialLocal !== undefined ? { initialLocal: testCase.initialLocal } : {}),
				...(testCase.initialRemote !== undefined ? { initialRemote: testCase.initialRemote } : {}),
				steps: [
					runCycle(), // initial sync
					...mutateSteps, // apply the mutation(s), settling each
					runCycle(), // let everything converge
					runCycle(), // idempotency probe #1 — must be a no-op
					runCycle() // idempotency probe #2 — must be a no-op
				]
			})

			const probes = result.cycles.slice(-2)

			for (const [index, cycle] of probes.entries()) {
				expect(allOps(cycle.messages), `settled probe cycle #${index + 1} was not a no-op`).toEqual([])
			}
		})
	}
})
