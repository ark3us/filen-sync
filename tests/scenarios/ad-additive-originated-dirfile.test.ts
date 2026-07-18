import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control, localMutate } from "../harness/runner"
import { rmLocal, writeLocal } from "../harness/mutations"
import { allOps } from "../harness/snapshot"

/**
 * Fix #13 — an ORIGINATED dir→file type change must not recursively delete the backup side's directory in an
 * additive mode. localBackup replacing a local directory with a same-named file used to emit a recursive
 * deleteRemoteDirectory + markSubtreeAdded, which destroyed any FOREIGN child another device had added under
 * that directory (and even the synced children the additive mode keeps on a local deletion) — multi-device
 * data loss on a mode whose whole contract is "never delete the backup". Sibling of #6 (the opposite trigger:
 * there the FOREIGN side changed type; here the ORIGINATING side does). The fix tolerates the divergence: the
 * backup directory and all its children are kept, the new local file is simply not backed up. add-only.
 */
describe("Fix #13 — additive backup originated dir→file keeps foreign children", () => {
	it("AD1: localBackup, local dir→file, does NOT delete a concurrent foreign remote child", async () => {
		const result = await runScenario({
			name: "AD1",
			mode: "localBackup",
			initialLocal: { "/local/d/synced.txt": "s", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				runCycle(), // settle: remote backup holds /d (dir) + /d/synced.txt
				// Another device adds a child under /d on the remote, AND locally /d is replaced by a same-named file.
				control(world => {
					world.cloud.controls.addFile("/d/foreign.txt", "foreign-content")
				}),
				localMutate(world => {
					rmLocal(world, "d")
					writeLocal(world, "d", "now-a-file")
				}),
				runCycle(),
				runCycle()
			]
		})

		// The foreign child (and the synced child the additive mode keeps) survive on the backup — never
		// recursively deleted by the originated type change.
		expect(result.finalRemote["/d/foreign.txt"], "the foreign backup child was deleted").toMatchObject({ type: "file" })
		expect(result.finalRemote["/d/synced.txt"]).toMatchObject({ type: "file" })
		// The backup directory is preserved (not replaced by the local file); the sides simply diverge at /d.
		expect(result.finalRemote["/d"]).toMatchObject({ type: "directory" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		// The local file is untouched (no data loss locally).
		expect(result.finalLocal["/d"]).toMatchObject({ type: "file" })
		// Settles — no wedge.
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "did not settle").toEqual([])
	})
})
