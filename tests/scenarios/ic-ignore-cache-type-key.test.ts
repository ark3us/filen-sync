import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { rmLocal, writeLocal } from "../harness/mutations"

/**
 * Fix #7 — the local isPathIgnored cache must be keyed by path AND type. A dir-only rule like `build/`
 * ignores `build` as a DIRECTORY but not as a FILE, yet the cache was keyed by path alone. Once a `build`
 * directory was scanned and cached `{ignored:true}` under key `build`, replacing it with a same-named FILE
 * reused that stale verdict — the file was then silently never synced for the whole session (the rule is
 * stable, so the cache is never invalidated). Re-opens BUG-005; the remote side was already type-keyed. This
 * pins the fix: the same-named file must sync. add-only.
 */
describe("Fix #7 — isPathIgnored cache is type-aware", () => {
	it("IC1: a dir-only rule caches the dir verdict, but a same-named FILE replacing it still syncs", async () => {
		const result = await runScenario({
			name: "IC1",
			mode: "twoWay",
			filenIgnore: "build/",
			initialLocal: {
				"/local/build/artifact.o": "obj",
				"/local/keep.txt": "k"
			},
			steps: [
				runCycle(), // /build (dir) is ignored → caches {ignored:true} under the `build` key
				runCycle(),
				// Replace the ignored DIRECTORY with a same-named FILE. The dir-only rule does NOT ignore a file,
				// so it must sync — but a path-only cache returns the stale directory verdict and drops it.
				localMutate(world => {
					rmLocal(world, "build")
					writeLocal(world, "build", "i-am-now-a-file")
				}),
				runCycle(),
				runCycle()
			]
		})

		// The same-named file is NOT ignored by the dir-only rule → it syncs to the remote.
		expect(result.finalRemote["/build"], "a same-named file was dropped by the stale dir verdict").toMatchObject({ type: "file" })
		expect(result.finalLocal["/build"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
		// The directory's former contents stay ignored (never synced).
		expect(result.finalRemote["/build/artifact.o"]).toBeUndefined()
	})

	it("IC2: the directory form is STILL ignored (the fix does not weaken the dir-only rule)", async () => {
		const result = await runScenario({
			name: "IC2",
			mode: "twoWay",
			filenIgnore: "build/",
			initialLocal: {
				"/local/build/x.o": "obj",
				"/local/keep.txt": "k"
			},
			steps: [runCycle(), runCycle()]
		})

		// The build/ directory and its contents remain ignored.
		expect(result.finalRemote["/build"]).toBeUndefined()
		expect(result.finalRemote["/build/x.o"]).toBeUndefined()
		expect(result.finalRemote["/keep.txt"]).toMatchObject({ type: "file" })
	})
})
