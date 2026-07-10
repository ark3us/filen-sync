import { describe, it, expect } from "vitest"
import { createWorld, type World } from "../harness/world"
import { type SyncDirTreeFetcher } from "../../src/lib/filesystems/dirTree"
import { caseCollisionIncumbentWins } from "../../src/utils"
import { computeLocalCaseWinners } from "../../src/lib/filesystems/local"

/**
 * Regression tests for deterministic case-insensitive collision resolution in the remote AND local tree walks.
 *
 * Filen is case-insensitive (one lowercased name per parent), but because names are end-to-end encrypted the server
 * cannot enforce it — so a listing can legitimately contain two entries whose names differ only in case (e.g. "Foo"
 * and "foo"), or a file and a directory with the same lowercased name. The dedup used to be first-occurrence-wins,
 * and "first" was decided by ORDER that varies between runs: the /v3/dir/tree response is unordered and files are
 * decrypted in concurrent batches (remote); the filesystem walk order is FS-defined and entries are stat'd in
 * concurrent batches (local). A flipped winner makes the tree oscillate between runs, which on a case-insensitive
 * local FS drives an endless delete+re-download / rename loop.
 *
 * The fix makes the surviving variant deterministic (a directory outranks a same-name file, else the case-sensitively
 * smaller path wins), so repeated builds of the same listing — in any order — yield an identical tree. These tests
 * assert that order-independence; on the old code the shuffled cases pick different winners (RED).
 */

type Folder = [string, string, string]
type File = [string, string, string, number, string, string, number, number]

function folderMeta(name: string): string {
	return JSON.stringify({ name })
}

function fileMeta(name: string): string {
	return JSON.stringify({ name, size: 10, mime: "text/plain", key: "k", lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 })
}

function fileTuple(uuid: string, parent: string, name: string): File {
	return [uuid, "bucket", "region", 1, parent, fileMeta(name), 2, 1_700_000_000_000]
}

function inject(world: World, folders: Folder[], files: File[]): void {
	const fetcher: SyncDirTreeFetcher = async () => ({ files, folders, raw: "" }) as unknown as Awaited<ReturnType<SyncDirTreeFetcher>>

	world.sync.environment.fetchDirTree = fetcher
}

// Every permutation of a small array — used to assert the built tree is identical no matter the response order.
function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) {
		return [items.slice()]
	}

	const result: T[][] = []

	for (let i = 0; i < items.length; i++) {
		const rest = [...items.slice(0, i), ...items.slice(i + 1)]

		for (const perm of permutations(rest)) {
			result.push([items[i]!, ...perm])
		}
	}

	return result
}

describe("caseCollisionIncumbentWins", () => {
	it("a directory outranks a same-name file regardless of path", () => {
		// A directory incumbent keeps the slot against a file candidate...
		expect(caseCollisionIncumbentWins({ path: "/foo", isDirectory: true }, "/FOO", false)).toBe(true)
		// ...and a file incumbent yields to a directory candidate.
		expect(caseCollisionIncumbentWins({ path: "/foo", isDirectory: false }, "/FOO", true)).toBe(false)
	})

	it("for the same type, the case-sensitively smaller path wins", () => {
		expect(caseCollisionIncumbentWins({ path: "/Foo", isDirectory: false }, "/foo", false)).toBe(true) // "/Foo" < "/foo"
		expect(caseCollisionIncumbentWins({ path: "/foo", isDirectory: false }, "/Foo", false)).toBe(false) // "/foo" > "/Foo"
		expect(caseCollisionIncumbentWins({ path: "/Dir", isDirectory: true }, "/dir", true)).toBe(true) // "/Dir" < "/dir"
	})

	it("an exact-duplicate path keeps the incumbent (never replaces itself)", () => {
		expect(caseCollisionIncumbentWins({ path: "/a", isDirectory: false }, "/a", false)).toBe(true)
		expect(caseCollisionIncumbentWins({ path: "/a", isDirectory: true }, "/a", true)).toBe(true)
	})
})

describe("computeLocalCaseWinners — order-independent", () => {
	it("picks the same winner regardless of entry order (two files)", () => {
		for (const order of [["Foo.txt", "foo.txt"], ["foo.txt", "Foo.txt"]]) {
			const winners = computeLocalCaseWinners(order)

			expect(winners.has("Foo.txt")).toBe(true)
			expect(winners.has("foo.txt")).toBe(false)
		}
	})

	it("a directory beats a same-name file regardless of order (markDirectories trailing slash)", () => {
		for (const order of [["data/", "DATA"], ["DATA", "data/"]]) {
			const winners = computeLocalCaseWinners(order)

			expect(winners.has("data/")).toBe(true)
			expect(winners.has("DATA")).toBe(false)
		}
	})

	it("resolves a 3-way collision to the same winner for every permutation", () => {
		for (const perm of permutations(["Aaa", "aaa", "AAA"])) {
			const winners = computeLocalCaseWinners(perm)

			expect(winners.has("AAA")).toBe(true) // "AAA" < "Aaa" < "aaa"
			expect(winners.has("Aaa")).toBe(false)
			expect(winners.has("aaa")).toBe(false)
		}
	})

	it("keeps distinct (non-colliding) entries and skips null / empty entries", () => {
		const winners = computeLocalCaseWinners(["a.txt", null, "", "b/", "sub/c.txt"])

		expect(winners.has("a.txt")).toBe(true)
		expect(winners.has("b/")).toBe(true)
		expect(winners.has("sub/c.txt")).toBe(true)
		expect(winners.size).toBe(3)
	})
})

