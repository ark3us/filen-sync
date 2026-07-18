import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL, LOCAL_RESCAN_SAFETY_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME } from "../harness/world"
import { writeLocal } from "../harness/mutations"
import { snapshotRemote } from "../harness/snapshot"

/**
 * Fix #16 — a lossy-but-ALIVE watcher must not hide a change forever. fs.watch on SMB/NFS (and some FUSE
 * mounts) can silently DROP a change notification, so lastDirectoryChangeTimestamp never moves and the local
 * scan's freshness gate keeps serving the cached tree — the change never syncs. The 60s fallback rescan
 * previously existed ONLY when the watcher failed to START. The gate now also declines to serve a cache older
 * than LOCAL_RESCAN_SAFETY_INTERVAL, forcing a full re-enumeration that catches the dropped change. It is a
 * per-call age check (no recurring timer), so it costs at most one rescan per interval. add-only.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const

describe("Fix #16 — the freshness gate force-rescans a stale cache", () => {
	it("LW1: a mutation with NO watcher signal is caught once the cache ages past the safety window", async () => {
		vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
		vi.setSystemTime(BASE_TIME)

		try {
			const world = await createWorld({ mode: "twoWay", initialLocal: { "/local/seed.txt": "s" } })

			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
			await world.sync.runCycle() // settle; the cache is freshly stamped

			// A change lands on disk but the watcher DROPS its notification: mutate WITHOUT triggerWatcher.
			writeLocal(world, "dropped.txt", "d")

			// Immediately after: the gate still serves the FRESH cache, so the change is invisible (premise).
			await world.sync.runCycle()

			expect(snapshotRemote(world)["/dropped.txt"], "the change was seen without a watcher signal (bad premise)").toBeUndefined()

			// Once the cache ages past the safety window, the next scan re-enumerates and the change syncs.
			await vi.advanceTimersByTimeAsync(LOCAL_RESCAN_SAFETY_INTERVAL + 1)
			await world.sync.runCycle()
			await world.sync.runCycle()

			expect(snapshotRemote(world)["/dropped.txt"], "the dropped change never synced (no safety rescan)").toMatchObject({
				type: "file"
			})
			expect(snapshotRemote(world)["/seed.txt"]).toMatchObject({ type: "file" })
		} finally {
			vi.useRealTimers()
		}
	})
})
