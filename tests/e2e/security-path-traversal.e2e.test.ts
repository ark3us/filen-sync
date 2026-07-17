import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import fs from "fs-extra"
import pathModule from "path"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle } from "./harness/drive"
import { writeLocal } from "./harness/mutations"

/**
 * Security regression (live) — PATH TRAVERSAL sink guards (F01-08).
 *
 * The end-to-end injection (a remote folder literally named `..`) requires a CUSTOM client that bypasses the
 * SDK's client-side name validation — the real SDK we drive here will not create such a folder — so the
 * tree-build-filter half is covered in the mocked suite (via the fake cloud). What IS validated live is the
 * last-line SINK guard against the REAL filesystem: calling the download / mkdir / rename sinks with a
 * traversal path must throw and touch nothing outside the sync root (where a real overwrite of e.g. ~/.bashrc
 * would otherwise happen). Add-only.
 */
describe.skipIf(!E2E_ENABLED)("E2E — path traversal sink guards", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	/** Absolute path just OUTSIDE the real sync root — where a traversal escape would land. */
	function escapeTarget(localRoot: string, name: string): string {
		return pathModule.join(localRoot, "..", name)
	}

	it("F01-08-live: the download / mkdir / rename sinks refuse a traversal path against the real fs", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "legit.txt", "ok")
			await settle(world)

			const downloadEscape = escapeTarget(world.localRoot, "evil-download.txt")
			const mkdirEscape = escapeTarget(world.localRoot, "evil-dir")
			const renameEscape = escapeTarget(world.localRoot, "evil-rename.txt")

			// Each sink, driven directly with a `..` path, must throw…
			await expect(world.sync.remoteFileSystem.download({ relativePath: "/../evil-download.txt" })).rejects.toThrow(/traversal/i)
			await expect(world.sync.localFileSystem.mkdir({ relativePath: "/../evil-dir" })).rejects.toThrow(/traversal/i)
			await expect(
				world.sync.localFileSystem.rename({ fromRelativePath: "/legit.txt", toRelativePath: "/../evil-rename.txt" })
			).rejects.toThrow(/traversal/i)

			// …and NOTHING was written/created just outside the real sync root.
			expect(await fs.pathExists(downloadEscape), "download escaped the root").toBe(false)
			expect(await fs.pathExists(mkdirEscape), "mkdir escaped the root").toBe(false)
			expect(await fs.pathExists(renameEscape), "rename escaped the root").toBe(false)

			// The legit source file is untouched by the failed move.
			expect(await fs.pathExists(pathModule.join(world.localRoot, "legit.txt"))).toBe(true)
		})
	}, 1_800_000)

	/**
	 * Regression (v3.0.50), live against the real fs: when the sync root is a filesystem MOUNT ROOT — a Windows
	 * mapped-drive root (`C:\`) or UNC share root (`\\NAS\share`), the common Synology-over-SMB shape — the
	 * pre-fix containment check appended a second separator to the already-separator-terminated `resolve()`
	 * output and rejected EVERY child as a traversal, so all files failed to sync (the ticket). Repoint the pair
	 * at the tmp tree's actual drive/mount root (a genuine `C:\` on the windows-latest CI leg) and drive the real
	 * mkdir sink at a child of it — it must create the directory, not throw. The target still lives inside our
	 * tmp tree, so nothing outside is touched, and it is removed afterwards.
	 */
	it("F01-08-live-mountroot: a real write sink admits a child when the pair is rooted at a drive/mount root", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const mountRoot = pathModule.parse(world.localRoot).root // "C:\\" on Windows, "/" on posix
			// The relative path from the mount root down to a fresh dir inside our tmp tree.
			const targetAbs = pathModule.join(world.localRoot, `mountroot-regression-${world.runId}`)
			const relFromMountRoot = pathModule.sep + pathModule.relative(mountRoot, targetAbs)

			world.syncPair.localPath = mountRoot

			try {
				// Pre-fix: threw "path traversal" for every child of a mount root. Post-fix: creates it.
				await expect(world.sync.localFileSystem.mkdir({ relativePath: relFromMountRoot })).resolves.toBeDefined()
				expect(await fs.pathExists(targetAbs), "mkdir did not create the child of a mount-root pair").toBe(true)
			} finally {
				await fs.remove(targetAbs)
			}
		})
	}, 1_800_000)
})
