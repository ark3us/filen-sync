import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME } from "../harness/world"
import { writeLocal } from "../harness/mutations"
import { snapshotRemote } from "../harness/snapshot"

/**
 * Fix #8 — pausing mid-cycle must RELEASE the account lock, not hold it until resume. The per-task pause gate
 * (waitForPause) BLOCKED every not-yet-started task until resume, but it runs INSIDE the cycle, which holds
 * the auto-refreshing account lock — so a pause starved every OTHER device on the account (none could sync)
 * for the entire pause. Now a paused task is SKIPPED (not blocked): the cycle returns and its finally releases
 * the lock, and the cycle declines to advance its base so the skipped work is redone after resume rather than
 * being folded into the base and forgotten. add-only.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const

describe("Fix #8 — pausing mid-cycle releases the account lock", () => {
	it("PL1: a pause set during a cycle lets it complete (lock freed) and the skipped work is redone on resume", async () => {
		vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
		vi.setSystemTime(BASE_TIME)

		try {
			const world = await createWorld({ mode: "twoWay", initialLocal: { "/local/seed.txt": "s" } })

			// Settle the base.
			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
			await world.sync.runCycle()

			// Queue real upload work for the next cycle.
			writeLocal(world, "new1.txt", "a")
			writeLocal(world, "new2.txt", "b")
			world.triggerWatcher()

			// Start the cycle and pause it before it reaches the task phase. runCycle() runs synchronously through
			// the pre-cycle pause check (which passed with paused=false) and only yields at its first await, so
			// setting paused now makes it true throughout the task phase — the tasks are skipped.
			const cyclePromise = world.sync.runCycle()

			let settled = false

			void cyclePromise.then(() => {
				settled = true
			})

			world.sync.paused = true

			// Let the in-cycle local-change debounce elapse; the cycle then reaches the (paused) task phase, skips
			// its tasks, completes, and its finally releases the lock. Without the fix the tasks block in
			// waitForPause forever and the cycle never resolves — even as timers advance.
			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL * 3 + 1)

			expect(settled, "the paused cycle held the account lock and never released it").toBe(true)

			// The base was NOT advanced past the skipped uploads, so resuming and cycling actually performs them
			// (had the base folded them in, they would be silently forgotten and never sync).
			world.sync.paused = false
			world.triggerWatcher()

			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
			await world.sync.runCycle()
			await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
			await world.sync.runCycle()

			const remote = snapshotRemote(world)

			expect(remote["/new1.txt"], "the skipped upload was forgotten (base advanced past it)").toMatchObject({ type: "file" })
			expect(remote["/new2.txt"]).toMatchObject({ type: "file" })
			expect(remote["/seed.txt"]).toMatchObject({ type: "file" })
		} finally {
			vi.useRealTimers()
		}
	})
})
