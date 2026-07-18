import { describe, it, expect } from "vitest"
import { localRenameCorroborated } from "../../src/lib/deltas"
import { type LocalItem, type LocalTree } from "../../src/lib/filesystems/local"
import { type SyncMode } from "../../src/types"

/**
 * Fix #5 (unit) — the exact truth table of the local inode-reuse rename guard. A matching inode across a path
 * change is only a genuine rename when corroborated; on a birthtime-0 volume (creation===0) the additive
 * backup mode must NOT degrade to inode-only (a phantom file rename destroys the kept backup), while mirror
 * modes may (a phantom rename self-heals). NEW FILE.
 */
function file(path: string, creation: number, inode = 10): LocalItem {
	return { type: "file", path, creation, inode, size: 1, lastModified: 1_700_000_000_000 }
}

function dir(path: string, creation: number, inode = 20): LocalItem {
	return { type: "directory", path, creation, inode, size: 0, lastModified: 1_700_000_000_000 }
}

function tree(...items: LocalItem[]): LocalTree {
	const t: LocalTree = { tree: {}, inodes: {}, size: 0 }

	for (const item of items) {
		t.tree[item.path] = item
		t.inodes[item.inode] = item
		t.size += 1
	}

	return t
}

const EMPTY = tree()
const MIRROR: SyncMode[] = ["twoWay", "localToCloud"]

describe("localRenameCorroborated — inode-reuse rename truth table", () => {
	it("a reliable (both non-zero, equal) birthtime is a rename in EVERY mode", () => {
		for (const mode of ["twoWay", "localToCloud", "localBackup"] as SyncMode[]) {
			const current = file("/new.txt", 1000)
			const previous = file("/old.txt", 1000)

			expect(localRenameCorroborated(mode, current, previous, EMPTY, EMPTY), mode).toBe(true)
		}
	})

	it("differing non-zero birthtimes (inode reuse on a normal volume) is NOT a file rename in any mode", () => {
		for (const mode of ["twoWay", "localToCloud", "localBackup"] as SyncMode[]) {
			const current = file("/new.txt", 2000)
			const previous = file("/old.txt", 1000)

			expect(localRenameCorroborated(mode, current, previous, EMPTY, EMPTY), mode).toBe(false)
		}
	})

	it("birthtime-0 file: mirror modes degrade to inode-only (rename), localBackup does NOT (no rename)", () => {
		const current = file("/new.txt", 0)
		const previous = file("/old.txt", 0)

		for (const mode of MIRROR) {
			expect(localRenameCorroborated(mode, current, previous, EMPTY, EMPTY), mode).toBe(true)
		}

		expect(localRenameCorroborated("localBackup", current, previous, EMPTY, EMPTY)).toBe(false)
	})

	it("birthtime-0 on only ONE side still degrades for mirror modes but not localBackup", () => {
		const current = file("/new.txt", 0)
		const previous = file("/old.txt", 1500)

		expect(localRenameCorroborated("twoWay", current, previous, EMPTY, EMPTY)).toBe(true)
		expect(localRenameCorroborated("localBackup", current, previous, EMPTY, EMPTY)).toBe(false)
	})

	it("birthtime-0 DIRECTORY with a surviving child is a rename even in localBackup (identity corroboration)", () => {
		const currentDir = dir("/newdir", 0)
		const previousDir = dir("/olddir", 0)
		// A child inode that lived under /olddir now lives under /newdir → same directory moved.
		const currentTree = tree(currentDir, file("/newdir/child.txt", 0, 99))
		const previousTree = tree(previousDir, file("/olddir/child.txt", 0, 99))

		expect(localRenameCorroborated("localBackup", currentDir, previousDir, currentTree, previousTree)).toBe(true)
	})

	it("birthtime-0 DIRECTORY with NO surviving child (reused dir inode) is NOT a rename in localBackup", () => {
		const currentDir = dir("/newdir", 0)
		const previousDir = dir("/olddir", 0)
		// The "new" directory shares none of the old children — a reused inode, not a move.
		const currentTree = tree(currentDir, file("/newdir/fresh.txt", 0, 77))
		const previousTree = tree(previousDir, file("/olddir/gone.txt", 0, 88))

		expect(localRenameCorroborated("localBackup", currentDir, previousDir, currentTree, previousTree)).toBe(false)
	})
})
