import { describe, it, expect } from "vitest"
import { createWorld, type World } from "../harness/world"
import { type SyncDirTreeFetcher } from "../../src/lib/filesystems/dirTree"

/**
 * Fix #3 (unit) — the remote tree build must SURFACE a structural orphan (a decrypted item whose parent
 * folder tuple is absent from the /v3/dir/tree response) as `structuralErrors > 0`, so the cycle can treat
 * the read as incomplete and carry the base forward instead of deleting. The orphaned subtree legitimately
 * vanishes from the tree, but the count is what distinguishes "inconsistent response" from "deleted". The
 * end-to-end no-deletion behavior is proven in tests/scenarios/resilience-structural-orphan.test.ts. NEW FILE.
 */

type Folder = [string, string, string]
type File = [string, string, string, number, string, string, number, number]

function folderMeta(name: string): string {
	return JSON.stringify({ name })
}

function fileMeta(name: string): string {
	return JSON.stringify({ name, size: 10, mime: "text/plain", key: "k", lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 })
}

// A small tree: root / a / b / c.txt , plus root / x.txt (parent-first order).
function buildTuples(rootUUID: string): { folders: Folder[]; files: File[] } {
	const folders: Folder[] = [
		[rootUUID, folderMeta("Sync"), "base"],
		["uuid-a", folderMeta("a"), rootUUID],
		["uuid-b", folderMeta("b"), "uuid-a"]
	]
	const files: File[] = [
		["uuid-c", "bucket", "region", 1, "uuid-b", fileMeta("c.txt"), 2, 1_700_000_000_000],
		["uuid-x", "bucket", "region", 1, rootUUID, fileMeta("x.txt"), 2, 1_700_000_000_000]
	]

	return { folders, files }
}

function inject(world: World, folders: Folder[], files: File[]): void {
	world.sync.environment.fetchDirTree = (async () => ({ files, folders, raw: "" })) as unknown as SyncDirTreeFetcher
}

describe("RemoteFileSystem.getDirectoryTree — structural-orphan surfacing", () => {
	it("a well-formed response reports structuralErrors === 0 (the sync root is never miscounted)", async () => {
		const world = await createWorld({ mode: "twoWay" })
		const { folders, files } = buildTuples(world.cloud.controls.rootUUID)

		inject(world, folders, files)

		const result = await world.sync.remoteFileSystem.getDirectoryTree(true)

		expect(result.structuralErrors).toBe(0)
		expect(result.decryptErrors).toBe(0)
		expect(result.result.size).toBe(4)
	})

	it("omitting an intermediate folder tuple orphans its subtree and reports structuralErrors > 0", async () => {
		const world = await createWorld({ mode: "twoWay" })
		const { folders, files } = buildTuples(world.cloud.controls.rootUUID)

		// Drop folder "a" (root's child). Now "b"'s parent is absent → b orphaned; "c.txt"'s parent "b" never
		// resolves → c.txt orphaned. "x.txt" (child of root) is unaffected.
		const orphanedFolders = folders.filter(folder => folder[0] !== "uuid-a")

		inject(world, orphanedFolders, files)

		const result = await world.sync.remoteFileSystem.getDirectoryTree(true)

		// The whole a/ subtree vanished from the tree; only the sound part remains.
		expect(result.result.tree["/x.txt"]).toMatchObject({ type: "file" })
		expect(result.result.tree["/a"]).toBeUndefined()
		expect(result.result.tree["/a/b"]).toBeUndefined()
		expect(result.result.tree["/a/b/c.txt"]).toBeUndefined()
		expect(result.result.size).toBe(1)

		// ...but it is flagged as a STRUCTURAL orphan (b folder + c.txt file), not silently read as a deletion,
		// and NOT as a decrypt error (everything decrypted fine).
		expect(result.structuralErrors).toBeGreaterThan(0)
		expect(result.decryptErrors).toBe(0)
	})
})
