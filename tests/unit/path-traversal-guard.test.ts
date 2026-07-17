import { describe, it, expect } from "vitest"
import pathModule from "path"
import { assertPathWithinSyncRoot, isPathWithinSyncRoot } from "../../src/utils"

/**
 * Regression net for `assertPathWithinSyncRoot` — the last-line sink guard against path traversal. A shared
 * folder can carry an attacker-controlled name whose decrypted value contains `..` segments (the e2e-encrypted
 * backend can only validate names client-side, so a custom client can create a folder literally named `..`).
 * `path.join` collapses `..`, so the resulting local path can point OUTSIDE the sync root; a write there could
 * overwrite arbitrary user files (e.g. ~/.bashrc → RCE). The guard must reject any path that resolves outside
 * the root — including the classic prefix-sibling bypass (`/root` vs `/rootX`) and the root itself.
 */
describe("assertPathWithinSyncRoot — path traversal guard", () => {
	const root = pathModule.resolve("/sync/root")

	it("allows paths strictly inside the root", () => {
		expect(() => assertPathWithinSyncRoot(root, pathModule.join(root, "file.txt"))).not.toThrow()
		expect(() => assertPathWithinSyncRoot(root, pathModule.join(root, "a/b/c/deep.txt"))).not.toThrow()
		expect(() => assertPathWithinSyncRoot(root, pathModule.join(root, ".filen.trash.local", "x"))).not.toThrow()
	})

	it("rejects a path that escapes via `..` (collapsed by join)", () => {
		// pathModule.join(root, "/../evil") already collapses to a sibling/parent path — exactly what the sinks build.
		expect(() => assertPathWithinSyncRoot(root, pathModule.join(root, "..", "evil.txt"))).toThrow(/traversal/i)
		expect(() => assertPathWithinSyncRoot(root, pathModule.join(root, "../../etc/passwd"))).toThrow(/traversal/i)
		expect(() => assertPathWithinSyncRoot(root, pathModule.join(root, "sub/../../escape"))).toThrow(/traversal/i)
	})

	it("rejects an absolute path outside the root", () => {
		expect(() => assertPathWithinSyncRoot(root, pathModule.resolve("/etc/passwd"))).toThrow(/traversal/i)
		expect(() => assertPathWithinSyncRoot(root, pathModule.resolve("/tmp/evil"))).toThrow(/traversal/i)
	})

	it("rejects the root ITSELF (never a legitimate write target)", () => {
		expect(() => assertPathWithinSyncRoot(root, root)).toThrow(/traversal/i)
	})

	it("rejects the PREFIX-SIBLING bypass (/root vs /rootX)", () => {
		// A naive startsWith(root) without a trailing separator would wrongly admit a sibling whose name merely
		// begins with the root's — the guard rejects it.
		const sibling = pathModule.resolve("/sync/rootX/file.txt")

		expect(sibling.startsWith(root)).toBe(true) // proves the naive check WOULD pass…
		expect(() => assertPathWithinSyncRoot(root, sibling)).toThrow(/traversal/i) // …but the guard rejects it
		expect(() => assertPathWithinSyncRoot(root, pathModule.resolve("/sync/root-evil"))).toThrow(/traversal/i)
	})

	/**
	 * Regression (v3.0.50): when the sync root is a filesystem MOUNT ROOT — a mapped-drive root (`Z:\`) or a UNC
	 * share root (`\\NAS\share`), the common Synology-over-SMB shape — `path.resolve()` already ends in a
	 * separator, so the old `resolved.startsWith(root + sep)` check appended a SECOND separator (`Z:\\`,
	 * `\\NAS\share\\`) that no legitimate child could ever match. Every synced item threw "path traversal", so
	 * all files failed (7000+ errors). A mount root must admit its own children like any other root.
	 */
	it("admits children when the sync root is the filesystem root (host-native mount-root shape)", () => {
		// On this host `pathModule.resolve(root)` of the fs root ends in a separator — the exact doubled-sep trigger.
		const fsRoot = pathModule.resolve(pathModule.sep)

		expect(() => assertPathWithinSyncRoot(fsRoot, pathModule.join(fsRoot, "file.txt"))).not.toThrow()
		expect(() => assertPathWithinSyncRoot(fsRoot, pathModule.join(fsRoot, "a/b/deep.txt"))).not.toThrow()
		// …while still rejecting the root itself.
		expect(() => assertPathWithinSyncRoot(fsRoot, fsRoot)).toThrow(/traversal/i)
	})
})

/**
 * Platform-explicit containment predicate that backs the guard. Driven with an injected `path` flavor so the
 * real Windows Synology-over-SMB shapes (mapped-drive root `Z:\`, UNC share root `\\NAS\share`) are asserted on
 * every CI leg, not only the windows-latest one. `isPathWithinSyncRoot` is the shared, pure core both the
 * throwing sink guard and the remote tree-build filter call.
 */
describe("isPathWithinSyncRoot — mount-root containment (v3.0.50 regression)", () => {
	const win = pathModule.win32
	const posix = pathModule.posix

	it("admits children of a Windows mapped-drive ROOT (Z:\\) — the SMB drive-letter mount", () => {
		expect(isPathWithinSyncRoot("Z:\\", "Z:\\file.txt", win)).toBe(true)
		expect(isPathWithinSyncRoot("Z:\\", win.join("Z:\\", "sub", "deep.txt"), win)).toBe(true)
	})

	it("admits children of a Windows UNC share ROOT (\\\\NAS\\share) — the SMB UNC mount", () => {
		expect(isPathWithinSyncRoot("\\\\NAS\\share", "\\\\NAS\\share\\file.txt", win)).toBe(true)
		expect(isPathWithinSyncRoot("\\\\NAS\\share\\", win.join("\\\\NAS\\share", "a", "b.txt"), win)).toBe(true)
	})

	it("admits children of an ordinary Windows SUBFOLDER root (Z:\\Sync)", () => {
		expect(isPathWithinSyncRoot("Z:\\Sync", win.join("Z:\\Sync", "sub", "f.txt"), win)).toBe(true)
	})

	it("still rejects escape, the root itself, cross-drive, and the sibling-prefix bypass on win32", () => {
		expect(isPathWithinSyncRoot("Z:\\Sync", win.join("Z:\\Sync", "..", "evil.txt"), win)).toBe(false)
		expect(isPathWithinSyncRoot("Z:\\Sync", "Z:\\Sync", win)).toBe(false)
		expect(isPathWithinSyncRoot("Z:\\Sync", "C:\\evil.txt", win)).toBe(false)
		expect(isPathWithinSyncRoot("Z:\\Sync", "Z:\\SyncEvil\\x.txt", win)).toBe(false)
	})

	it("does not confuse a child named `..foo` for an escape (false-positive guard)", () => {
		expect(isPathWithinSyncRoot("Z:\\Sync", win.join("Z:\\Sync", "..foo", "x.txt"), win)).toBe(true)
		expect(isPathWithinSyncRoot("/home/u/sync", posix.join("/home/u/sync", "..foo", "x.txt"), posix)).toBe(true)
	})

	it("admits children of the posix root (/) and rejects escapes", () => {
		expect(isPathWithinSyncRoot("/", "/file.txt", posix)).toBe(true)
		expect(isPathWithinSyncRoot("/home/u/sync", posix.join("/home/u/sync", "..", "evil"), posix)).toBe(false)
		expect(isPathWithinSyncRoot("/sync/root", "/sync/rootX/file.txt", posix)).toBe(false)
	})
})
