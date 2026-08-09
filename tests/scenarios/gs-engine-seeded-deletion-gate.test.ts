import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotLocal, snapshotRemote, messagesOfType } from "../harness/snapshot"
import { rmLocal } from "../harness/mutations"

/**
 * Fix #4 — the large-deletion confirmation gate must fire even when the base was SEEDED BY THE ENGINE's own
 * transfers (an upload-only or download-only first sync), not just when it was observed from the opposite
 * side. The engine's transfer handlers mutate the live directory-tree cache's `.tree` in place but never its
 * `.size`, so the end-of-cycle base snapshot copied a stale `size` (0) that disagreed with a fully-populated
 * `.tree`. The gate's `previousTree.size > 0` guard then never fired, silently bypassing the opt-in safety
 * net in the universal first-sync case — both sides emptied with no prompt. (state.ts already recomputes the
 * size from the tree on RELOAD, so a restart masked the bug; this pins the in-process path.)
 *
 * G3 in g-large-deletion.test.ts documents the same limitation ("an upload-only cycle would leave
 * previousRemote.size at 0 and the prompt could never fire") and worked around it with initialRemote — these
 * assert the previously-impossible upload-only and download-only cases now behave. add-only.
 */
const FAKE_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const

async function withWorld(options: CreateWorldOptions, body: (world: World) => Promise<void>): Promise<void> {
	vi.useFakeTimers({ toFake: [...FAKE_TIMERS] })
	vi.setSystemTime(BASE_TIME)

	try {
		const world = await createWorld(options)

		await body(world)
	} finally {
		vi.useRealTimers()
	}
}

async function plainCycle(world: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	await world.sync.runCycle()
}

async function cycleWithDecision(world: World, decision: "delete" | "restart"): Promise<void> {
	// The gate does not block: the first cycle posts the prompt and defers the gated deletions, the
	// answer is recorded, and the NEXT cycle consumes it (applying the deletions for "delete").
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
	await world.sync.runCycle()

	world.worker.confirmDeletion(world.syncPair.uuid, decision)

	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)
	await world.sync.runCycle()
}

function confirmDeletionCount(world: World): number {
	return messagesOfType(world.messages, "confirmDeletion").length
}

describe("Fix #4 — engine-seeded base triggers the large-deletion gate", () => {
	it("GS1: an upload-only first sync still prompts when the remote is later emptied (where: remote)", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				// Upload-only: the remote base is seeded by the engine's own uploads (no initialRemote).
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world) // uploads a.txt + b.txt → seeds the remote base

				// A peer trashes the whole remote. This must be caught by the confirmation gate, not silently
				// mirrored into a local deletion.
				world.cloud.controls.trashPath("/a.txt")
				world.cloud.controls.trashPath("/b.txt")

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world), "the engine-seeded remote base did not arm the gate").toBeGreaterThan(0)
				expect(messagesOfType(world.messages, "confirmDeletion")[0]!.data.where).toBe("remote")
				// "restart" → the local files are NOT deleted; the backup survives the prompt.
				expect(snapshotLocal(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	it("GS2: a download-only first sync still prompts when the local side is later emptied (where: local)", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				// Download-only: the LOCAL base is seeded by the engine's own downloads (no initialLocal).
				initialRemote: { "/a.txt": "a", "/b.txt": "b" }
			},
			async world => {
				await plainCycle(world) // downloads a.txt + b.txt → seeds the local base

				// Everything vanishes locally (e.g. the drive was wiped). The gate must catch it.
				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world), "the engine-seeded local base did not arm the gate").toBeGreaterThan(0)
				expect(messagesOfType(world.messages, "confirmDeletion")[0]!.data.where).toBe("local")
				// "restart" → the remote copies survive.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})
})
