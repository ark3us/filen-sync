import { describe, it, expect } from "vitest"
import { runScenario, runCycle, control } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { transferKinds, allOps } from "../harness/snapshot"
import { type SyncDirTreeFetcher } from "../../src/lib/filesystems/dirTree"

/**
 * Resilience — a STRUCTURAL orphan in the /v3/dir/tree response must never read as a mass local deletion.
 * A single missing intermediate folder tuple (every returned item still DECRYPTS fine, so decryptErrors=0)
 * orphans its whole subtree: the children are present but their parent is absent, so they resolve to no path
 * and vanish from the remote tree — indistinguishable from a deletion, so the local-deletion pass trashes the
 * local copies (permanent for un-synced local edits). The decrypt-error carry-forward was gated on
 * decryptErrors>0, so it did not cover this shape — the one inconsistent-response family with zero protection.
 * The fix counts orphaned items as `structuralErrors` and extends the incomplete-read carry-forward to them.
 * Companion of the decrypt-error guard and the local partial-scan guard (resilience-partial-scan). add-only.
 */
describe("Resilience — a structural orphan is not a mass deletion", () => {
	it("SO1: a missing intermediate folder tuple does not delete the orphaned subtree locally (self-heals)", async () => {
		let realFetcher: SyncDirTreeFetcher | null = null

		const result = await runScenario({
			name: "SO1",
			mode: "twoWay",
			initialLocal: {
				"/local/keep.txt": { content: "k", mtimeMs: BASE_TIME },
				"/local/docs/top.txt": { content: "t", mtimeMs: BASE_TIME },
				"/local/docs/sub/file.txt": { content: "f", mtimeMs: BASE_TIME },
				"/local/docs/sub/deep/leaf.txt": { content: "l", mtimeMs: BASE_TIME }
			},
			steps: [
				runCycle(), // settle: base + local + remote all hold docs/sub/**
				// The next remote read OMITS the /docs/sub folder tuple. Its whole subtree (sub, sub/deep,
				// sub/file.txt, sub/deep/leaf.txt) is present-but-parentless → orphaned → absent from the tree,
				// yet everything DECRYPTS (decryptErrors stays 0). This is the shape the old guard missed.
				control(world => {
					realFetcher = world.sync.environment.fetchDirTree

					world.sync.environment.fetchDirTree = (async (sdk, request) => {
						const full = await realFetcher!(sdk, { ...request, skipCache: true })

						return {
							...full,
							folders: full.folders.filter(folder => {
								try {
									return (JSON.parse(folder[1]) as { name?: string }).name !== "sub"
								} catch {
									return true
								}
							})
						}
					}) as SyncDirTreeFetcher
				}),
				runCycle(), // the orphaned subtree must NOT be read as a deletion
				// The response recovers (faithful fetcher restored); the tree re-reads cleanly and converges.
				control(world => {
					world.sync.environment.fetchDirTree = realFetcher!
				}),
				runCycle(),
				runCycle()
			]
		})

		// The orphaned subtree survives locally — no deletion was emitted for it.
		expect(result.finalLocal["/docs/sub/file.txt"], "orphaned file deleted locally by a structural orphan").toMatchObject({
			type: "file"
		})
		expect(result.finalLocal["/docs/sub/deep/leaf.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/docs/top.txt"]).toMatchObject({ type: "file" })
		expect(result.finalLocal["/keep.txt"]).toMatchObject({ type: "file" })

		// No delete op fired at any point (neither local nor remote).
		const everything = result.cycles.flatMap(c => transferKinds(c.messages))

		expect(everything.filter(op => op.startsWith("delete")), "a structural orphan emitted deletions").toEqual([])

		// After recovery it converges and settles.
		expect(result.finalLocal).toEqual(result.finalRemote)
		expect(allOps(result.cycles[result.cycles.length - 1]!.messages), "did not settle after recovery").toEqual([])
	})
})
