import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fsExtra from "fs-extra"
import os from "os"
import pathModule from "path"
import FastGlob from "fast-glob"
import { createVirtualFS, type VfsSpec } from "../fakes/virtual-fs"
import { type SyncFS } from "../../src/lib/environment"

/**
 * These tests are the backstop for the in-memory virtual filesystem: they assert
 * that it behaves like a real OS filesystem for exactly the semantics the sync
 * engine relies on (inode identity, timestamps, recursive ensureDir, symlink
 * detection, fast-glob enumeration). They run with REAL timers on purpose.
 */

const UTIMES_TARGET = new Date("2020-06-15T12:00:00.000Z")
const UTIMES_TARGET_SEC = Math.floor(UTIMES_TARGET.getTime() / 1000)

type FsProbe = {
	inoStable: boolean
	inoAfterRename: number
	inoBeforeRename: number
	inoAfterMove: number
	inoBeforeMove: number
	inoRecreateBefore: number
	inoRecreateAfter: number
	mtimeMsAfterWrite: number
	birthtimeMsAfterWrite: number
	mtimeSecAfterUtimes: number
	nestedDirsAreDirectories: boolean
}

/**
 * Exercise the engine-relevant subset of an fs surface under `root` and report
 * what was observed, so the real and virtual implementations can be compared.
 */
async function probe(fs: SyncFS, root: string): Promise<FsProbe> {
	// Stable inode across two stats of the same file.
	const a = pathModule.join(root, "a.txt")
	await fs.writeFile(a, "alpha", { encoding: "utf-8" })
	const aStat1 = await fs.stat(a)
	const aStat2 = await fs.stat(a)

	// Inode preserved across rename within the same directory.
	const b = pathModule.join(root, "b.txt")
	const b2 = pathModule.join(root, "b-renamed.txt")
	await fs.writeFile(b, "bravo", { encoding: "utf-8" })
	const inoBeforeRename = (await fs.stat(b)).ino
	await fs.rename(b, b2)
	const inoAfterRename = (await fs.stat(b2)).ino

	// Inode preserved across a move into another directory.
	const sub = pathModule.join(root, "sub")
	await fs.ensureDir(sub)
	const c = pathModule.join(root, "c.txt")
	const c2 = pathModule.join(sub, "c.txt")
	await fs.writeFile(c, "charlie", { encoding: "utf-8" })
	const inoBeforeMove = (await fs.stat(c)).ino
	await fs.move(c, c2, { overwrite: true })
	const inoAfterMove = (await fs.stat(c2)).ino

	// Fresh inode after delete + recreate at the same path.
	const d = pathModule.join(root, "d.txt")
	await fs.writeFile(d, "delta", { encoding: "utf-8" })
	const inoRecreateBefore = (await fs.stat(d)).ino
	await fs.rm(d, { force: true, recursive: true })
	await fs.writeFile(d, "delta-2", { encoding: "utf-8" })
	const inoRecreateAfter = (await fs.stat(d)).ino

	// Timestamps populated on write; utimes updates mtime.
	const e = pathModule.join(root, "e.txt")
	await fs.writeFile(e, "echo", { encoding: "utf-8" })
	const eStat = await fs.stat(e)
	await fs.utimes(e, UTIMES_TARGET, UTIMES_TARGET)
	const eStatAfter = await fs.stat(e)

	// Recursive ensureDir.
	const deep = pathModule.join(root, "x", "y", "z")
	await fs.ensureDir(deep)
	const deepStat = await fs.stat(deep)
	const midStat = await fs.stat(pathModule.join(root, "x", "y"))

	return {
		inoStable: aStat1.ino === aStat2.ino,
		inoBeforeRename,
		inoAfterRename,
		inoBeforeMove,
		inoAfterMove,
		inoRecreateBefore,
		inoRecreateAfter,
		mtimeMsAfterWrite: eStat.mtimeMs,
		birthtimeMsAfterWrite: eStat.birthtimeMs,
		mtimeSecAfterUtimes: Math.floor(eStatAfter.mtimeMs / 1000),
		nestedDirsAreDirectories: deepStat.isDirectory() && midStat.isDirectory()
	}
}

