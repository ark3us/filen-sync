import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { allOps } from "../harness/snapshot"

/**
 * Fix #15 — the local scan's trash-directory skip used a SUBSTRING match (`entryPath.includes(".filen.trash
 * .local")`), so any user path merely CONTAINING the trash name mid-path was dropped from the scan. The remote
 * build skips by basename boundary (`name.startsWith`), so the remote KEEPS such a file while the local drops
 * it: cloudToLocal re-downloads it every cycle (the local scan drops it again) and never converges. The local
 * skip now matches the remote (basename-startsWith), plus the actual trash-root descendants. add-only.
 */
describe("Fix #15 — trash-name substring no longer drops user files", () => {
	it("TR1: cloudToLocal, a file CONTAINING the trash name mid-name converges (not endlessly re-downloaded)", async () => {
		const result = await runScenario({
			name: "TR1",
			mode: "cloudToLocal",
			initialRemote: { "/notes/x.filen.trash.local.txt": { content: "data", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle(), runCycle()]
		})

		// The file is pulled down and STAYS (the local scan no longer drops it), so the sides converge.
		expect(result.finalLocal["/notes/x.filen.trash.local.txt"], "the file was dropped by the substring trash skip").toMatchObject({
			type: "file"
		})
		expect(result.finalRemote["/notes/x.filen.trash.local.txt"]).toMatchObject({ type: "file" })
		// No re-download loop: the final cycle is a clean no-op.
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "the pair never settled (re-download loop)").toEqual([])
	})

	it("TR2: twoWay, a local file CONTAINING the trash name mid-name uploads and converges", async () => {
		const result = await runScenario({
			name: "TR2",
			mode: "twoWay",
			initialLocal: { "/local/data/report.filen.trash.local.bin": { content: "important", mtimeMs: BASE_TIME } },
			steps: [runCycle(), runCycle()]
		})

		// A mid-name match must not stop a legit local file from being backed up.
		expect(result.finalRemote["/data/report.filen.trash.local.bin"]).toMatchObject({ type: "file" })
		expect(result.finalLocal).toEqual(result.finalRemote)
	})
})
