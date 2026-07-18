import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"

/**
 * Fix #11 — the twoWay NO-BASE fallback must not discard the SIZE signal. With no persisted base (a genuine
 * first sync, or lost/corrupt state) and the same path on both sides, "did this side change" falls back to a
 * strictly-newer whole-second mtime. When both sides carry the SAME floored-second mtime but DIFFERENT sizes,
 * neither `localChanged` nor `remoteChanged` fires and `noBaseSizeDiverged` is directional-only — so neither
 * an upload nor a download is emitted and the two provably-different files diverge PERMANENTLY. A size
 * difference is proof the bytes differ, so the fallback now treats it as a change (tie → local, symmetric to
 * the directional modes' noBaseSizeDiverged). add-only.
 */
describe("Fix #11 — twoWay no-base size divergence converges", () => {
	it("NB1: no base, equal-second mtime, different sizes → converges (tie to local)", async () => {
		const result = await runScenario({
			name: "NB1",
			mode: "twoWay",
			initialLocal: { "/local/f.txt": { content: "LOCAL-5", mtimeMs: BASE_TIME } },
			initialRemote: { "/f.txt": { content: "REMOTE-TEN-X", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle()]
		})

		// The size divergence is NOT discarded: the sides converge, and the tie resolves to local (it wins the
		// equal-mtime tiebreak because the local additions pass runs first).
		expect(result.finalLocal["/f.txt"]).toEqual(result.finalRemote["/f.txt"])
		expect(result.finalRemote["/f.txt"], "the local copy did not win the tie").toMatchObject({
			type: "file",
			size: "LOCAL-5".length
		})

		// Converged and settled — no churn.
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "did not settle").toEqual([])
	})

	it("NB2: no base, equal-second mtime, EQUAL sizes → no needless transfer (idempotent)", async () => {
		const result = await runScenario({
			name: "NB2",
			mode: "twoWay",
			initialLocal: { "/local/f.txt": { content: "same-bytes", mtimeMs: BASE_TIME } },
			initialRemote: { "/f.txt": { content: "same-bytes", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle()]
		})

		// Identical content on both sides with no base must NOT be needlessly transferred (the size term must
		// only fire on a real divergence).
		expect(allOps(result.cycles[0]!.messages).filter(op => op.startsWith("upload") || op.startsWith("download"))).toEqual([])
		expect(result.finalLocal["/f.txt"]).toEqual(result.finalRemote["/f.txt"])
	})
})