describe("virtual filesystem conformance", () => {
	let realRoot: string
	let realProbe: FsProbe
	let virtualProbe: FsProbe

	beforeAll(async () => {
		realRoot = await fsExtra.mkdtemp(pathModule.join(os.tmpdir(), "filen-sync-conformance-"))

		realProbe = await probe(fsExtra as unknown as SyncFS, realRoot)

		const virtual = createVirtualFS()
		await virtual.fs.ensureDir("/root")
		virtualProbe = await probe(virtual.fs, "/root")
	})

	afterAll(async () => {
		if (!realRoot) {
			return
		}

		// Best-effort removal of the OS temp directory; never let a cleanup
		// failure mask a real test result.
		try {
			await fsExtra.rm(realRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 })
		} catch {
			// ignore
		}
	})

	it("reports a stable inode across repeated stats (real + virtual)", () => {
		expect(realProbe.inoStable).toBe(true)
		expect(virtualProbe.inoStable).toBe(true)
	})

	it("preserves the inode across a rename (real + virtual)", () => {
		expect(realProbe.inoAfterRename).toBe(realProbe.inoBeforeRename)
		expect(virtualProbe.inoAfterRename).toBe(virtualProbe.inoBeforeRename)
	})

	it("preserves the inode across a cross-directory move (real + virtual)", () => {
		expect(realProbe.inoAfterMove).toBe(realProbe.inoBeforeMove)
		expect(virtualProbe.inoAfterMove).toBe(virtualProbe.inoBeforeMove)
	})

	it("assigns a fresh inode after delete + recreate (virtual is deterministic)", () => {
		// The engine relies on a recreated path looking like a new item (delete + add,
		// not a no-op). memfs never reuses inodes, so this is deterministic.
		expect(virtualProbe.inoRecreateAfter).not.toBe(virtualProbe.inoRecreateBefore)
	})

	it("populates mtime and birthtime on write (real + virtual)", () => {
		expect(realProbe.mtimeMsAfterWrite).toBeGreaterThan(0)
		expect(virtualProbe.mtimeMsAfterWrite).toBeGreaterThan(0)
		expect(virtualProbe.birthtimeMsAfterWrite).toBeGreaterThan(0)
	})

	it("updates mtime via utimes to whole-second precision (real + virtual)", () => {
		expect(realProbe.mtimeSecAfterUtimes).toBe(UTIMES_TARGET_SEC)
		expect(virtualProbe.mtimeSecAfterUtimes).toBe(UTIMES_TARGET_SEC)
	})

	it("creates intermediate directories with ensureDir (real + virtual)", () => {
		expect(realProbe.nestedDirsAreDirectories).toBe(true)
		expect(virtualProbe.nestedDirsAreDirectories).toBe(true)
	})

	it("detects symlinks via lstat while stat follows them (virtual)", () => {
		const virtual = createVirtualFS({ "/root/target.txt": "payload" })

		virtual.ifs.symlinkSync("/root/target.txt", "/root/link.txt")

		expect(virtual.ifs.lstatSync("/root/link.txt").isSymbolicLink()).toBe(true)
		expect(virtual.ifs.statSync("/root/link.txt").isSymbolicLink()).toBe(false)
		expect(virtual.ifs.statSync("/root/link.txt").isFile()).toBe(true)
	})

	it("enumerates a tree with fast-glob identically to a real directory", async () => {
		const spec: VfsSpec = {
			"/tree/a.txt": "a",
			"/tree/sub/b.txt": "b",
			"/tree/sub/c/d.txt": "d"
		}

		const virtual = createVirtualFS(spec)

		// Mirror the same tree on the real filesystem.
		const realTree = pathModule.join(realRoot, "tree")
		await fsExtra.ensureDir(pathModule.join(realTree, "sub", "c"))
		await fsExtra.writeFile(pathModule.join(realTree, "a.txt"), "a")
		await fsExtra.writeFile(pathModule.join(realTree, "sub", "b.txt"), "b")
		await fsExtra.writeFile(pathModule.join(realTree, "sub", "c", "d.txt"), "d")

		const globOptions = {
			dot: true,
			onlyDirectories: false,
			onlyFiles: false,
			followSymbolicLinks: false,
			deep: Infinity,
			unique: false,
			objectMode: false,
			stats: false
		} as const

		const realEntries = (await FastGlob.async("**/*", { ...globOptions, cwd: realTree })).sort()
		const virtualEntries = (
			await FastGlob.async("**/*", {
				...globOptions,
				cwd: "/tree",
				fs: virtual.globFs as FastGlob.FileSystemAdapter
			})
		).sort()

		expect(virtualEntries).toEqual(["a.txt", "sub", "sub/b.txt", "sub/c", "sub/c/d.txt"])
		expect(virtualEntries).toEqual(realEntries)
	})
})

/**
 * Case-insensitive volume mode (Windows NTFS / macOS APFS / SMB). memfs is natively case-SENSITIVE; this mode
 * resolves any engine-supplied path against the actually-stored casing so the suite can reproduce case
 * divergences that a case-sensitive fake structurally cannot. Real-fs case behavior is host-dependent (Linux
 * case-sensitive, macOS/Windows case-insensitive), so these assert the mode's CONTRACT directly rather than
 * comparing to the host fs.
 */
