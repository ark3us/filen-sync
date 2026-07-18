import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type FilenSDK from "@filen/sdk"
import { E2E_ENABLED, loginTestSDK, teardownTestSDK } from "./harness/account"
import { withE2EWorld } from "./harness/world"
import { settle, cycle, allOps } from "./harness/drive"
import { snapshotRemoteReal } from "./harness/assert"
import { writeLocal, uploadRemote, existsLocal, renameLocal, readLocal } from "./harness/mutations"

/**
 * Live parity for case-insensitive MATCHING (mocked: case-insensitive-matching.test.ts CI1–CI3). The backend
 * is case-insensitive, so a path that differs only in casing between the local disk and the cloud is the SAME
 * item and must never churn. The field reports were an endless re-upload ("a folder that never changes is
 * uploaded continuously"); the failure signature is a settled tree that keeps transferring, so the live
 * assertion is IDEMPOTENCE: after convergence, further cycles are complete no-ops. Runs against the real
 * backend + the runner's real filesystem (case-insensitive on the macOS/Windows legs, case-sensitive on
 * Linux — the backend's case-insensitivity makes the outcome identical on all three). Add-only.
 */
describe.skipIf(!E2E_ENABLED)("E2E — case-insensitive matching", () => {
	let sdk: FilenSDK

	beforeAll(async () => {
		sdk = await loginTestSDK()
	}, 1_800_000)

	afterAll(async () => {
		await teardownTestSDK()
	})

	it("CI-live-1: disk and cloud holding the same file under different casing does not loop", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			// Independently seed the SAME file under DIFFERENT casing on each side (a fresh cross-device
			// divergence — no rename event links them), same bytes.
			await uploadRemote(world, "Report.txt", "identical-bytes")
			await writeLocal(world, "report.txt", "identical-bytes")

			await settle(world)

			// After settling, two more no-mutation cycles must be COMPLETE no-ops — no endless re-upload.
			expect(allOps(await cycle(world)), "settled probe #1 was not a no-op").toEqual([])
			expect(allOps(await cycle(world)), "settled probe #2 was not a no-op").toEqual([])

			// And the user's local file is intact (a spurious case-variant delete would have removed it).
			expect(await existsLocal(world, "report.txt")).toBe(true)
			expect(await readLocal(world, "report.txt")).toBe("identical-bytes")
		})
	}, 1_800_000)

	it("CI-live-2: an ACTIVE case-only rename still propagates (matching folds, rename does not)", async () => {
		await withE2EWorld({ sdk, mode: "twoWay" }, async world => {
			await writeLocal(world, "notes.txt", "n")
			await settle(world)

			// A real case-only rename is a genuine change of a stable identity — it must reach the cloud.
			await renameLocal(world, "notes.txt", "Notes.txt")
			await settle(world)

			const remote = await snapshotRemoteReal(world)

			expect(remote["/Notes.txt"]).toMatchObject({ type: "file" })
			expect(remote["/notes.txt"]).toBeUndefined()

			// And it settles — no churn afterwards.
			expect(allOps(await cycle(world)), "post-rename cycle was not a no-op").toEqual([])
		})
	}, 1_800_000)
})
