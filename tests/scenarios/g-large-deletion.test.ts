import { describe, it, expect, vi } from "vitest"
import { SYNC_INTERVAL } from "../../src/constants"
import { createWorld, BASE_TIME, type CreateWorldOptions, type World } from "../harness/world"
import { snapshotLocal, snapshotRemote, messagesOfType } from "../harness/snapshot"
import { renameLocal, rmLocal, writeLocal } from "../harness/mutations"

/**
 * Category G — large-deletion confirmation (behavioral spec §G, §6). When
 * requireConfirmationOnLargeDeletion is set and a cycle would delete more than the pair's threshold
 * allows (by default: everything it has synced), the engine posts a `confirmDeletion` prompt, defers
 * the gated deletions and finishes the cycle. The answer from `confirmDeletion(uuid, decision)` is
 * consumed by a LATER cycle: "delete" applies the deletions if the set still matches what was shown,
 * "restart" leaves them deferred and the prompt returns.
 *
 * Cycles are driven manually here (not via runScenario) because a confirmation spans two of them.
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

/** Drive one cycle that is NOT expected to block on a confirmation prompt. */
async function plainCycle(world: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

	await world.sync.runCycle()
}

/** Drive the two cycles a confirmation takes: one that prompts, one that applies `decision`. */
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

