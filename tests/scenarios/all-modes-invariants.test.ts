import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { type SyncMode } from "../../src/types"
import type { VfsSpec } from "../fakes/virtual-fs"
import type { CloudSpec } from "../fakes/fake-cloud"

/**
 * The v3.0.50 bug CLASSES — endless re-upload, silent no-sync of deep paths, case divergence — must be pinned
 * in EVERY sync mode, not just twoWay. The reports themselves span modes: "local backup, 150 GB missing" is
 * localBackup/localToCloud; the re-upload loops were twoWay. The core per-mode reconciliation semantics are
 * already covered (u/v/w/x-mode-*, the directional matrices); this adds the NEW invariant dimensions across
 * all five modes: IDEMPOTENCE (a converged tree never re-transfers), DEEP-PATH REACH (a deep/long path
 * created on a mode's source side reaches its target, never silently dropped), and CASE-DIVERGENCE STABILITY
 * (a case-only difference settles, never loops). add-only.
 */
type ModeSpec = { mode: SyncMode; sourceIsLocal: boolean }

// For the push modes the local side is the source of new data; for the pull modes the cloud is. twoWay is
// exercised in the push direction here (its pull direction is covered by w-/x-mode + the twoWay suites).
const MODES: ModeSpec[] = [
	{ mode: "twoWay", sourceIsLocal: true },
	{ mode: "localToCloud", sourceIsLocal: true },
	{ mode: "localBackup", sourceIsLocal: true },
	{ mode: "cloudToLocal", sourceIsLocal: false },
	{ mode: "cloudBackup", sourceIsLocal: false }
]

const DEEP = `${Array.from({ length: 35 }, (_, i) => `deepsegment${String(i).padStart(2, "0")}`).join("/")}/leaf.txt`

describe("All-mode invariants — idempotence, deep-path reach, case stability across every mode", () => {
	for (const { mode, sourceIsLocal } of MODES) {
		it(`[${mode}] an already-converged tree settles and never re-transfers`, async () => {
			// Seed the SAME small tree, in-sync on both sides. Whatever one-time reconciliation a mirror mode
			// does against the empty base, it must reach a fixed point — no endless per-cycle transfers.
			const content = { content: "same", mtimeMs: BASE_TIME }
			const initialLocal: VfsSpec = { "/local/a.txt": content, "/local/dir/b.txt": content }
			const initialRemote: CloudSpec = { "/a.txt": content, "/dir/b.txt": content }

			const result = await runScenario({
				name: `allmodes-idem-${mode}`,
				mode,
				initialLocal,
				initialRemote,
				steps: [runCycle(), runCycle(), runCycle(), runCycle()]
			})

			for (const cycle of result.cycles.slice(-2)) {
				expect(allOps(cycle.messages), `[${mode}] a converged tree kept transferring`).toEqual([])
			}
		})

		it(`[${mode}] a deep/long path created on the source side reaches the target (not silently dropped)`, async () => {
			const spec = { content: "deep-content", mtimeMs: BASE_TIME }
			const result = await runScenario({
				name: `allmodes-deep-${mode}`,
				mode,
				...(sourceIsLocal ? { initialLocal: { [`/local/${DEEP}`]: spec } } : { initialRemote: { [`/${DEEP}`]: spec } }),
				steps: [runCycle(), runCycle(), runCycle()]
			})

			// The target side received it — the deep path was not dropped by the length pre-filter.
			const target = sourceIsLocal ? result.finalRemote : result.finalLocal

			expect(target[`/${DEEP}`], `[${mode}] deep path did not reach the target`).toMatchObject({ type: "file" })
			// …and settled.
			for (const cycle of result.cycles.slice(-1)) {
				expect(allOps(cycle.messages), `[${mode}] deep-path sync did not settle`).toEqual([])
			}
		})

		it(`[${mode}] a case-only divergence between disk and cloud converges and settles (no loop)`, async () => {
			const content = { content: "same-bytes", mtimeMs: BASE_TIME }
			const result = await runScenario({
				name: `allmodes-case-${mode}`,
				mode,
				initialLocal: { "/local/report.txt": content }, // lowercase on disk
				initialRemote: { "/Report.txt": content }, // capital in the cloud
				steps: [runCycle(), runCycle(), runCycle(), runCycle()]
			})

			for (const cycle of result.cycles.slice(-2)) {
				expect(allOps(cycle.messages), `[${mode}] a case divergence kept churning`).toEqual([])
			}
		})
	}
})
