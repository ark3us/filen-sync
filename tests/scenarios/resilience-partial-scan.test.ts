import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, allOps } from "../harness/snapshot"
import { makeErrnoError } from "../fakes/virtual-fs"

/**
 * Resilience — a PARTIAL local scan must never read as a mass remote deletion. FastGlob runs the local scan
 * with `suppressErrors:true`; a transient `EIO`/`EACCES` on one directory's `readdir` (routine on SMB/NFS)
 * silently omits that whole subtree from the scan. The remote side already carries the base forward on an
 * incomplete read (`decryptErrors>0`); the local side had no analog, so the omitted subtree read as deleted
 * and its cloud copies were trashed (the "files deleted / 150 GB missing" field class). The fix mirrors
 * `decryptErrors`: an incomplete scan re-asserts the absent base items so no deletion is emitted; it
 * self-heals on the next clean scan. add-only.
 */
function forceRescan(world: Parameters<Parameters<typeof control>[0]>[0]): void {
	// Roll the cache stale so the next cycle actually re-enumerates (and hits the injected readdir failure).
	world.sync.localFileSystem.getDirectoryTreeCache.timestamp = 0
	world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now()
}

describe("Resilience — partial local scan is not a mass deletion", () => {
	it("PS1: a transient readdir failure on a subtree does not delete its cloud copies (self-heals)", async () => {
		const result = await runScenario({
			name: "PS1",
			mode: "twoWay",
			initialLocal: {
				"/local/keep.txt": { content: "k", mtimeMs: BASE_TIME },
				"/local/photos/a.jpg": { content: "aaa", mtimeMs: BASE_TIME },
				"/local/photos/b.jpg": { content: "bbb", mtimeMs: BASE_TIME }
			},
			steps: [
				runCycle(), // sync everything up; base now holds photos/*
				// A transient enumeration failure on /photos (the share hiccups), then force a rescan.
				control(world => {
					world.vfs.controls.setGlobReaddirError("/local/photos", makeErrnoError("EIO", "readdir failed"))
					forceRescan(world)
				}),
				runCycle(), // the scan omits /photos/* — must NOT be read as a deletion
				// The share recovers.
				control(world => {
					world.vfs.controls.clearGlobReaddirError("/local/photos")
					forceRescan(world)
				}),
				runCycle(),
				runCycle()
			]
		})

		// The cloud copies of the un-enumerable subtree survive — no deletion was emitted.
		expect(result.finalRemote["/photos/a.jpg"], "cloud copy deleted by a partial scan").toMatchObject({ type: "file" })
		expect(result.finalRemote["/photos/b.jpg"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })

		// No delete op fired at any point.
		const everything = result.cycles.flatMap(c => transferKinds(c.messages))
		expect(everything.filter(op => op.startsWith("delete")), "a partial scan emitted deletions").toEqual([])

		// After recovery it converges and settles.
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "did not settle after recovery").toEqual([])
	})
})
