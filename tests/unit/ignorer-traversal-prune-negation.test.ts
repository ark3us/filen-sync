import { describe, it, expect } from "vitest"
import micromatch from "micromatch"
import { createWorld, type World } from "../harness/world"

/**
 * Fix #2 — the traversal-prune globs must stay a strict SUBSET of the matcher's ignored set even in the
 * presence of a negation that re-includes a DEEPER instance of an ignored bare name. The classic idiom
 *
 *     node_modules
 *     !keep/node_modules/
 *
 * ("ignore every node_modules, keep this one") re-includes the `keep/node_modules` subtree — the matcher
 * KEEPS it — yet the bare-name rule emitted a `**`-prefixed prune glob whose leading `**` applies the prune
 * at EVERY depth and so silently drops the re-included subtree from the local scan (→ no backup, and a
 * base-seeded copy is deleted from the cloud). The probe only ever checked the top-level form
 * (`node_modules/`), which is ignored, so the danger at depth-1 went unseen.
 *
 * These assert the CONTRACT directly (via the same micromatch/dot semantics FastGlob prunes with), not the
 * fix mechanism: for any path the live matcher KEEPS, no emitted glob may match it. add-only.
 */
async function worldFor(filenIgnore: string): Promise<World> {
	const world = await createWorld({ mode: "twoWay", filenIgnore })

	await world.sync.ignorer.initialize()

	return world
}

/**
 * Assert the traversal-prune set never drops a path the matcher keeps. FastGlob prunes an entry when its
 * relative posix path matches an `ignore` glob under `{ dot: true }` (the local scan's option), so we use
 * exactly that to detect a wrong prune.
 */
function expectNotWronglyPruned(world: World, keptPath: string): void {
	// Sanity: the fixture is only meaningful if the matcher actually KEEPS this path.
	expect(world.sync.ignorer.ignores(keptPath), `fixture invalid — matcher already ignores ${keptPath}`).toBe(false)

	const globs = world.sync.ignorer.globIgnorePatternsForTraversal()
	const wronglyPruning = globs.filter(glob => micromatch.isMatch(keptPath, glob, { dot: true }))

	expect(wronglyPruning, `traversal-prune globs drop matcher-kept ${keptPath}: ${JSON.stringify(wronglyPruning)}`).toEqual([])
}

describe("Fix #2 — traversal-prune negation is subset-safe", () => {
	it("bare `node_modules` + `!keep/node_modules/` does not prune the re-included subtree", async () => {
		const world = await worldFor("node_modules\n!keep/node_modules/")

		expectNotWronglyPruned(world, "keep/node_modules/lib.js")
		expectNotWronglyPruned(world, "keep/node_modules/nested/deep.js")
	})

	it("bare `cache` + `!foo/cache/` does not prune the re-included subtree", async () => {
		const world = await worldFor("cache\n!foo/cache/")

		expectNotWronglyPruned(world, "foo/cache/data.bin")
	})

	it("the file-form negation `!keep/node_modules` (no trailing slash) is equally subset-safe", async () => {
		const world = await worldFor("node_modules\n!keep/node_modules")

		expectNotWronglyPruned(world, "keep/node_modules/lib.js")
	})

	// --- regression guards: the safe, common cases must STILL prune (no optimization lost) ---

	it("REGRESSION: a plain bare name with no matching negation still prunes at all depths", async () => {
		const world = await worldFor("node_modules")
		const globs = world.sync.ignorer.globIgnorePatternsForTraversal()

		expect(globs).toContain("**/node_modules")
		expect(globs).toContain("**/node_modules/**/*")
	})

	it("REGRESSION: an unrelated negation does not disable pruning of a different name", async () => {
		const world = await worldFor("node_modules\n!src/keep.txt")
		const globs = world.sync.ignorer.globIgnorePatternsForTraversal()

		// keep.txt shares no basename with node_modules → node_modules pruning is untouched.
		expect(globs).toContain("**/node_modules/**/*")
	})

	it("REGRESSION: an ignored dir with a forbidden-reinclude child still prunes (gitignore parent rule)", async () => {
		const world = await worldFor("build/\n!build/keep.txt")

		// The child stays ignored (parent excluded → re-include forbidden), so the whole subtree is safe to prune.
		expect(world.sync.ignorer.ignores("build/keep.txt")).toBe(true)
		expect(world.sync.ignorer.globIgnorePatternsForTraversal()).toContain("**/build/**/*")
	})
})
