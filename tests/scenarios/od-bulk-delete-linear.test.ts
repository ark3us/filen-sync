import { describe, it, expect } from "vitest"
import { createWorld } from "../harness/world"

/**
 * Fix #9 — deleting many files must be O(N), not O(N²). The live unlink cache-update ran an unconditional
 * whole-tree `for..in` scan to evict a directory's descendants — but it ran that scan for a FILE too, which
 * has none. Deleting a large flat folder therefore did N full-tree scans (one per file): O(N²), so the pair
 * appeared to hang for minutes on a project that targets 100k–1M files.
 *
 * The metric here is exact and deterministic: a Proxy counts `for..in` enumerations (ownKeys traps) of the
 * tree. `unlink` triggers one enumeration per DIRECTORY (to evict its subtree) and NONE for a file — so a run
 * of pure-file deletions must produce ZERO enumerations, and a directory delete must still produce one.
 * add-only.
 */
function installOwnKeysCounter(fs: { getDirectoryTreeCache: { tree: Record<string, unknown> } }): { count: () => number } {
	let ownKeys = 0
	const realTree = fs.getDirectoryTreeCache.tree

	fs.getDirectoryTreeCache.tree = new Proxy(realTree, {
		ownKeys(target) {
			ownKeys++

			return Reflect.ownKeys(target)
		}
	})

	return { count: () => ownKeys }
}

describe("Fix #9 — bulk file deletion is linear", () => {
	it("OD1: deleting N files does ZERO whole-tree scans (not one per file)", async () => {
		const N = 60
		const initialLocal: Record<string, string> = { "/local/keep/anchor.txt": "a" }

		for (let i = 0; i < N; i++) {
			initialLocal[`/local/flat/file-${i}.txt`] = `content-${i}`
		}

		const world = await createWorld({ mode: "twoWay", initialLocal })

		// Populate the live tree.
		await world.sync.runCycle()

		const counter = installOwnKeysCounter(world.sync.localFileSystem)

		// Delete every flat file directly through the live unlink (the exact call the deletion task makes).
		for (let i = 0; i < N; i++) {
			await world.sync.localFileSystem.unlink({ relativePath: `/flat/file-${i}.txt`, permanent: true })
		}

		// A file has no descendants, so NOT ONE of the N deletions may scan the whole tree.
		expect(counter.count(), "a per-file unlink scanned the whole tree (O(N²) bulk deletion)").toBe(0)

		// The files are actually gone from the tree.
		for (let i = 0; i < N; i++) {
			expect(world.sync.localFileSystem.getDirectoryTreeCache.tree[`/flat/file-${i}.txt`]).toBeUndefined()
		}
	})

	it("OD2: deleting a DIRECTORY still evicts its subtree (one scan) — the fix does not weaken it", async () => {
		const world = await createWorld({
			mode: "twoWay",
			initialLocal: {
				"/local/sub/a.txt": "a",
				"/local/sub/nested/b.txt": "b",
				"/local/keep.txt": "k"
			}
		})

		await world.sync.runCycle()

		const counter = installOwnKeysCounter(world.sync.localFileSystem)

		await world.sync.localFileSystem.unlink({ relativePath: "/sub", permanent: true })

		// Exactly one subtree scan for the directory.
		expect(counter.count()).toBe(1)

		// The whole subtree was evicted from the tree; the sibling survives.
		expect(world.sync.localFileSystem.getDirectoryTreeCache.tree["/sub"]).toBeUndefined()
		expect(world.sync.localFileSystem.getDirectoryTreeCache.tree["/sub/a.txt"]).toBeUndefined()
		expect(world.sync.localFileSystem.getDirectoryTreeCache.tree["/sub/nested/b.txt"]).toBeUndefined()
		expect(world.sync.localFileSystem.getDirectoryTreeCache.tree["/keep.txt"]).toMatchObject({ type: "file" })
	})

	it("OD3: the REMOTE unlink is linear too — deleting N remote files does ZERO whole-tree scans", async () => {
		const N = 60
		const initialLocal: Record<string, string> = { "/local/keep/anchor.txt": "a" }

		for (let i = 0; i < N; i++) {
			initialLocal[`/local/flat/file-${i}.txt`] = `content-${i}`
		}

		const world = await createWorld({ mode: "twoWay", initialLocal })

		// Sync up so the remote holds the files. The upload cycle RESETS the remote tree cache (didRemoteChanges),
		// so rebuild+populate it explicitly and only THEN install the counter — otherwise pathToItemUUID would
		// rebuild the tree on first unlink and discard the proxy. After this the cache timestamp is set, so the
		// unlinks reuse this exact tree object.
		await world.sync.runCycle()
		await world.sync.remoteFileSystem.getDirectoryTree()

		const counter = installOwnKeysCounter(world.sync.remoteFileSystem)

		for (let i = 0; i < N; i++) {
			await world.sync.remoteFileSystem.unlink({ relativePath: `/flat/file-${i}.txt`, type: "file", permanent: true })
		}

		expect(counter.count(), "a per-file remote unlink scanned the whole tree (O(N²))").toBe(0)

		for (let i = 0; i < N; i++) {
			expect(world.sync.remoteFileSystem.getDirectoryTreeCache.tree[`/flat/file-${i}.txt`]).toBeUndefined()
		}
	})
})
