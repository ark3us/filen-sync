import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate, remoteMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"
import { renameLocal } from "../harness/mutations"

/**
 * Case-insensitive MATCHING (whole path). The backend is case-insensitive, so a path that differs only in
 * casing between the local disk and the cloud is the SAME item — it must NOT read as "present here, absent
 * there" and churn (endless upload / download / delete). This is distinct from an ACTIVE case-only RENAME
 * (covered by Category ZQ), which is a real change of a stable identity and DOES propagate: matching folds
 * the case, rename detection does not. These probe the steady-state divergence with NO active rename —
 * a fresh sync, lost/cleared state, or a cross-device divergence — where the two sides simply hold the same
 * file under different casing and nothing should move.
 *
 * Regression: reported as "one folder is uploaded continuously; as soon as it finishes it starts again".
 */
describe("Case-insensitive matching — steady-state case divergence must not churn", () => {
	it("CI1: a file with only a case difference between disk and cloud does not transfer", async () => {
		const result = await runScenario({
			name: "CI1",
			mode: "twoWay",
			// Same bytes, same whole-second mtime — the ONLY difference is the casing of the file name.
			initialLocal: { "/local/report.txt": { content: "same-bytes", mtimeMs: BASE_TIME } },
			initialRemote: { "/Report.txt": { content: "same-bytes", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		// Not a single operation in any cycle — the two are one item, just cased differently.
		for (const [index, cycle] of result.cycles.entries()) {
			expect(allOps(cycle.messages), `cycle ${index + 1} churned on a case-divergent file`).toEqual([])
		}
		// And the file still exists on both sides (no data loss from a spurious delete).
		expect(result.finalRemote["/Report.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/report.txt"]).toMatchObject({ type: "file" })
	})

	it("CI3: on a case-insensitive volume, a case-divergent file is not physically deleted (no data loss)", async () => {
		// This is the faithful reproduction memfs (case-sensitive) cannot express: on a real case-insensitive
		// volume, disk "report.txt" and cloud "Report.txt" are the SAME physical file, so a spurious
		// deleteLocalFile("/Report.txt") would DELETE the user's file. The fix folds the match so no delete is
		// ever emitted; here we additionally prove the physical file survives on a genuinely case-insensitive fs.
		const result = await runScenario({
			name: "CI3",
			mode: "twoWay",
			caseInsensitive: true,
			initialLocal: { "/local/report.txt": { content: "precious", mtimeMs: BASE_TIME } },
			initialRemote: { "/Report.txt": { content: "precious", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		for (const [index, cycle] of result.cycles.entries()) {
			expect(allOps(cycle.messages), `cycle ${index + 1} churned/deleted on a case-insensitive volume`).toEqual([])
		}
		// The physical file (stored casing "report.txt") is intact with its content.
		expect(result.world.vfs.controls.exists("/local/report.txt")).toBe(true)
		expect(result.world.vfs.ifs.readFileSync("/local/report.txt", { encoding: "utf-8" })).toBe("precious")
	})

	it("CI2: a case difference in a PARENT directory does not churn the subtree", async () => {
		const result = await runScenario({
			name: "CI2",
			mode: "twoWay",
			// Parent dir differs in case (disk "sepa", cloud "SEPA"); the child name matches.
			initialLocal: { "/local/sepa/index.html": { content: "<html>x</html>", mtimeMs: BASE_TIME } },
			initialRemote: { "/SEPA/index.html": { content: "<html>x</html>", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		for (const [index, cycle] of result.cycles.entries()) {
			expect(allOps(cycle.messages), `cycle ${index + 1} churned on a case-divergent parent dir`).toEqual([])
		}
		expect(result.finalRemote["/SEPA/index.html"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/sepa/index.html"]).toMatchObject({ type: "file" })
	})

	it("CI4: an active case-only rename on a case-INSENSITIVE volume still propagates and converges", async () => {
		// The real Windows/macOS scenario: a case-only rename on a case-preserving, case-insensitive fs. The
		// rename must reach the cloud (case-sensitive matching in the rename passes) even though ordinary
		// matching folds the case — the two must not fight. Runs on the case-insensitive volume (unlike ZQ).
		const result = await runScenario({
			name: "CI4",
			mode: "twoWay",
			caseInsensitive: true,
			initialLocal: { "/local/readme.txt": { content: "doc", mtimeMs: BASE_TIME } },
			// sync, then rename+propagate, then two settle cycles.
			steps: [runCycle(), localMutate(world => renameLocal(world, "readme.txt", "README.txt")), runCycle(), runCycle(), runCycle()]
		})

		// The rename reached the cloud (renamed, not duplicated) — folding did NOT suppress the propagation.
		expect(result.finalRemote["/README.txt"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalRemote)).not.toContain("/readme.txt")
		// …and it settled: the last two cycles do no work.
		for (const cycle of result.cycles.slice(-2)) {
			expect(allOps(cycle.messages), "case-rename did not settle on a case-insensitive volume").toEqual([])
		}
	})

	it("CI5: a passive case divergence converges and SETTLES in the DIRECTIONAL modes (at most one reconciliation)", async () => {
		for (const mode of ["localToCloud", "cloudToLocal"] as const) {
			const result = await runScenario({
				name: `CI5-${mode}`,
				mode,
				initialLocal: { "/local/data.txt": { content: "same", mtimeMs: BASE_TIME } },
				initialRemote: { "/Data.txt": { content: "same", mtimeMs: BASE_TIME } },
				steps: [runCycle(), runCycle(), runCycle(), runCycle()]
			})

			// A strict mirror may re-assert its authoritative side ONCE (the folded counterpart looks like a
			// foreign edit vs the empty base); what must NOT happen is an endless per-cycle re-transfer.
			for (const cycle of result.cycles.slice(-2)) {
				expect(allOps(cycle.messages), `[${mode}] a case divergence kept churning (not settled)`).toEqual([])
			}
		}
	})

	it("CI6: a remote-side case-only rename propagates DOWN to a case-insensitive local volume and settles", async () => {
		const result = await runScenario({
			name: "CI6",
			mode: "twoWay",
			caseInsensitive: true,
			initialLocal: { "/local/notes.md": { content: "n", mtimeMs: BASE_TIME } },
			steps: [runCycle(), remoteMutate(world => world.cloud.controls.movePath("/notes.md", "/Notes.md")), runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalLocal["/Notes.md"]).toMatchObject({ type: "file" })
		expect(Object.keys(result.finalLocal)).not.toContain("/notes.md")
		for (const cycle of result.cycles.slice(-2)) {
			expect(allOps(cycle.messages), "remote case-rename did not settle on a case-insensitive volume").toEqual([])
		}
	})
})
