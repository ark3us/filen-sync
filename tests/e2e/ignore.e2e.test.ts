import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, modifyLocal, existsLocal } from "./harness/mutations"

/**
 * Phase 3 e2e — .filenignore + dotfile filtering against the live backend. Ignored paths must never
 * reach the remote; everything else must.
 */
describe.skipIf(!E2E_ENABLED)("E2E — ignore filtering", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("ignores a directory pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "ignored/\n" }, async world => {
			await writeLocal(world, "ignored/secret.txt", "nope")
			await writeLocal(world, "visible.txt", "yes")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/visible.txt"]).toMatchObject({ type: "file" })
			expect(remote["/ignored"]).toBeUndefined()
			expect(remote["/ignored/secret.txt"]).toBeUndefined()
		})
	})

	it("ignores a glob pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "*.log\n" }, async world => {
			await writeLocal(world, "app.log", "log")
			await writeLocal(world, "app.txt", "txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/app.txt"]).toMatchObject({ type: "file" })
			expect(remote["/app.log"]).toBeUndefined()
		})
	})

	it("honors a negation pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "*.log\n!keep.log\n" }, async world => {
			await writeLocal(world, "drop.log", "drop")
			await writeLocal(world, "keep.log", "keep")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/keep.log"]).toMatchObject({ type: "file" })
			expect(remote["/drop.log"]).toBeUndefined()
		})
	})

	it("ignores a nested glob pattern", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "**/*.tmp\n" }, async world => {
			await writeLocal(world, "a/b/scratch.tmp", "tmp")
			await writeLocal(world, "a/b/real.txt", "real")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a/b/real.txt"]).toMatchObject({ type: "file" })
			expect(remote["/a/b/scratch.tmp"]).toBeUndefined()
		})
	})

	it("excludes dotfiles when excludeDotFiles is set", async () => {
		await withE2EWorld({ sdk, mode: "twoWay", excludeDotFiles: true }, async world => {
			await writeLocal(world, ".hidden", "secret")
			await writeLocal(world, "shown.txt", "public")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/shown.txt"]).toMatchObject({ type: "file" })
			expect(remote["/.hidden"]).toBeUndefined()
		})
	})

	it("default OS-junk names (.DS_Store, Thumbs.db) are never uploaded; real files sync", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, ".DS_Store", "junk")
			await writeLocal(world, "Thumbs.db", "junk")
			await writeLocal(world, "real.txt", "real")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/.DS_Store"]).toBeUndefined()
			expect(remote["/Thumbs.db"]).toBeUndefined()
			expect(remote["/real.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("a file synced and THEN newly ignored is not deleted from the remote (ignore ≠ delete)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "keep-me.txt", "content")
			await settle(world)

			// It synced up.
			expect((await snapshotRemoteReal(world))["/keep-me.txt"]).toMatchObject({ type: "file" })

			// Now ignore the already-synced file and edit it; ignoring must not imply a remote deletion.
			await world.worker.updateIgnorerContent(world.syncPair.uuid, "keep-me.txt")
			await modifyLocal(world, "keep-me.txt", "content-edited-after-ignore")
			await settle(world)

			// The remote copy survives and the local file is untouched — ignore is not deletion.
			expect((await snapshotRemoteReal(world))["/keep-me.txt"]).toMatchObject({ type: "file" })
			expect(await existsLocal(world, "keep-me.txt")).toBe(true)
		})
	})

	it("the 'ignore all node_modules, keep this one' idiom syncs the re-included subtree", async () => {
		// Fix #2: a bare-name rule must not emit a **-prefixed prune that drops a deeper, negation-re-included
		// instance from the scan. keep/node_modules is re-included and must reach the cloud; top-level stays out.
		await withE2EWorld({ sdk, mode: "twoWay", filenIgnore: "node_modules\n!keep/node_modules/\n" }, async world => {
			await writeLocal(world, "app.js", "a")
			await writeLocal(world, "node_modules/dep.js", "d")
			await writeLocal(world, "keep/node_modules/lib.js", "L")
			await writeLocal(world, "keep/node_modules/nested/deep.js", "D")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/keep/node_modules/lib.js"]).toMatchObject({ type: "file" })
			expect(remote["/keep/node_modules/nested/deep.js"]).toMatchObject({ type: "file" })
			expect(remote["/app.js"]).toMatchObject({ type: "file" })
			expect(remote["/node_modules/dep.js"]).toBeUndefined()
		})
	})

	it("introducing that idiom AFTER the subtree synced does not delete the re-included cloud copy", async () => {
		// Fix #2 (the data-loss path): over a settled base the wrong prune read as a deletion and trashed the
		// re-included subtree from the cloud. The matcher KEEPS it, so it must survive the rescan.
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "keep/node_modules/lib.js", "L")
			await writeLocal(world, "keep/node_modules/nested/deep.js", "D")
			await writeLocal(world, "other.txt", "O")
			await settle(world)

			// The whole subtree synced up.
			expect((await snapshotRemoteReal(world))["/keep/node_modules/lib.js"]).toMatchObject({ type: "file" })

			// Introduce the idiom; keep/node_modules is re-included, so it must NOT be deleted from the cloud.
			await world.worker.updateIgnorerContent(world.syncPair.uuid, "node_modules\n!keep/node_modules/")
			await writeLocal(world, "trigger.txt", "t")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/keep/node_modules/lib.js"]).toMatchObject({ type: "file" })
			expect(remote["/keep/node_modules/nested/deep.js"]).toMatchObject({ type: "file" })
			expect(remote["/other.txt"]).toMatchObject({ type: "file" })
			expect(await existsLocal(world, "keep/node_modules/lib.js")).toBe(true)
		})
	})
})
