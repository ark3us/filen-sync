import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control, type Step } from "../harness/runner"
import { writeLocalAt, rmLocal, renameLocal } from "../harness/mutations"
import { transferKinds } from "../harness/snapshot"
import { BASE_TIME } from "../harness/world"

const SECOND = 1000

/**
 * Fix #5 — inode-reuse must not become a phantom rename on a BIRTHTIME-0 volume. The F8 guard tells a genuine
 * rename from an ext4-style inode-reuse coincidence by the file's birthtime: a rename preserves it, a reused
 * inode belongs to a freshly-created file with a newer one. But SMB/CIFS/tmpfs/old-ext4 report `birthtimeMs: 0`
 * for EVERY entry, so the guard degraded to inode-only there — and in localBackup that phantom rename renames
 * the kept backup out from under the original name and destroys it: permanent, silent data loss. (Category ZD
 * proves the guard on memfs's default STABLE birthtimes; memfs never surfaces the 0 case, so this class went
 * uncaught — the audit's "Fake fs asserts birthtime>0, so this branch is unreachable in tests".)
 *
 * The fix: an ADDITIVE backup (localBackup) requires a RELIABLE (both non-zero, equal) birthtime for a FILE
 * rename, or surviving-child identity for a DIRECTORY rename; a birthtime-0 file "rename" is left to the
 * delete+add passes, which for an additive backup simply keep the old copy and upload the new one. Mirror
 * modes (twoWay/localToCloud) keep degrading to inode-only because a phantom rename there self-heals. add-only.
 */
function settle(): Step[] {
	return [runCycle(), runCycle()]
}

describe("Fix #5 — birthtime-0 inode reuse is never a phantom rename", () => {
	it("ZDB1: localBackup, birthtime-0 — a new file on a recycled inode does NOT delete the original backup", async () => {
		let reusedInode = 0

		const result = await runScenario({
			name: "ZDB1",
			mode: "localBackup",
			birthtimeMode: "zero",
			initialLocal: { "/local/report.pdf": "important-report", "/local/keep.txt": "k" },
			steps: [
				...settle(),
				// Capture report.pdf's inode, delete it (freeing the inode), create a brand-new unrelated file,
				// then force it onto report.pdf's freed inode — exactly what ext4 does. On a birthtime-0 volume
				// both files report creation:0, so the old guard degraded to inode-only and misread this as a rename.
				control(world => {
					reusedInode = world.vfs.controls.getInode("/local/report.pdf")!
				}),
				localMutate(world => rmLocal(world, "report.pdf")),
				localMutate(world => writeLocalAt(world, "malware.exe", "unrelated-bytes", BASE_TIME + 30 * SECOND)),
				control(world => world.vfs.controls.setInode("/local/malware.exe", reusedInode)),
				runCycle(),
				runCycle()
			]
		})

		const reuseCycle = result.cycles[2]!

		// The reuse must NOT be propagated as a rename of the remote original.
		expect(transferKinds(reuseCycle.messages), "birthtime-0 inode reuse became a phantom rename").not.toContain("renameRemoteFile")
		// localBackup keeps remote-only files: the original backup survives AND the genuinely-new file is added.
		expect(result.finalRemote["/report.pdf"], "the original backup was destroyed").toMatchObject({ type: "file", size: 16 })
		expect(result.finalRemote["/malware.exe"]).toMatchObject({ type: "file", size: 15 })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("ZDB2: localBackup, birthtime-0 — a genuine rename degrades to keep+add (no data loss, additive contract)", async () => {
		const result = await runScenario({
			name: "ZDB2",
			mode: "localBackup",
			birthtimeMode: "zero",
			initialLocal: { "/local/report.pdf": "the-report", "/local/keep.txt": "k" },
			steps: [
				...settle(),
				// A genuine rename. On a birthtime-0 volume it is INDISTINGUISHABLE from inode reuse, so the safe
				// resolution for an additive backup is keep+add: the old name's backup stays, the new name uploads.
				localMutate(world => renameLocal(world, "report.pdf", "report-final.pdf")),
				runCycle(),
				runCycle()
			]
		})

		const renameCycle = result.cycles[2]!

		// No phantom remote rename that would delete the kept backup.
		expect(transferKinds(renameCycle.messages)).not.toContain("renameRemoteFile")
		// Additive backup keeps BOTH: the original (never deleted from a backup) and the renamed copy.
		expect(result.finalRemote["/report.pdf"], "the backup was renamed away and lost").toMatchObject({ type: "file" })
		expect(result.finalRemote["/report-final.pdf"]).toMatchObject({ type: "file" })
	})

	it("ZDB3: twoWay, birthtime-0 — inode reuse still converges correctly (mirror modes self-heal)", async () => {
		let reusedInode = 0

		const result = await runScenario({
			name: "ZDB3",
			mode: "twoWay",
			birthtimeMode: "zero",
			initialLocal: { "/local/a.txt": "aaaa", "/local/keep.txt": "k" },
			steps: [
				...settle(),
				control(world => {
					reusedInode = world.vfs.controls.getInode("/local/a.txt")!
				}),
				localMutate(world => rmLocal(world, "a.txt")),
				localMutate(world => writeLocalAt(world, "c.txt", "cc", BASE_TIME + 30 * SECOND)),
				control(world => world.vfs.controls.setInode("/local/c.txt", reusedInode)),
				runCycle(),
				runCycle()
			]
		})

		// twoWay stays permissive on birthtime-0 (a phantom rename self-heals via F1), so the meaningful
		// guarantee is the END STATE: no data loss — the new file carries ITS OWN content, the old path is gone,
		// and both sides agree.
		expect(result.finalRemote["/a.txt"]).toBeUndefined()
		expect(result.finalRemote["/c.txt"]).toMatchObject({ type: "file", size: 2 })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