describe("virtual-fs — case-insensitive volume mode", () => {
	it("stats and reads a file through a DIFFERENT casing than it was created with", async () => {
		const v = createVirtualFS({ "/root/Report.txt": "hello" }, { caseInsensitive: true })
		const fs = v.fs as SyncFS

		expect((await fs.stat("/root/report.txt")).size).toBe("hello".length)
		expect((await fs.stat("/ROOT/REPORT.TXT")).size).toBe("hello".length)
		expect((await fs.readFile("/root/report.txt", { encoding: "utf-8" })) as unknown as string).toBe("hello")
		expect(await fs.pathExists("/root/report.TXT")).toBe(true)
	})

	it("resolves a case-differing PARENT directory to the stored one", async () => {
		const v = createVirtualFS({ "/root/SEPA/index.html": "x" }, { caseInsensitive: true })
		const fs = v.fs as SyncFS

		// Whole-path fold: parent "sepa" resolves to the stored "SEPA".
		expect((await fs.stat("/root/sepa/index.html")).size).toBe(1)
		expect(await fs.pathExists("/ROOT/sepa/INDEX.html")).toBe(true)
	})

	it("writing a differently-cased path OVERWRITES the existing file and keeps its stored name", async () => {
		const v = createVirtualFS({ "/root/data.txt": "old" }, { caseInsensitive: true })
		const fs = v.fs as SyncFS

		await fs.writeFile("/root/DATA.txt", "new")

		// One file, still stored as the original casing, with the new content.
		expect(Object.keys(v.vol.toJSON())).toEqual(["/root/data.txt"])
		expect((await fs.readFile("/root/data.txt", { encoding: "utf-8" })) as unknown as string).toBe("new")
	})

	it("a case-ONLY rename re-cases the stored name (does not collapse onto the source)", async () => {
		const v = createVirtualFS({ "/root/readme.txt": "doc" }, { caseInsensitive: true })
		const fs = v.fs as SyncFS

		await fs.rename("/root/readme.txt", "/root/README.txt")

		expect(Object.keys(v.vol.toJSON())).toEqual(["/root/README.txt"])
		expect((await fs.readFile("/root/readme.txt", { encoding: "utf-8" })) as unknown as string).toBe("doc")
	})

	it("a fast-glob scan returns the STORED casing (so the local tree is keyed by on-disk case)", async () => {
		const v = createVirtualFS({ "/root/Photos/Holiday.JPG": "img" }, { caseInsensitive: true })

		const entries = (
			await FastGlob.async("**/*", {
				cwd: "/root",
				fs: v.globFs as FastGlob.FileSystemAdapter,
				onlyFiles: false,
				markDirectories: false
			})
		).sort()

		expect(entries).toEqual(["Photos", "Photos/Holiday.JPG"])
	})

	it("is the identity on a case-sensitive volume (default) — two casings are two files", async () => {
		const v = createVirtualFS({ "/root/a.txt": "one" }, { caseInsensitive: false })
		const fs = v.fs as SyncFS

		await fs.writeFile("/root/A.txt", "two")

		expect(Object.keys(v.vol.toJSON()).sort()).toEqual(["/root/A.txt", "/root/a.txt"])
	})
})

/**
 * Real-filesystem TRAITS that memfs cannot produce natively but Windows / SMB volumes exhibit — the reason the
 * Windows/SMB field bugs slipped past a purely-memfs suite. These assert each trait is faithfully modelled so
 * the trait-matrix sweep can rely on it.
 */
describe("virtual-fs — SMB / real-fs trait modes", () => {
	it("inodeMode 'zero' reports ino: 0 for every entry (SMB / network mounts)", async () => {
		const v = createVirtualFS({ "/root/a.txt": "a", "/root/dir/b.txt": "b" }, { inodeMode: "zero" })
		const fs = v.fs as SyncFS

		expect((await fs.lstat("/root/a.txt")).ino).toBe(0)
		expect((await fs.lstat("/root/dir/b.txt")).ino).toBe(0)
		expect((await fs.stat("/root/dir")).ino).toBe(0)
	})

	it("default inodeMode is 'stable' — memfs's unique, stable inodes", async () => {
		const v = createVirtualFS({ "/root/a.txt": "a", "/root/b.txt": "b" })
		const fs = v.fs as SyncFS

		const a = (await fs.lstat("/root/a.txt")).ino
		const b = (await fs.lstat("/root/b.txt")).ino

		expect(a).toBeGreaterThan(0)
		expect(a).not.toBe(b)
		expect((await fs.lstat("/root/a.txt")).ino).toBe(a) // stable across calls
	})

	it("fractionalMtime makes reported mtimes non-integer (real-fs sub-ms precision)", async () => {
		const v = createVirtualFS({ "/root/f.txt": "x" }, { fractionalMtime: true })
		const fs = v.fs as SyncFS

		const mtimeMs = (await fs.lstat("/root/f.txt")).mtimeMs

		expect(Number.isInteger(mtimeMs)).toBe(false)
	})
})
