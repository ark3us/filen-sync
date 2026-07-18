import { describe, it, expect } from "vitest"
import { runScenario, runCycle, localMutate } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { touchLocal } from "../harness/mutations"
import { transferKinds } from "../harness/snapshot"

/**
 * Fix #19 — a bare mtime touch on a DOWNLOADED file must not re-upload unchanged bytes. The md5 dedup that
 * suppresses a no-content-change re-upload keyed off localFileHashes, which was populated only on UPLOAD. A
 * downloaded file therefore had no cached hash, so `md5 !== cache` (cache undefined) was always true and a
 * bare touch (mtime moved, bytes identical) re-uploaded the whole file. The download now caches the file's
 * md5 under the same key, so the dedup recognises the unchanged content. add-only.
 */
const SECOND = 1000

describe("Fix #19 — downloaded file hash is cached (no re-upload on a bare touch)", () => {
	it("DL1: touching a downloaded file's mtime (same bytes) does NOT re-upload it", async () => {
		const result = await runScenario({
			name: "DL1",
			mode: "twoWay",
			initialRemote: { "/f.txt": { content: "downloaded-bytes", mtimeMs: BASE_TIME } },
			steps: [
				runCycle(),
				runCycle(), // settle: /f.txt is downloaded to local and (with the fix) its md5 is cached
				// A bare mtime touch — the content is byte-identical, only the mtime moved.
				localMutate(world => touchLocal(world, "f.txt", BASE_TIME + 100 * SECOND)),
				runCycle()
			]
		})

		// The touch must NOT re-upload the unchanged bytes.
		const touchCycle = result.cycles[2]!

		expect(
			transferKinds(touchCycle.messages).filter(op => op.startsWith("upload")),
			"a bare touch on a downloaded file re-uploaded unchanged bytes"
		).toEqual([])
		// The content is untouched on both sides (only the local mtime moved, which a bare touch legitimately
		// leaves un-propagated — the point is that no re-upload happened).
		expect(result.finalLocal["/f.txt"]!.contentHash).toBe(result.finalRemote["/f.txt"]!.contentHash)
	})
})