describe("RemoteFileSystem.getDirectoryTree — deterministic case-collision winner", () => {
	// A fixed sync-root uuid: the tree build only needs SOME folder with parent "base" (and every item to reference it),
	// so the injected response is self-consistent without depending on the fake cloud's generated root uuid.
	const ROOT = "root-uuid"
	const baseFolder: Folder = [ROOT, folderMeta("Sync"), "base"]

	async function buildTree(folders: Folder[], files: File[]) {
		const world = await createWorld({ mode: "twoWay" })

		inject(world, folders, files)

		return await world.sync.remoteFileSystem.getDirectoryTree(true)
	}

	it("keeps the case-sensitively smaller variant no matter the response order (two files)", async () => {
		const foo = fileTuple("uuid-Foo", ROOT, "Foo.txt")
		const foo2 = fileTuple("uuid-foo", ROOT, "foo.txt")

		for (const files of permutations([foo, foo2])) {
			const result = await buildTree([baseFolder], files)

			expect(result.result.tree["/Foo.txt"]).toMatchObject({ type: "file", path: "/Foo.txt", uuid: "uuid-Foo" })
			expect(result.result.tree["/foo.txt"]).toBeUndefined()
			expect(result.result.uuids["uuid-Foo"]).toMatchObject({ path: "/Foo.txt" })
			expect(result.result.uuids["uuid-foo"]).toBeUndefined() // the loser is demoted from uuids too
			expect(result.result.size).toBe(1)
			expect(result.ignored.some(entry => entry.relativePath === "/foo.txt" && entry.reason === "duplicate")).toBe(true)
		}
	})

	it("keeps the case-sensitively smaller variant for colliding directories (in any order)", async () => {
		const docs: Folder = ["uuid-Docs", folderMeta("Docs"), ROOT]
		const docs2: Folder = ["uuid-docs", folderMeta("docs"), ROOT]

		for (const dirs of permutations([docs, docs2])) {
			const result = await buildTree([baseFolder, ...dirs], [])

			expect(result.result.tree["/Docs"]).toMatchObject({ type: "directory", path: "/Docs", uuid: "uuid-Docs" })
			expect(result.result.tree["/docs"]).toBeUndefined()
			expect(result.result.uuids["uuid-docs"]).toBeUndefined() // loser demoted from uuids
			expect(result.result.size).toBe(1)
		}
	})

	it("a directory beats a same-name file (file + dir collision)", async () => {
		const result = await buildTree([baseFolder, ["uuid-D", folderMeta("Data"), ROOT]], [fileTuple("uuid-d", ROOT, "data")])

		expect(result.result.tree["/Data"]).toMatchObject({ type: "directory", path: "/Data" })
		expect(result.result.tree["/data"]).toBeUndefined()
		expect(result.result.size).toBe(1)
		expect(result.ignored.some(entry => entry.relativePath === "/data" && entry.reason === "duplicate")).toBe(true)
	})

	it("builds a byte-identical tree for every permutation of a colliding response", async () => {
		const files = [fileTuple("uuid-A", ROOT, "Report.txt"), fileTuple("uuid-B", ROOT, "report.txt"), fileTuple("uuid-C", ROOT, "notes.txt")]

		const trees = await Promise.all(permutations(files).map(perm => buildTree([baseFolder], perm).then(result => result.result.tree)))

		for (const tree of trees) {
			expect(tree).toEqual(trees[0])
		}
	})
})

describe("LocalFileSystem.getDirectoryTree — deterministic case-collision winner", () => {
	it("keeps the case-sensitively smaller variant (two files)", async () => {
		const world = await createWorld({
			mode: "twoWay",
			initialLocal: { "/local/Foo.txt": "a", "/local/foo.txt": "b" }
		})

		const result = await world.sync.localFileSystem.getDirectoryTree()

		expect(result.result.tree["/Foo.txt"]).toMatchObject({ type: "file", path: "/Foo.txt" })
		expect(result.result.tree["/foo.txt"]).toBeUndefined()
		expect(result.ignored.some(entry => entry.relativePath === "/foo.txt" && entry.reason === "duplicate")).toBe(true)
	})

	it("a directory beats a same-name file", async () => {
		const world = await createWorld({
			mode: "twoWay",
			initialLocal: { "/local/Data/keep.txt": "x", "/local/data": "y" }
		})

		const result = await world.sync.localFileSystem.getDirectoryTree()

		expect(result.result.tree["/Data"]).toMatchObject({ type: "directory", path: "/Data" })
		expect(result.result.tree["/data"]).toBeUndefined()
		expect(result.ignored.some(entry => entry.relativePath === "/data" && entry.reason === "duplicate")).toBe(true)
	})
})
