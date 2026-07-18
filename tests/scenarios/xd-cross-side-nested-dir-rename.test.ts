import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { transferKinds } from "../harness/snapshot"
import { renameLocal, writeLocalAt } from "../harness/mutations"
import { BASE_TIME } from "../harness/world"

/**
 * Category XD — cross-side NESTED directory renames at DIFFERENT nesting levels in the SAME cycle.
 *
 * ZB / ZW pin a directory renamed on one side while a DESCENDANT (file or child rename/move) changes on
 * the other. The untested shape here is two DIRECTORY renames at DIFFERENT levels of the same chain, one
 * per side: e.g. local renames the OUTER directory /top → /top2 while remote renames the INNER directory
 * /top/mid → /top/mid2. The correct merge applies BOTH renames (→ /top2/mid2/...), which the engine reaches
 * by propagating the outer rename and degrading the cross-blocked inner rename into delete+re-create of the
 * inner subtree on the slower side. This exercises the rename-aware rebase (rebase{Local,Remote}TreeAcross
 * Renames + rebasePathAcrossRenames) COMPOSING an outer rename from one side with an inner rename from the
 * other — a path neither ZB (descendant change) nor ZW (child rename) reaches.
 *
 * Critical safety: when the deeply-nested file is ALSO modified on the renaming side, the inner-rename
 * degradation must NOT delete+re-download over the local edit (the BUG-A class). XD2/XD4 guard that — the
 * modified content must survive on both sides.
 *
 * Distinct names (top/top2, mid/mid2) avoid the case-insensitive-per-parent backend folding /a and /A.
 */
const SECOND = 1000

