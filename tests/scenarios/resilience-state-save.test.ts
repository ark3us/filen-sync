import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, control, restart } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps, transferOps } from "../harness/snapshot"
import { writeLocalAt } from "../harness/mutations"
import { makeErrnoError } from "../fakes/virtual-fs"

/**
 * Resilience — STATE-SAVE I/O failure. On a flaky network share (the Synology-over-SMB setups in the field),
 * writing the persisted base (four files, tmp + atomic move) can fail or be interrupted. The investigation
 * linked this to the freeze↔re-upload symptom: a crash mid-save → a partial/absent on-disk base → the next
 * start re-derives everything → a mass re-transfer. These pin the two invariants that keep that from
 * happening: (1) a save failure mid-session must NOT churn — the in-memory base carries the cycle forward, so
 * the next cycle is still a no-op; (2) even a fully LOST base (a "clear cache / force sync", or a crash before
 * any good save) must re-derive WITHOUT re-transferring unchanged content. add-only.
 */
const PAIR_UUID = "resilience-fixed-uuid"
const STATE_PATH = `/db/state/v2/${PAIR_UUID}` // dbPath "/db" + state/v<STATE_VERSION>/<pair uuid>

describe("Resilience — persisted-base save failures", () => {
	it("RES1: a state-save I/O failure mid-session does not cause a re-upload (in-memory base carries forward)", async () => {
		const result = await runScenario({
			name: "RES1",
			mode: "twoWay",
			uuid: PAIR_UUID,
			initialLocal: { "/local/a.txt": { content: "a", mtimeMs: BASE_TIME } },
			steps: [
				runCycle(), // initial sync of a.txt
				// The NEXT save will fail (EIO on the state directory — an SMB write hiccup).
				control(world => world.vfs.controls.setError(STATE_PATH, makeErrnoError("EIO", "state dir unavailable"))),
				localMutate(world => writeLocalAt(world, "b.txt", "bbbb", BASE_TIME + 5000)),
				runCycle(), // uploads b.txt; base advances IN MEMORY; state.save() then throws (caught → cycleError)
				// The share recovers.
				control(world => world.vfs.controls.clearError(STATE_PATH)),
				runCycle(), // must be a no-op — the in-memory base already has b.txt
				runCycle()
			]
		})

		// b.txt did upload despite the save failure (data moved), and both files are present on both sides.
		expect(result.finalRemote["/b.txt"]).toMatchObject({ type: "file", size: 4 })
		expect(result.finalLocal).toEqual(result.finalRemote)

		// The two cycles AFTER the failed save do no work — the failed persist did not resurrect b.txt as "new".
		for (const cycle of result.cycles.slice(-2)) {
			expect(allOps(cycle.messages), "a re-upload followed the failed state save").toEqual([])
		}
	})

	it("RES2: a fully LOST base (wiped state + restart) re-derives WITHOUT re-transferring unchanged content", async () => {
		const result = await runScenario({
			name: "RES2",
			mode: "twoWay",
			uuid: PAIR_UUID,
			initialLocal: {
				"/local/one.txt": { content: "one", mtimeMs: BASE_TIME },
				"/local/dir/two.txt": { content: "two", mtimeMs: BASE_TIME }
			},
			steps: [
				runCycle(), // sync both files; the cloud now stores the same mtimes
				runCycle(), // settle
				// Simulate the base being lost — a "clear cache / force sync", or a crash before a good save.
				control(world => world.vfs.ifs.rmSync("/db/state", { recursive: true, force: true })),
				restart(), // reload from disk → no state files → the base is treated as empty
				runCycle(), // re-derive from an empty base: identical same-mtime content must NOT re-transfer
				runCycle()
			]
		})

		// No data lost, sides identical.
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(result.finalRemote["/one.txt"]).toMatchObject({ type: "file" })
		expect(result.finalRemote["/dir/two.txt"]).toMatchObject({ type: "file" })

		// The re-derivation transferred NOTHING — a lost base does not amplify into a mass re-upload/download.
		const postRestartCycles = result.cycles.slice(-2)

		for (const cycle of postRestartCycles) {
			expect(transferOps(cycle.messages), "a lost base re-transferred unchanged content").toEqual([])
		}
	})
})
