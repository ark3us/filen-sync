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
 * /top/mid → /top/mid2. The correct merge applies BOTH renames (→ /top2/mid2/...). The cross-blocked inner
 * rename would MISS at detection — its source lookup keys off the base path, but the other side's outer
 * rename has already moved that subtree — so each rename pass rebases its cross-side source lookup (and the
 * emitted from/to) across the OTHER side's directory renames, and the base tree is rebased off the base-path
 * `from` (rebase{Local,Remote}TreeAcrossRenames + rebasePathAcrossRenames), COMPOSING the two renames into a
 * single move on each side — a path neither ZB (descendant change) nor ZW (child rename) reaches.
 *
 * Critical safety: when the deeply-nested file is ALSO modified on the renaming side, the composition must NOT
 * strand the edit at the pre-rename path or duplicate it (the BUG-A / #10 class). XD2/XD4 guard that — the
 * modified content must land at the composed path on both sides with no lingering copy.
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

	// #10 (FIXED) — a cross-side nested dir-rename where the file is ALSO modified on the renaming side. This
	// previously left a permanent DUPLICATE: the modified edit stranded at the pre-inner-rename path AND a copy
	// at the composed path. Root cause: the remote inner rename was dropped at DETECTION because its local-source
	// lookup used the pre-outer-rename path and missed (the local outer rename had already moved it), so the move
	// decomposed into delete+add and the local modify preserved the old path. The rename passes now rebase their
	// cross-side source lookup (and the emitted from/to) across the OTHER side's directory renames, and the base
	// tree is rebased off the base-path `from`, so both renames compose to /top2/mid2 with the modified bytes and
	// no lingering pre-rename path. The base case WITHOUT the modify is XD1/XD3/XD5/XD6.
	it("XD2: local renames OUTER dir + MODIFIES the nested file, remote renames INNER dir → the edit survives (no BUG-A loss)", async () => {
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

	// #10 (FIXED) — the symmetric case of XD2 (see its comment): remote renames the OUTER dir, local renames the
	// INNER dir. The pass-1 (local-rename) source lookup rebases across the remote's own directory renames to
	// compose both renames.
	it("XD4: remote renames OUTER dir + MODIFIES the nested file, local renames INNER dir → the edit survives", async () => {
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

	it("XD7: composition holds across DEEPER nesting — outer rename + a 3-levels-down inner rename + modify (#10)", async () => {
		const result = await runScenario({
			name: "XD7",
			mode: "twoWay",
			initialLocal: {
				"/local/a/b/c/deep.txt": "ORIGINAL",
				"/local/a/b/keep.txt": "K"
			},
			steps: [
				runCycle(),
				runCycle(), // settle: base holds /a/b/c/deep.txt + /a/b/keep.txt
				localMutate(world => {
					// Rename the OUTER dir /a -> /a2 and modify the file that lives THREE levels down.
					renameLocal(world, "a", "a2")
					writeLocalAt(world, "a2/b/c/deep.txt", "MODIFIED-DEEP-LONGER", BASE_TIME + 100 * SECOND)
				}),
				// Remote renames the DEEP inner dir /a/b/c -> /a/b/c2 (a different level than the local rename).
				remoteMutate(world => world.cloud.controls.movePath("/a/b/c", "/a/b/c2")),
				runCycle(),
				runCycle(),
				runCycle()
			]
		})

		// Both renames compose across the two intermediate levels: the modified file lands at /a2/b/c2/deep.txt
		// with the new bytes, and neither pre-rename position lingers.
		expect(result.finalRemote["/a2/b/c2/deep.txt"]).toMatchObject({ type: "file", size: "MODIFIED-DEEP-LONGER".length })
		expect(result.finalRemote["/a2/b/keep.txt"]).toMatchObject({ type: "file", size: "K".length })
		expect(result.finalRemote["/a2/b/c/deep.txt"]).toBeUndefined()
		expect(result.finalRemote["/a2/b/c"]).toBeUndefined()
		expect(result.finalRemote["/a"]).toBeUndefined()
		expect(result.finalRemote["/a2/b/c2/deep.txt"]!.contentHash).toBe(result.finalLocal["/a2/b/c2/deep.txt"]!.contentHash)
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
