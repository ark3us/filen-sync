import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { runScenario, runCycle, remoteMutate } from "../harness/runner"
import { messagesOfType } from "../harness/snapshot"
import { createWorld, BASE_TIME, type World } from "../harness/world"

/**
 * Security regression — PATH TRAVERSAL via attacker-controlled remote names (F01-08).
 *
 * A shared folder can carry a name whose decrypted value contains `..` segments. The backend's end-to-end
 * encryption means names are only validated CLIENT-side, so a custom client can create a folder literally
 * named `..`; syncing it used to join the name onto the sync root (join collapses `..`) and download/move the
 * file OUTSIDE the root — overwriting arbitrary user files (e.g. ~/.bashrc → RCE on next shell launch).
 *
 * Two layers must hold: (1) the tree-build filter (`isPathIgnored`) refuses any `..` item up front (reason
 * "invalidPath"), so it never becomes a delta; (2) every local filesystem SINK re-validates the resolved path
 * strictly inside the root, so a stale pre-fix base entry or any filter gap can still never reach a write.
 * add-only.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
	vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
	vi.setSystemTime(BASE_TIME)

	try {
		await body(await createWorld({ mode: "twoWay", initialLocal: { "/local/legit.txt": "ok" } }))
	} finally {
		vi.useRealTimers()
	}
}

async function cycle(world: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	await world.sync.runCycle()
}

/** Keys the memfs volume holds OUTSIDE the sync root + db (i.e. a traversal escape wrote here). */
function escapedVfsKeys(world: World): string[] {
	return Object.keys(world.vfs.controls.toJSON()).filter(key => !key.startsWith("/local") && !key.startsWith("/db"))
}

describe("Security — path traversal via malicious remote names", () => {
	it("F01-08a: a malicious `..` remote folder/file is refused (invalidPath), nothing escapes the sync root", async () => {
		const result = await runScenario({
			name: "traversal-e2e",
			mode: "twoWay",
			initialLocal: { "/local/legit.txt": "ok" },
			steps: [
				runCycle(),
				remoteMutate(world => {
					// A custom client shares folders/files with `..` names at several depths.
					world.cloud.controls.addFile("/../evil.txt", "MALICIOUS-BASHRC")
					world.cloud.controls.addDir("/../evildir")
					world.cloud.controls.addFile("/../../etc/passwd", "root:x:0:0")
					world.cloud.controls.addFile("/sub/../../escape.txt", "escape")
				}),
				runCycle(),
				runCycle()
			]
		})

		// NOTHING was written outside the sync root.
		expect(escapedVfsKeys(result.world), "a traversal path escaped the sync root").toEqual([])

		// Every `..` item was refused by the tree-build filter as invalidPath (never became a delta).
		const ignoredReasons = new Set(
			messagesOfType(result.messages, "remoteTreeIgnored").flatMap(m => m.data.ignored.map(i => i.reason))
		)

		expect(ignoredReasons.has("invalidPath")).toBe(true)

		// The legit sibling synced normally and the cycle never wedged.
		expect(result.finalRemote["/legit.txt"]).toMatchObject({ type: "file" })
		expect(messagesOfType(result.messages, "taskErrors").reduce((n, m) => n + m.data.errors.length, 0)).toBe(0)

		// The malicious paths are absent from the engine's converged local tree.
		expect(result.finalLocal["/../evil.txt"]).toBeUndefined()
		expect(result.finalLocal["/evil.txt"]).toBeUndefined()
	})

	// Defense in depth: even if a `..` path bypassed the filter, each real filesystem SINK must refuse it. These
	// call the sinks directly with a traversal path and assert they throw rather than touch an out-of-root path.
	it("F01-08b: the DOWNLOAD sink refuses a traversal path", async () => {
		await withWorld(async world => {
			await expect(world.sync.remoteFileSystem.download({ relativePath: "/../evil.txt" })).rejects.toThrow(/traversal/i)
			expect(escapedVfsKeys(world)).toEqual([])
		})
	})

	it("F01-08c: the MKDIR (create-local-directory) sink refuses a traversal path", async () => {
		await withWorld(async world => {
			await expect(world.sync.localFileSystem.mkdir({ relativePath: "/../evildir" })).rejects.toThrow(/traversal/i)
			expect(escapedVfsKeys(world)).toEqual([])
		})
	})

	it("F01-08d: the RENAME/move sink refuses a traversal destination", async () => {
		await withWorld(async world => {
			// Sync legit.txt so it is in the local tree (the rename source must exist)…
			await cycle(world)
			// …then try to move it OUT of the root via a `..` destination.
			await expect(
				world.sync.localFileSystem.rename({ fromRelativePath: "/legit.txt", toRelativePath: "/../evil.txt" })
			).rejects.toThrow(/traversal/i)
			expect(escapedVfsKeys(world)).toEqual([])
			// The source is untouched (the failed move did not remove it).
			expect(world.vfs.ifs.existsSync("/local/legit.txt")).toBe(true)
		})
	})

	/**
	 * Regression (v3.0.50): the two containment checks must NOT reject legitimate children when the sync root is
	 * a filesystem MOUNT ROOT — a mapped-drive root (`Z:\`) or UNC share root (`\\NAS\share`), the common
	 * Synology-over-SMB shape whose `path.resolve()` already ends in a separator. The pre-fix lexical
	 * `startsWith(root + sep)` produced a doubled separator and refused EVERY item, so all files failed to sync.
	 * The memfs mount-root analog is `/` (its `resolve()` carries the trailing separator). Point the pair at it
	 * and assert both the tree-build filter and the throwing sink admit an ordinary in-root child.
	 */
	it("F01-08e: a MOUNT-ROOT sync pair still admits its own children (tree filter, not invalidPath)", async () => {
		await withWorld(async world => {
			// Re-root the pair at the memfs mount root — the doubled-separator trigger.
			world.sync.syncPair.localPath = "/"

			const child = world.sync.remoteFileSystem.isPathIgnored({
				absolutePath: "/photos/holiday.jpg",
				relativePath: "/photos/holiday.jpg",
				name: "holiday.jpg",
				type: "file"
			})

			expect(child.ignored, "a legitimate child of a mount-root pair was ignored").toBe(false)

			// A genuine `..` escape must still be refused (invalidPath) even at a mount root.
			const escape = world.sync.remoteFileSystem.isPathIgnored({
				absolutePath: "/../evil.txt",
				relativePath: "/../evil.txt",
				name: "..",
				type: "file"
			})

			expect(escape).toMatchObject({ ignored: true, reason: "invalidPath" })
		})
	})

	it("F01-08f: a real write sink (mkdir) admits an in-root path at a MOUNT-ROOT pair", async () => {
		await withWorld(async world => {
			// Re-root at the memfs mount root, then drive the actual mkdir sink (which calls the containment
			// guard internally). Pre-fix the doubled-separator check threw "path traversal" for every child, so
			// no directory could ever be created; post-fix the child is created normally.
			world.sync.syncPair.localPath = "/"

			await expect(world.sync.localFileSystem.mkdir({ relativePath: "/photos" })).resolves.toBeDefined()
			expect(world.vfs.ifs.existsSync("/photos")).toBe(true)
		})
	})
})
