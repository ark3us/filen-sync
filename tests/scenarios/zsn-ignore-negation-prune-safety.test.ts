import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control } from "../harness/runner"
import { writeLocal } from "../harness/mutations"

/**
 * Fix #2 (end-to-end) — the standard "ignore all X, keep this one" idiom must sync the re-included subtree
 * and, critically, must NEVER delete an already-synced cloud copy of it.
 *
 *     node_modules
 *     !keep/node_modules/
 *
 * The bare `node_modules` rule used to emit a `**`-prefixed traversal-prune glob that dropped `keep/node_modules`
 * from the local scan even though the matcher KEEPS it. On a fresh sync that meant no backup; over a settled
 * base it meant the subtree looked deleted and its cloud copy was trashed (the "files gone after editing
 * .filenignore" field class). Companion unit coverage:
 * tests/unit/ignorer-traversal-prune-negation.test.ts. add-only.
 */
describe("Fix #2 — negation-safe traversal pruning (scenario)", () => {
	it("ZSN1: a `!keep/node_modules/` re-included subtree reaches the cloud; top-level node_modules stays ignored", async () => {
		const result = await runScenario({
			name: "ZSN1",
			mode: "twoWay",
			filenIgnore: "node_modules\n!keep/node_modules/",
			initialLocal: {
				"/local/app.js": "a",
				"/local/node_modules/dep.js": "d",
				"/local/keep/node_modules/lib.js": "L",
				"/local/keep/node_modules/nested/deep.js": "D"
			},
			steps: [runCycle(), runCycle()]
		})

		// The re-included subtree is backed up...
		expect(result.finalRemote["/keep/node_modules/lib.js"], "re-included subtree was pruned from the scan").toMatchObject({
			type: "file"
		})
		expect(result.finalRemote["/keep/node_modules/nested/deep.js"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/app.js"]).toMatchObject({ type: "file" })
		// ...while the top-level node_modules stays ignored.
		expect(result.finalRemote["/node_modules/dep.js"]).toBeUndefined()
		// Every synced path is identical on both sides (ignored files legitimately remain local-only).
		for (const remotePath of Object.keys(result.finalRemote)) {
			expect(result.finalLocal[remotePath]).toEqual(result.finalRemote[remotePath])
		}
	})

	it("ZSN2: introducing the idiom AFTER the subtree was synced does NOT delete the re-included cloud copy", async () => {
		const result = await runScenario({
			name: "ZSN2",
			mode: "twoWay",
			initialLocal: {
				"/local/keep/node_modules/lib.js": "L",
				"/local/keep/node_modules/nested/deep.js": "D",
				"/local/other.txt": "O"
			},
			steps: [
				// 1) Sync everything up with no ignore — the cloud + base now hold the whole keep/node_modules subtree.
				runCycle(),
				// 2) Add the "ignore all node_modules, keep this one" idiom, then force a rescan (which prunes).
				control(world => world.sync.ignorer.update("node_modules\n!keep/node_modules/")),
				localMutate(world => writeLocal(world, "trigger.txt", "t")),
				runCycle(),
				runCycle()
			]
		})

		// The re-included subtree is KEPT by the matcher, so its cloud copy must survive the rescan — a bare-name
		// prune that dropped it would read as a deletion and trash the backup.
		expect(result.finalRemote["/keep/node_modules/lib.js"], "re-included cloud copy was deleted by the prune").toMatchObject({
			type: "file"
		})
		expect(result.finalRemote["/keep/node_modules/nested/deep.js"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/keep/node_modules/lib.js"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/other.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/trigger.txt"]).toMatchObject({ type: "file" })
	})
})
