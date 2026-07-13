import { describe, it, expect } from "vitest"
import pathModule from "path"
import { assertPathWithinSyncRoot } from "../../src/utils"

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
		// begins with the root's — the `+ path.sep` in the guard prevents it.
		const sibling = pathModule.resolve("/sync/rootX/file.txt")

		expect(sibling.startsWith(root)).toBe(true) // proves the naive check WOULD pass…
		expect(() => assertPathWithinSyncRoot(root, sibling)).toThrow(/traversal/i) // …but the guard rejects it
		expect(() => assertPathWithinSyncRoot(root, pathModule.resolve("/sync/root-evil"))).toThrow(/traversal/i)
	})
})
