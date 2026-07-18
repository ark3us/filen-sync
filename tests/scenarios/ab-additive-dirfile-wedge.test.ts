import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control, localMutate } from "../harness/runner"
import { rmLocal, writeLocal } from "../harness/mutations"
import { allOps } from "../harness/snapshot"
import type { SyncMessage } from "../../src/types"

/**
 * Fix #6 — an additive backup must not WEDGE when the destination side is foreign-replaced dir→file. The
 * additive modes deliberately TOLERATE a foreign type change on the side they promise never to delete
 * (localBackup never deletes the remote; cloudBackup never deletes the local). But the addition pass then
 * tried to write the source's children UNDER that foreign FILE — the backend/fs cannot place a child under a
 * file, so the task errored EVERY cycle and the pair stalled until manual intervention.
 *
 * (The mocked suite was FALSE-GREEN here: the fake cloud accepted an upload under a file parent. The fake now
 * rejects it exactly as the backend does, so the wedge reproduces.)
 *
 * The fix suppresses the addition when an existing ancestor on the destination side is a file this cycle won't
 * replace; the subtree simply stays un-synced (diverged) until the foreign file is removed — no wedge, and the
 * additive "never delete the foreign side" contract is preserved. add-only.
 */
function taskErrorCount(messages: SyncMessage[]): number {
	return messages.filter(m => m.type === "taskErrors").reduce((sum, m) => sum + (m.data as { errors: unknown[] }).errors.length, 0)
}

describe("Fix #6 — additive backup dir→file replacement does not wedge", () => {
	it("AB1: localBackup — a foreign remote dir→file does not wedge the upload of the source's children", async () => {
		const result = await runScenario({
			name: "AB1",
			mode: "localBackup",
			initialLocal: { "/local/d/child.txt": "c", "/local/keep.txt": "k" },
			steps: [
				runCycle(),
				runCycle(), // settle: remote backup holds /d (dir) + /d/child.txt
				// A foreign client replaces the remote /d directory with a FILE of the same name.
				control(world => {
					world.cloud.controls.trashPath("/d")
					world.cloud.controls.addFile("/d", "foreign-file-content")
				}),
				runCycle(),
				runCycle()
			]
		})

		const postForeign = [result.cycles[2]!, result.cycles[3]!]

		// No wedge: neither cycle after the foreign change errors on a repeated upload-under-a-file.
		for (const cycle of postForeign) {
			expect(taskErrorCount(cycle.messages), "the pair wedged on a repeating task error").toBe(0)
		}

		// The foreign remote file is TOLERATED (additive backup never deletes the remote), and the local source
		// is untouched — no data loss, the sides simply diverge at /d until the foreign file is removed.
		expect(result.finalRemote["/d"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/d/child.txt"], "the local source was lost").toMatchObject({ type: "file" })
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })

		// And it SETTLES: the final cycle is a complete no-op.
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "the pair never settled").toEqual([])
	})

	it("AB2: cloudBackup — a foreign local dir→file does not wedge the download of the source's children", async () => {
		const result = await runScenario({
			name: "AB2",
			mode: "cloudBackup",
			initialRemote: { "/d/child.txt": "c", "/keep.txt": "k" },
			steps: [
				runCycle(),
				runCycle(), // settle: local backup holds /d (dir) + /d/child.txt
				// A foreign local process replaces the local /d directory with a FILE of the same name.
				localMutate(world => {
					rmLocal(world, "d")
					writeLocal(world, "d", "foreign-file-content")
				}),
				runCycle(),
				runCycle()
			]
		})

		const postForeign = [result.cycles[2]!, result.cycles[3]!]

		for (const cycle of postForeign) {
			expect(taskErrorCount(cycle.messages), "the pair wedged on a repeating task error").toBe(0)
		}

		// The foreign local file is TOLERATED (additive backup never deletes the local), and the remote source
		// is untouched.
		expect(result.finalLocal["/d"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/d/child.txt"], "the remote source was lost").toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })

		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "the pair never settled").toEqual([])
	})
})
