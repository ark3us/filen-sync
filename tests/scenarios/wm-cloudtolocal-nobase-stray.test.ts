import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"

/**
 * Fix #12 — cloudToLocal is a STRICT mirror (local must equal remote), so a no-base local stray at a path the
 * remote also holds must be reverted to the remote's bytes even when the sizes MATCH. The revert was gated on
 * `localDiverged`, which needs a base; with no base + equal size it never fired (noBaseSizeDiverged only
 * catches a size difference, and remoteChanged needs the remote to be strictly newer) — so a same-size,
 * different-content, newer-mtime local stray survived forever, violating the mirror. This is now symmetric to
 * localToCloud, whose mirror revert already fires on no base. add-only.
 */
describe("Fix #12 — cloudToLocal reverts a no-base same-size local stray", () => {
	it("WM1: no base, same-size NEWER local stray → local overwritten with the remote bytes", async () => {
		const result = await runScenario({
			name: "WM1",
			mode: "cloudToLocal",
			// Same byte length (7) so noBaseSizeDiverged cannot fire; the local stray is NEWER so remoteChanged
			// (strictly-newer-remote) cannot fire either. Only the mirror revert can catch it.
			initialLocal: { "/local/f.txt": { content: "LOCALaa", mtimeMs: BASE_TIME + 100_000 } },
			initialRemote: { "/f.txt": { content: "REMOTbb", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle()]
		})

		// The mirror is enforced: local now carries the REMOTE bytes.
		expect(result.finalLocal["/f.txt"], "the local stray was not reverted to the remote copy").toMatchObject({
			type: "file",
			size: "REMOTbb".length
		})
		expect(result.finalLocal["/f.txt"]!.contentHash).toBe(result.finalRemote["/f.txt"]!.contentHash)
		// cloudToLocal never uploads — the remote is untouched.
		expect(result.finalRemote["/f.txt"]).toMatchObject({ type: "file", size: "REMOTbb".length })
		// Settles.
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "did not settle").toEqual([])
	})
})
