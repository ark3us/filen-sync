import { describe, it, expect, beforeAll, afterAll } from "vitest"
import pathModule from "path"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, cycle, expectConverged, transferKinds } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import {
	writeLocal,
	modifyLocal,
	rmLocal,
	renameLocal,
	readLocal,
	uploadRemote,
	deleteRemote,
	renameRemote,
	renameRemoteDir,
	setLocalMtime,
	existsLocal
} from "./harness/mutations"

/**
 * Phase 3 e2e — twoWay conflict resolution against the live backend (both sides changed since the last
 * sync). The mtime helper makes the local side deterministically newer where "newest wins" applies.
 */
describe.skipIf(!E2E_ENABLED)("E2E — twoWay conflict resolution", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("both sides create the same path; the newer (local) copy wins", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Local copy stamped clearly-newer than the remote upload that follows.
			await modifyLocal(world, "c.txt", "LOCAL-WINS")
			await uploadRemote(world, "c.txt", "remote-loses")

			await settle(world)

			await expectConverged(world)
			expect(await readLocal(world, "c.txt")).toBe("LOCAL-WINS")
		})
	})

	it("no base, EQUAL-second mtime but DIFFERENT sizes → converges (tie to local, #11)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			const T = 1_600_000_000_000 // a fixed whole second

			// Seed the REMOTE with a differently-sized copy at mtime T: stamp a local file at T and upload it raw
			// (bypassing the engine so no base is created), then re-purpose the local file.
			await writeLocal(world, "nb.txt", "REMOTE-TEN-X")
			await setLocalMtime(world, "nb.txt", T)
			await world.sdk.cloud().uploadLocalFile({
				source: pathModule.join(world.localRoot, "nb.txt"),
				parent: world.remoteParentUUID,
				name: "nb.txt"
			})

			// The LOCAL copy now carries DIFFERENT bytes at the SAME whole second — and there is no base yet.
			await writeLocal(world, "nb.txt", "LOCAL-5")
			await setLocalMtime(world, "nb.txt", T)

			await settle(world)
			await expectConverged(world)

			// The size divergence is not discarded; the equal-mtime tie resolves to local (it wins because the
			// local additions pass runs first). Without the fix neither side transfers and they diverge forever.
			expect(await readLocal(world, "nb.txt")).toBe("LOCAL-5")
			expect((await snapshotRemoteReal(world))["/nb.txt"]).toMatchObject({ type: "file", size: "LOCAL-5".length })
		})
	})

	it("local modify vs remote delete: the newer local modification wins, resurrected (E2E-OBS-001)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "f.txt", "v1")
			await settle(world)

			// The local copy is edited (content changed) while the remote deletes it. Per newer-modify-wins
			// the local modification survives the deletion: the file is re-uploaded (resurrected) remotely
			// and kept locally with the local content, rather than being removed on both sides.
			await modifyLocal(world, "f.txt", "v2-modified")
			await deleteRemote(world, "f.txt")

			await settle(world)

			await expectConverged(world)
			expect(await existsLocal(world, "f.txt")).toBe(true)
			expect(await readLocal(world, "f.txt")).toBe("v2-modified")
			expect((await snapshotRemoteReal(world))["/f.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("local delete vs remote-unchanged: the delete propagates", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "g.txt", "data")
			await settle(world)

			await rmLocal(world, "g.txt")

			await settle(world)

			expect((await snapshotRemoteReal(world))["/g.txt"]).toBeUndefined()
			await expectConverged(world)
		})
	})

	it("remote modify vs local delete: the newer remote modification wins, resurrected (F7)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "h.txt", "v1")
			await settle(world)

			// Symmetric to the local-modify-vs-remote-delete case: the local copy is deleted while the remote
			// modifies it (a new version). The newer modification wins on EITHER side, so the file survives.
			await rmLocal(world, "h.txt")
			await uploadRemote(world, "h.txt", "REMOTE-MODIFIED")

			await settle(world)

			await expectConverged(world)
			expect(await existsLocal(world, "h.txt")).toBe(true)
			expect(await readLocal(world, "h.txt")).toBe("REMOTE-MODIFIED")
		})
	})

	it("rename + in-place modify in one beat keeps the new name AND the new content (F1)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "original-content")
			await settle(world)

			// Rename, then immediately overwrite the renamed file before the next sync. The rename must not
			// mask the content change — the remote ends with the NEW bytes under the new name.
			await renameLocal(world, "a.txt", "b.txt")
			await writeLocal(world, "b.txt", "BRAND-NEW-CONTENT")

			await settle(world)

			await expectConverged(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "b.txt")).toBe("BRAND-NEW-CONTENT")
		})
	})

	// --- Conflict-matrix parity with mocked Category Y (the trickiest rename-vs-other-side cases) ---

	it("add(local) vs add(remote) same path, remote newer → the remote copy wins (Y2)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "addboth.txt", "LOCAL-OLDER")
			// Age the local copy so the remote upload that follows is unambiguously newer.
			await setLocalMtime(world, "addboth.txt", Date.now() - 60_000)
			await uploadRemote(world, "addboth.txt", "REMOTE-NEWER")

			await settle(world)

			await expectConverged(world)
			expect(await readLocal(world, "addboth.txt")).toBe("REMOTE-NEWER")
		})
	})

	it("delete(local) vs delete(remote) same path → converges to empty, no error (Y3)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "doomed.txt", "bye")
			await settle(world)

			await rmLocal(world, "doomed.txt")
			await deleteRemote(world, "doomed.txt")

			await settle(world)

			await expectConverged(world)
			expect((await snapshotRemoteReal(world))["/doomed.txt"]).toBeUndefined()
			expect(await existsLocal(world, "doomed.txt")).toBe(false)
		})
	})

	it("rename(local a→b) vs delete(remote a) → converges to {b}, data preserved (Y7)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await renameLocal(world, "a.txt", "b.txt")
			await deleteRemote(world, "a.txt")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await existsLocal(world, "b.txt")).toBe(true)
		})
	})

	it("rename(local a→b) vs modify(remote a) → converges keeping BOTH a and b (Y8)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "orig")
			await settle(world)

			await renameLocal(world, "a.txt", "b.txt")
			await uploadRemote(world, "a.txt", "REMOTE-MOD")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toMatchObject({ type: "file" })
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "a.txt")).toBe("REMOTE-MOD")
			expect(await readLocal(world, "b.txt")).toBe("orig")
		})
	})

	it("rename(local a→X) vs rename(remote a→Y) → converges keeping BOTH X and Y (Y9)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await renameLocal(world, "a.txt", "local-name.txt")
			await renameRemote(world, "a.txt", "remote-name.txt")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/local-name.txt"]).toMatchObject({ type: "file" })
			expect(remote["/remote-name.txt"]).toMatchObject({ type: "file" })
			expect(remote["/a.txt"]).toBeUndefined()
		})
	})

	it("rename(remote a→b) vs delete(local a) → converges to {b}, data preserved (Y10)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await renameRemote(world, "a.txt", "b.txt")
			await rmLocal(world, "a.txt")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
		})
	})

	it("rename(remote a→b) vs modify(local a) → converges keeping BOTH a and b (Y11)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "orig")
			await settle(world)

			await renameRemote(world, "a.txt", "b.txt")
			await modifyLocal(world, "a.txt", "LOCAL-MOD")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toMatchObject({ type: "file" })
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "a.txt")).toBe("LOCAL-MOD")
			expect(await readLocal(world, "b.txt")).toBe("orig")
		})
	})

	it("a bare mtime touch on a DOWNLOADED file is not re-uploaded (#19)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Seed the remote and let the engine DOWNLOAD it to local — the download now caches the file's md5.
			await uploadRemote(world, "dl.txt", "downloaded-bytes")
			await settle(world)
			await expectConverged(world)

			// A bare mtime touch: the bytes are identical, only the mtime moves (clearly newer than the base).
			await setLocalMtime(world, "dl.txt", Date.now() + 120_000)

			// The touch cycle must NOT re-upload the unchanged bytes — the cached download hash dedups the upload.
			// Without the fix the downloaded file has no cached hash, so the md5 mismatch re-uploads the file.
			const messages = await cycle(world)

			expect(
				transferKinds(messages).filter(op => op.startsWith("upload")),
				"a bare touch on a downloaded file re-uploaded unchanged bytes"
			).toEqual([])
			expect(await readLocal(world, "dl.txt")).toBe("downloaded-bytes")
		})
	})

	it("delete(local a) + add(remote b) in one cycle → both applied, converges (Y12)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "a.txt", "data")
			await settle(world)

			await rmLocal(world, "a.txt")
			await uploadRemote(world, "b.txt", "new-remote")

			await settle(world)

			await expectConverged(world)
			const remote = await snapshotRemoteReal(world)
			expect(remote["/a.txt"]).toBeUndefined()
			expect(remote["/b.txt"]).toMatchObject({ type: "file" })
		})
	})

	// --- #10: cross-side NESTED directory renames at different levels, with the nested file ALSO modified ---
	// The mocked XD2/XD4 pin this against the fake cloud (where a modify replaces the inode); these exercise the
	// live backend, where a rename+modify PRESERVES the inode and the engine takes the explicit file-rename path.

	it("local renames OUTER + modifies nested file, remote renames INNER → both compose, no duplicate (#10 / XD2)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "top/mid/file.txt", "ORIGINAL")
			await writeLocal(world, "top/keep.txt", "K")
			await settle(world)
			await expectConverged(world)

			// Local: rename the OUTER dir /top -> /top2 AND modify the deeply-nested file (clearly-newer mtime).
			await renameLocal(world, "top", "top2")
			await modifyLocal(world, "top2/mid/file.txt", "MODIFIED-LONGER-CONTENT")
			// Remote (a peer): rename the INNER dir /top/mid -> /top/mid2 in the same window.
			await renameRemoteDir(world, "top/mid", "top/mid2")

			await settle(world)
			await expectConverged(world)

			const remote = await snapshotRemoteReal(world)

			// Both renames compose: the modified file lands at /top2/mid2/file.txt with the NEW bytes, and NEITHER
			// pre-rename position lingers (the #10 permanent duplicate).
			expect(remote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "MODIFIED-LONGER-CONTENT".length })
			expect(remote["/top2/mid/file.txt"]).toBeUndefined()
			expect(remote["/top2/mid"]).toBeUndefined()
			expect(remote["/top2/keep.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "top2/mid2/file.txt")).toBe("MODIFIED-LONGER-CONTENT")
		})
	})

	it("remote renames OUTER + modifies nested file, local renames INNER → both compose, no duplicate (#10 / XD4)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "top/mid/file.txt", "ORIGINAL")
			await writeLocal(world, "top/keep.txt", "K")
			await settle(world)
			await expectConverged(world)

			// Remote (a peer): rename the OUTER dir /top -> /top2 AND re-upload the nested file with new content.
			await renameRemoteDir(world, "top", "top2")
			await uploadRemote(world, "top2/mid/file.txt", "REMOTE-MODIFIED-LONGER")
			// Local: rename the INNER dir /top/mid -> /top/mid2 in the same window.
			await renameLocal(world, "top/mid", "top/mid2")

			await settle(world)
			await expectConverged(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "REMOTE-MODIFIED-LONGER".length })
			expect(remote["/top2/mid/file.txt"]).toBeUndefined()
			expect(remote["/top2/mid"]).toBeUndefined()
			expect(remote["/top2/keep.txt"]).toMatchObject({ type: "file" })
			expect(await readLocal(world, "top2/mid2/file.txt")).toBe("REMOTE-MODIFIED-LONGER")
		})
	})
})