describe("Category G — large-deletion confirmation", () => {
	it("G1: emptying the local side and confirming the deletion proceeds", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				expect(messagesOfType(world.messages, "confirmDeletion")[0]!.data.where).toBe("local")
				// "delete" was given, so the remote is emptied to match.
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})

	it("G2: emptying the local side and answering restart skips the cycle (no deletions)", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// "restart" was given, so the deletions are NOT applied — the remote still has both files.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G3: confirmRemoteDeletion is gated by BOTH the mode and the `previousRemote.size <= deleteCount`
	// threshold (symmetric to confirmLocalDeletion). Here the remote is emptied but only part of it is
	// attributable to remote-side deletions (the rest was deleted locally), so the threshold is NOT met
	// and there is NO prompt. (BUG-001 fix: the missing `&&` that dropped the threshold + mode gate is
	// restored, so confirmRemoteDeletion is now symmetric with confirmLocalDeletion.)
	it("G3: a sub-threshold remote emptying does not trigger a confirmation prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				// Start from the remote so the previous remote tree is observed non-empty (size 3) — an
				// upload-only cycle would leave previousRemote.size at 0 and the prompt could never fire.
				initialRemote: { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c" }
			},
			async world => {
				await plainCycle(world)

				// Remote loses everything, but one of those removals is also a LOCAL deletion — so it is
				// attributed to a remote-delete, leaving deleteLocalCount (2) < previousRemote.size (3). The
				// correct (threshold-gated) confirmRemoteDeletion is therefore false.
				world.cloud.controls.trashPath("/a.txt")
				world.cloud.controls.trashPath("/b.txt")
				world.cloud.controls.trashPath("/c.txt")
				rmLocal(world, "a.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				// TARGET: the threshold is not met, so the engine proceeds without prompting.
				expect(confirmDeletionCount(world)).toBe(0)
			}
		)
	})

	it("G4: with confirmation disabled, a full emptying deletes without prompting", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: false,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await plainCycle(world)

				expect(confirmDeletionCount(world)).toBe(0)
				expect(snapshotRemote(world)).toEqual({})
			}
		)
	})

	it("G5: a partial deletion (side not emptied) does not trigger a prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b", "/local/c.txt": "c" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				world.triggerWatcher()

				await plainCycle(world)

				expect(confirmDeletionCount(world)).toBe(0)
				// Only the deleted file is gone; the rest remain.
				expect(snapshotRemote(world)["/a.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/c.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)["/a.txt"]).toBeUndefined()
			}
		)
	})

	// Drive a cycle that opens the confirmation prompt, then STOP the pair (pause/remove) without ever
	// answering. Returns whether the cycle settled. Since the gate stopped blocking, settling is structural
	// rather than a bail-out — these two keep guarding it: a cycle must never again end up waiting on a
	// human while holding the account lock. The tick loop is capped so a regression fails fast
	// (settled === false) instead of hanging the suite.
	async function runCycleThenStopMidConfirmation(world: World, stop: (world: World) => void): Promise<boolean> {
		await vi.advanceTimersByTimeAsync(SYNC_INTERVAL + 1)

		let settled = false
		const cyclePromise = world.sync.runCycle().finally(() => {
			settled = true
		})

		// Let the prompt open, then stop the pair while the wait loop is still polling.
		await vi.advanceTimersByTimeAsync(1000)

		stop(world)

		for (let tick = 0; tick < 5 && !settled; tick++) {
			await vi.advanceTimersByTimeAsync(1000)
		}

		if (settled) {
			await cyclePromise
		}

		return settled
	}

	it("G6: pausing the pair while awaiting confirmation bails out — no wedge, lock released, no deletion", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				const settled = await runCycleThenStopMidConfirmation(world, w => {
					w.sync.paused = true
				})

				// The cycle stopped waiting (it did not hold the lock forever) and applied NO deletion.
				expect(settled, "the cycle must stop waiting once the pair is paused").toBe(true)
				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })

				// The lock was released (the finally ran), so once un-paused a normal cycle proceeds to
				// completion — it would block forever on lock.acquire() if the previous cycle still held it.
				world.sync.paused = false

				await cycleWithDecision(world, "restart")
			}
		)
	})

	it("G7: removing the pair while awaiting confirmation bails out — no wedge", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				const settled = await runCycleThenStopMidConfirmation(world, w => {
					w.sync.removed = true
				})

				expect(settled, "the cycle must stop waiting once the pair is removed").toBe(true)
				// No deletion was applied — the wait was abandoned, not confirmed.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G8/G9 — `largeDeletionThreshold`: an absolute number of deletions that arms the same gate BELOW a
	// full wipe. G5 above is the control (no threshold configured, partial deletion, no prompt).
	it("G8: a partial deletion at or above the configured threshold prompts, and restart applies nothing", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b", "/local/c.txt": "c", "/local/d.txt": "d" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				const prompts = messagesOfType(world.messages, "confirmDeletion")

				expect(prompts.length).toBeGreaterThan(0)
				expect(prompts[0]!.data.where).toBe("local")
				// The side is NOT empty here, so `count` is what tells the user how much is at stake.
				expect(prompts[0]!.data.count).toBe(2)
				// "restart" — nothing was deleted remotely, not even the sub-threshold rest of the cycle.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G12 — declining the prompt defers ONLY the gated deletions. The rest of the cycle (here an upload
	// queued in the same cycle) must still run, and the deferred deletions must survive as pending work:
	// the base tree is not advanced, so confirming them later still applies them.
	it("G12: restart defers the deletions but lets the rest of the cycle through", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b", "/local/c.txt": "c", "/local/d.txt": "d" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				writeLocal(world, "e.txt", "e")
				world.triggerWatcher()

				const successesBeforeDecline = messagesOfType(world.messages, "cycleSuccess").length

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// Deferred: both files still in the cloud.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
				// NOT deferred: the unrelated upload rode along instead of waiting for a verdict.
				expect(snapshotRemote(world)["/e.txt"]).toMatchObject({ type: "file" })
				// A deferred cycle must NOT report success: the renderer clears the pending confirmation
				// banner on cycleSuccess, which would dismiss an unresolved mass-deletion warning.
				expect(messagesOfType(world.messages, "cycleSuccess").length).toBe(successesBeforeDecline)

				// Still pending, not forgotten — the base was never advanced past them.
				await cycleWithDecision(world, "delete")

				expect(snapshotRemote(world)["/a.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/b.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/e.txt"]).toMatchObject({ type: "file" })
				// The resolved cycle reports success again.
				expect(messagesOfType(world.messages, "cycleSuccess").length).toBeGreaterThan(successesBeforeDecline)
			}
		)
	})

	// G13 — a deferred deletion parks everything queued for the same PATH, not just the deletion itself.
	// Replacing a folder with a file of the same name emits both a delete and an upload for that path; the
	// upload cannot succeed while the folder is still there ("a directory with that name exists"), so
	// running it alone would raise a task error on every declined cycle.
	it("G13: a deferred deletion also parks the create queued for the same path", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialLocal: { "/local/notes/x.txt": "x", "/local/notes/y.txt": "y", "/local/keep.txt": "k" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "notes")
				writeLocal(world, "notes", "now a file")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// The folder and its contents are untouched...
				expect(snapshotRemote(world)["/notes"]).toMatchObject({ type: "directory" })
				expect(snapshotRemote(world)["/notes/x.txt"]).toMatchObject({ type: "file" })
				// ...the doomed upload was never attempted, so the declined cycle reports no error...
				expect(world.sync.taskErrors).toHaveLength(0)
				// ...and nothing extra landed in the cloud. Counted over the raw cloud state, since a file and
				// a folder sharing one path collapse to a single entry in a path-keyed snapshot.
				expect(world.cloud.controls.tree().files).toHaveLength(3)
			}
		)
	})

	// G16 — a rename queued in a deferred cycle waits with the deletions. Rename detection needs the base tree
	// to still agree with the OTHER side about the source path, and a deferred cycle freezes the base on purpose.
	// Executing the rename anyway breaks that agreement, so the next cycle can no longer prove the move and reads
	// the old path as deleted — inflating the count the user is asked to approve (here: 2 would become 6) and
	// invalidating an approval already given for the smaller set.
	it("G16: a rename in a deferred cycle does not inflate the next prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialLocal: {
					"/local/del1.txt": "1",
					"/local/del2.txt": "2",
					"/local/moveme/a.txt": "a",
					"/local/moveme/b.txt": "b",
					"/local/moveme/c.txt": "c"
				}
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "del1.txt")
				rmLocal(world, "del2.txt")
				renameLocal(world, "moveme", "moved")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				const prompts = messagesOfType(world.messages, "confirmDeletion")

				expect(prompts.length).toBeGreaterThan(1)
				// Every prompt describes the same two deletions: the moved folder never leaked into the count.
				expect(prompts.map(prompt => prompt.data.count)).toEqual(prompts.map(() => 2))
				// The rename waited for the verdict, so the cloud still shows the pre-move layout.
				expect(snapshotRemote(world)["/moveme/a.txt"]).toMatchObject({ type: "file" })

				// Approving applies both the deletions and the parked rename.
				await cycleWithDecision(world, "delete")
				await plainCycle(world)

				expect(snapshotRemote(world)["/del1.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/del2.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/moved/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/moveme"]).toBeUndefined()
			}
		)
	})

	// G17 — an unanswered prompt must be re-stated on EVERY cycle, and no cycle may report success over it.
	// The renderer clears its warning bar on cycleSuccess and on nothing else, so a single stray success would
	// leave the bar reading "everything synced" while a mass deletion sits waiting for a human. Three cycles,
	// because the second and third take the no-changes early return (both trees are served from cache) — a
	// different code path from the first, and the one a real idle client spends almost all its time on.
	it("G17: an unanswered prompt is restated every cycle and no cycle reports success", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b", "/local/c.txt": "c" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				const successesBefore = messagesOfType(world.messages, "cycleSuccess").length

				for (let cycle = 0; cycle < 3; cycle++) {
					const promptsBefore = confirmDeletionCount(world)

					await plainCycle(world)

					expect(confirmDeletionCount(world)).toBe(promptsBefore + 1)
					expect(messagesOfType(world.messages, "cycleSuccess").length).toBe(successesBefore)
				}

				// Still deferred after all three: nothing was deleted behind the unanswered prompt.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G10 — the threshold may only LOWER the bar. A threshold larger than the pair itself must not make a
	// full wipe pass unannounced (it would silently disable the very guarantee the setting refines).
	it("G10: a threshold above the tree size still prompts on a full wipe", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 500,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G11 — the remote side of the gate takes the threshold too (symmetric with G8).
	it("G11: remote deletions at the configured threshold prompt with where=remote", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialRemote: { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c", "/d.txt": "d" }
			},
			async world => {
				await plainCycle(world)

				world.cloud.controls.trashPath("/a.txt")
				world.cloud.controls.trashPath("/b.txt")

				await cycleWithDecision(world, "restart")

				const prompts = messagesOfType(world.messages, "confirmDeletion")

				expect(prompts.length).toBeGreaterThan(0)
				expect(prompts[0]!.data.where).toBe("remote")
				expect(prompts[0]!.data.count).toBe(2)
				// "restart" — the local copies were not trashed.
				expect(snapshotLocal(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotLocal(world)["/b.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	it("G9: a deletion below the configured threshold syncs through without prompting", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 3,
				initialLocal: { "/local/a.txt": "a", "/local/b.txt": "b", "/local/c.txt": "c", "/local/d.txt": "d" }
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await plainCycle(world)

				expect(confirmDeletionCount(world)).toBe(0)
				expect(snapshotRemote(world)["/a.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/b.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/c.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G15 — the approval is bound to WHAT WAS SHOWN. Between the prompt and the click the deletion set can
	// grow; applying the old "yes" to the new set would delete more than the user agreed to.
	it("G15: an approval does not apply to a deletion set that grew since the prompt", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialLocal: {
					"/local/a.txt": "a",
					"/local/b.txt": "b",
					"/local/c.txt": "c",
					"/local/d.txt": "d",
					"/local/e.txt": "e"
				}
			},
			async world => {
				await plainCycle(world)

				rmLocal(world, "a.txt")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				// Cycle 1 prompts for 2 deletions and defers them.
				await plainCycle(world)

				const prompts = messagesOfType(world.messages, "confirmDeletion")

				expect(prompts.length).toBe(1)
				expect(prompts[0]!.data.count).toBe(2)

				// The user approves those 2 — but deletes two more files before the next cycle runs.
				world.worker.confirmDeletion(world.syncPair.uuid, "delete")
				rmLocal(world, "c.txt")
				rmLocal(world, "d.txt")
				world.triggerWatcher()

				await plainCycle(world)

				// The set is now 4, so the approval for 2 does not apply: nothing was deleted and the user is
				// asked again, with the real number.
				expect(snapshotRemote(world)["/a.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/c.txt"]).toMatchObject({ type: "file" })

				const reprompts = messagesOfType(world.messages, "confirmDeletion")

				expect(reprompts.length).toBe(2)
				expect(reprompts[1]!.data.count).toBe(4)

				// Approving the set actually shown applies it.
				world.worker.confirmDeletion(world.syncPair.uuid, "delete")

				await plainCycle(world)

				expect(snapshotRemote(world)["/a.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/c.txt"]).toBeUndefined()
				expect(snapshotRemote(world)["/e.txt"]).toMatchObject({ type: "file" })
			}
		)
	})

	// G14 — the defer covers DESCENDANTS of a deferred path, not just the path itself. Replacing a synced
	// FILE with a directory full of children emits deleteRemoteFile /notes (gated) + createRemoteDirectory
	// /notes (same path, G13's case) + uploadFile /notes/child.txt — and that last one lives at a CHILD
	// path. Running it would mkdir the remote parent next to the still-undeleted remote file "notes",
	// producing exactly the half-applied state / per-declined-cycle task error the defer exists to prevent.
	it("G14: children of a deferred path are parked with it", async () => {
		await withWorld(
			{
				mode: "twoWay",
				requireConfirmationOnLargeDeletion: true,
				largeDeletionThreshold: 2,
				initialLocal: { "/local/notes": "i am a file", "/local/b.txt": "b", "/local/keep.txt": "k" }
			},
			async world => {
				await plainCycle(world)

				// File -> directory-with-children, plus a second deletion to arm the threshold-2 gate.
				rmLocal(world, "notes")
				writeLocal(world, "notes/child.txt", "child")
				rmLocal(world, "b.txt")
				world.triggerWatcher()

				await cycleWithDecision(world, "restart")

				expect(confirmDeletionCount(world)).toBeGreaterThan(0)
				// Nothing was applied on the deferred paths: the remote "notes" is still the FILE...
				expect(snapshotRemote(world)["/notes"]).toMatchObject({ type: "file" })
				// ...the child upload did not run (it would have mkdir'd a remote directory besides it)...
				expect(snapshotRemote(world)["/notes/child.txt"]).toBeUndefined()
				expect(world.sync.taskErrors).toHaveLength(0)
				// ...and the unrelated file is untouched.
				expect(snapshotRemote(world)["/keep.txt"]).toMatchObject({ type: "file" })

				// Confirming later applies the full type change: file gone, directory + child uploaded.
				// A fully-deferred cycle leaves both tree caches untouched, so the next cycle would exit at
				// cycleNoChanges; in production the periodic rescan re-arms it — here the watcher stands in.
				world.triggerWatcher()

				await cycleWithDecision(world, "delete")

				expect(snapshotRemote(world)["/notes"]).toMatchObject({ type: "directory" })
				expect(snapshotRemote(world)["/notes/child.txt"]).toMatchObject({ type: "file" })
				expect(snapshotRemote(world)["/b.txt"]).toBeUndefined()
			}
		)
	})
})