describe("Category XD — cross-side nested directory renames (different levels)", () => {
	it("XD1: local renames OUTER dir + remote renames INNER dir → both renames compose, converges", async () => {
		const result = await runScenario({
			name: "XD1",
			mode: "twoWay",
			initialLocal: {
				"/local/top/mid/file.txt": "FILE",
				"/local/top/mid/sib.txt": "S",
				"/local/top/keep.txt": "K"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "top", "top2")),
				remoteMutate(world => world.cloud.controls.movePath("/top/mid", "/top/mid2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Both renames applied: the inner dir lands under the renamed outer dir, children intact.
		expect(result.finalRemote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "FILE".length })
		expect(result.finalRemote["/top2/mid2/sib.txt"]).toMatchObject({ type: "file", size: "S".length })
		expect(result.finalRemote["/top2/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		// No stale paths from either pre-rename position, and no half-applied intermediate.
		expect(result.finalRemote["/top"]).toBeUndefined()
		expect(result.finalRemote["/top2/mid"]).toBeUndefined()
		expect(result.finalRemote["/top/mid2"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/top2/mid2/file.txt"]!.contentHash).toBe(result.finalRemote["/top2/mid2/file.txt"]!.contentHash)
	})

	// KNOWN LIMITATION (#10) — pinned as an expected-failure. A cross-side nested dir-rename where the file is
	// ALSO modified on the renaming side leaves a permanent DUPLICATE: the modified edit is stranded at the
	// pre-inner-rename path AND a copy appears at the composed path (both sides converge to the duplicate, so
	// there is NO data loss). Root cause: the remote inner rename is dropped at DETECTION — the pass's
	// source-unchanged check looks up the moved source at its pre-outer-rename path and misses it — so the move
	// decomposes into delete+add and the local modify then preserves the old path. A correct fix must restructure
	// the rename-detection ordering (a cross-side dir-rename pre-scan so each pass rebases its source lookup) AND
	// the composition rebase together; a partial attempt reintroduced the duplicate into the WORKING no-modify
	// case (XD1), so it needs dedicated review of the engine's most delicate, data-loss-critical path rather than
	// a rushed change. Strengthened assertions (from a `some(size)` check a duplicate passed) are kept under
	// it.fails so the bug is CI-visible and this test flips to a hard failure the moment a real fix lands. The
	// base case WITHOUT the modify (XD1/XD3/XD5/XD6) already composes correctly with no duplicate.
	it.fails("XD2: local renames OUTER dir + MODIFIES the nested file, remote renames INNER dir → the edit survives (no BUG-A loss)", async () => {
		const result = await runScenario({
			name: "XD2",
			mode: "twoWay",
			initialLocal: {
				"/local/top/mid/file.txt": "ORIGINAL",
				"/local/top/keep.txt": "K"
			},
			steps: [
				runCycle(),
				localMutate(world => {
					renameLocal(world, "top", "top2")
					// Edit the deeply-nested file (now under the renamed outer dir) with longer, newer content.
					writeLocalAt(world, "top2/mid/file.txt", "MODIFIED-LONGER-CONTENT", BASE_TIME + 100 * SECOND)
				}),
				remoteMutate(world => world.cloud.controls.movePath("/top/mid", "/top/mid2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// The MODIFIED content must survive somewhere on BOTH sides — never silently replaced by the
		// pre-edit bytes during the inner-rename degradation (that would be BUG-A data loss).
		// Both renames compose: the file lands at /top2/mid2/file.txt with the MODIFIED bytes, and the
		// pre-inner-rename position must NOT linger (the #10 permanent-duplicate + stranded-edit). Strengthened
		// from a `some(size)` check that a duplicate silently passed.
		expect(result.finalRemote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "MODIFIED-LONGER-CONTENT".length })
		expect(result.finalRemote["/top2/mid/file.txt"], "the edit was stranded at the pre-rename path (duplicate)").toBeUndefined()
		expect(result.finalRemote["/top2/mid"], "the pre-inner-rename directory lingered (duplicate)").toBeUndefined()
		expect(result.finalRemote["/top2/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XD3: remote renames OUTER dir + local renames INNER dir → both renames compose, converges (symmetric)", async () => {
		const result = await runScenario({
			name: "XD3",
			mode: "twoWay",
			initialLocal: {
				"/local/top/mid/file.txt": "FILE",
				"/local/top/mid/sib.txt": "S",
				"/local/top/keep.txt": "K"
			},
			steps: [
				runCycle(),
				remoteMutate(world => world.cloud.controls.movePath("/top", "/top2")),
				localMutate(world => renameLocal(world, "top/mid", "top/mid2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		expect(result.finalRemote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "FILE".length })
		expect(result.finalRemote["/top2/mid2/sib.txt"]).toMatchObject({ type: "file", size: "S".length })
		expect(result.finalRemote["/top2/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalRemote["/top"]).toBeUndefined()
		expect(result.finalRemote["/top2/mid"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalLocal["/top2/mid2/file.txt"]!.contentHash).toBe(result.finalRemote["/top2/mid2/file.txt"]!.contentHash)
	})

	// KNOWN LIMITATION (#10) — the symmetric expected-failure of XD2 (see its comment). Pinned under it.fails.
	it.fails("XD4: remote renames OUTER dir + MODIFIES the nested file, local renames INNER dir → the edit survives", async () => {
		const result = await runScenario({
			name: "XD4",
			mode: "twoWay",
			initialLocal: {
				"/local/top/mid/file.txt": "ORIGINAL",
				"/local/top/keep.txt": "K"
			},
			steps: [
				runCycle(),
				remoteMutate(world => {
					world.cloud.controls.movePath("/top", "/top2")
					// Remote re-uploads the nested file with new content (a new uuid) at its post-outer-rename path.
					world.cloud.controls.updateFile("/top2/mid/file.txt", "REMOTE-MODIFIED-LONGER", { mtimeMs: BASE_TIME + 200 * SECOND })
				}),
				localMutate(world => renameLocal(world, "top/mid", "top/mid2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Both renames compose: the file lands at /top2/mid2/file.txt with the REMOTE-modified bytes, and the
		// pre-inner-rename position must NOT linger (the #10 duplicate). Strengthened from a `some(size)` check.
		expect(result.finalRemote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "REMOTE-MODIFIED-LONGER".length })
		expect(result.finalRemote["/top2/mid/file.txt"], "the edit was stranded at the pre-rename path (duplicate)").toBeUndefined()
		expect(result.finalRemote["/top2/mid"], "the pre-inner-rename directory lingered (duplicate)").toBeUndefined()
		expect(result.finalRemote["/top2/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XD5: after a nested cross-side dir-rename converges, an extra cycle is a no-op (stability)", async () => {
		const result = await runScenario({
			name: "XD5",
			mode: "twoWay",
			initialLocal: {
				"/local/top/mid/file.txt": "FILE",
				"/local/top/keep.txt": "K"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "top", "top2")),
				remoteMutate(world => world.cloud.controls.movePath("/top/mid", "/top/mid2")),
				runCycle(),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		const lastCycleKinds = transferKinds(result.cycles[result.cycles.length - 1]!.messages)

		expect(lastCycleKinds).not.toContain("upload")
		expect(lastCycleKinds).not.toContain("download")
		expect(lastCycleKinds).not.toContain("renameRemoteDirectory")
		expect(lastCycleKinds).not.toContain("renameLocalDirectory")
		expect(result.finalRemote["/top2/mid2/file.txt"]).toMatchObject({ type: "file", size: "FILE".length })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})

	it("XD6: localToCloud — local renames OUTER dir, a foreign remote INNER rename does not break the mirror", async () => {
		const result = await runScenario({
			name: "XD6",
			mode: "localToCloud",
			initialLocal: {
				"/local/top/mid/file.txt": "FILE",
				"/local/top/keep.txt": "K"
			},
			steps: [
				runCycle(),
				localMutate(world => renameLocal(world, "top", "top2")),
				remoteMutate(world => world.cloud.controls.movePath("/top/mid", "/top/mid2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Local is authoritative: the remote must mirror the LOCAL structure (inner dir kept its local name "mid").
		expect(result.finalRemote["/top2/mid/file.txt"]).toMatchObject({ type: "file", size: "FILE".length })
		expect(result.finalRemote["/top2/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalRemote["/top2/mid2"]).toBeUndefined()
		expect(result.finalRemote["/top"]).toBeUndefined()
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
