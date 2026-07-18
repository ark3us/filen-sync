import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control, localMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { writeLocalAt } from "../harness/mutations"
import { makeErrnoError } from "../fakes/virtual-fs"
import { type SyncDirTreeFetcher } from "../../src/lib/filesystems/dirTree"

/**
 * Fix #18 (regression guard — the code is already correct). Both incomplete-read carry-forwards re-assert an
 * absent base item ONLY when its path is NOT already occupied by a readable item this cycle
 * (`!current.tree[path]`). Without that clause the carry-forward would CLOBBER a path that a peer legitimately
 * re-created — reverting it to the stale base and silently dropping the peer's edit. These pin that clause on
 * both the remote (decryptErrors) and local (scanIncomplete) sides. add-only.
 */
describe("Fix #18 — incomplete-read carry-forward never clobbers a reused path", () => {
	it("IR1: a decrypt-error read does not revert /a.txt to the base when a peer re-created it (remote)", async () => {
		let realFetcher: SyncDirTreeFetcher | null = null

		const result = await runScenario({
			name: "IR1",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "v1", mtimeMs: BASE_TIME },
				"/local/keep.txt": { content: "k", mtimeMs: BASE_TIME }
			},
			steps: [
				runCycle(),
				runCycle(), // settle: base holds /a.txt (uuid U1) + /keep.txt
				control(world => {
					// A peer re-uploads /a.txt with NEW content — a new uuid U2.
					world.cloud.controls.updateFile("/a.txt", "v2-longer", { mtimeMs: BASE_TIME + 100_000 })

					// ...and an UNRELATED item hits a decrypt fault this read, so decryptErrors > 0 and the base
					// carry-forward runs. Its reused-path clause must NOT re-assert the base /a.txt (U1) over U2.
					realFetcher = world.sync.environment.fetchDirTree
					world.sync.environment.fetchDirTree = (async (sdk, request) => {
						const full = await realFetcher!(sdk, { ...request, skipCache: true })
						const files = full.files.map(file => {
							try {
								return (JSON.parse(file[5]) as { name?: string }).name === "keep.txt"
									? [...file.slice(0, 5), "MALFORMED-NOT-JSON", ...file.slice(6)]
									: file
							} catch {
								return file
							}
						})

						return { ...full, files }
					}) as SyncDirTreeFetcher
				}),
				runCycle(),
				runCycle(),
				// The read recovers.
				control(world => {
					world.sync.environment.fetchDirTree = realFetcher!
				}),
				runCycle(),
				runCycle()
			]
		})

		// /a.txt resolved to the peer's U2 bytes (downloaded), NOT clobbered back to the base U1/v1.
		expect(result.finalLocal["/a.txt"], "the peer's re-created /a.txt was reverted to the base").toMatchObject({
			type: "file",
			size: "v2-longer".length
		})
		// The decrypt-faulted item survived (carried forward), and the sides converge.
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("IR2: an incomplete scan does not revert a file the user just modified (local)", async () => {
		const result = await runScenario({
			name: "IR2",
			mode: "twoWay",
			initialLocal: {
				"/local/a.txt": { content: "v1", mtimeMs: BASE_TIME },
				"/local/photos/p.jpg": { content: "p", mtimeMs: BASE_TIME }
			},
			steps: [
				runCycle(),
				runCycle(), // settle: base holds /a.txt + /photos/p.jpg
				control(world => {
					// The /photos subtree fails to enumerate (scanIncomplete > 0), triggering the local
					// carry-forward — but /a.txt is present AND freshly modified this scan.
					world.vfs.controls.setGlobReaddirError("/local/photos", makeErrnoError("EIO", "readdir failed"))
					world.sync.localFileSystem.getDirectoryTreeCache.timestamp = 0
					world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now()
				}),
				localMutate(world => writeLocalAt(world, "a.txt", "v2-longer", BASE_TIME + 100_000)),
				runCycle(),
				runCycle(),
				control(world => {
					world.vfs.controls.clearGlobReaddirError("/local/photos")
					world.sync.localFileSystem.getDirectoryTreeCache.timestamp = 0
					world.sync.localFileSystem.lastDirectoryChangeTimestamp = Date.now()
				}),
				runCycle(),
				runCycle()
			]
		})

		// The modification survived — the carry-forward did NOT re-assert the base /a.txt over the new bytes...
		expect(result.finalRemote["/a.txt"], "the modification was reverted by the carry-forward").toMatchObject({
			type: "file",
			size: "v2-longer".length
		})
		// ...and the un-enumerable subtree was preserved (not deleted).
		expect(result.finalRemote["/photos/p.jpg"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
