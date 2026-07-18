import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"

/**
 * Deep directory nesting and long paths must SYNC, not be silently dropped. Field reports of "150 GB
 * missing / is there a limit to how many directories deep it can sync" trace to the path-length pre-filter
 * (`isPathOverMaxLength`) rejecting paths a conservative platform guess deemed too long even though the OS +
 * Node can handle them — most acutely the old 512 win32 cap. These build a structure whose ABSOLUTE path
 * exceeds 512 characters and assert it converges in BOTH directions and then settles (no churn). On the
 * win32 CI leg this is a direct regression for the raised cap (dropped at 512, synced at 32767); on
 * posix legs it is a general deep-nesting robustness check well under PATH_MAX. add-only.
 */
function deepRelativePath(levels: number, segment: string, leaf: string): string {
	return `${Array.from({ length: levels }, () => segment).join("/")}/${leaf}`
}

describe("Deep nesting / long paths must sync (not be silently dropped)", () => {
	// 40 levels × a 12-char segment ≈ a 520-char relative path; with the "/local" root the ABSOLUTE path is
	// well over 512 (exercising the old win32 cap) yet comfortably under macOS 1024 / Linux 4096.
	const DEEP = deepRelativePath(40, "subdirectory", "deep-file.txt")

	it("DEEP1: a locally-created deeply-nested file uploads and then settles", async () => {
		const result = await runScenario({
			name: "DEEP1",
			mode: "twoWay",
			initialLocal: { [`/local/${DEEP}`]: { content: "deep-content", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalRemote[`/${DEEP}`]).toMatchObject({ type: "file", size: "deep-content".length })
		expect(result.finalLocal[`/${DEEP}`]).toMatchObject({ type: "file" })
		// Settled: the last two cycles are complete no-ops (no re-upload of the deep tree).
		for (const cycle of result.cycles.slice(-2)) {
			expect(allOps(cycle.messages)).toEqual([])
		}
	})

	it("DEEP2: a remotely-created deeply-nested file downloads and then settles", async () => {
		const result = await runScenario({
			name: "DEEP2",
			mode: "twoWay",
			initialRemote: { [`/${DEEP}`]: { content: "from-cloud", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		expect(result.finalLocal[`/${DEEP}`]).toMatchObject({ type: "file", size: "from-cloud".length })
		expect(result.finalRemote[`/${DEEP}`]).toMatchObject({ type: "file" })
		for (const cycle of result.cycles.slice(-2)) {
			expect(allOps(cycle.messages)).toEqual([])
		}
	})
})
