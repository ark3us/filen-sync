import { describe, it, expect } from "vitest"
import { createWorld, type World } from "../harness/world"
import { type SyncDirTreeFetcher } from "../../src/lib/filesystems/dirTree"
import { REMOTE_BUILD_CONCURRENCY } from "../../src/lib/filesystems/remote"

/**
 * Fix #20 (test-only regression guard — the code is currently correct). The remote tree build decrypts folder
 * and file metadata in bounded-concurrency BATCHES: it slices `REMOTE_BUILD_CONCURRENCY` tuples, awaits that
 * batch, then the next. This caps peak pending decrypt promises (and their retained plaintext) regardless of
 * tree size — the memory ceiling that keeps a ~2M-item tree from OOMing. A future refactor back to an eager
 * `dir.files.map(decrypt)` would create ONE promise per item up front (peak === item count) and silently
 * reintroduce the blow-up. These pin the invariant on BOTH batch sites (folders at remote.ts:331, files at
 * remote.ts:489) by measuring the PEAK number of decrypts in flight simultaneously and asserting it never
 * exceeds the cap. Asymmetric gap the audit flagged: the local scan's equivalent bound (ZM1) was tested; this
 * side was not. NEW FILE.
 */

type Folder = [string, string, string]
type File = [string, string, string, number, string, string, number, number]

// More than one full batch so the cap is actually reached AND clearly below the item count — an eager `.map()`
// would push peak up to the full population (2 * cap + 50) instead of the cap.
const COUNT = REMOTE_BUILD_CONCURRENCY * 2 + 50

function folderMeta(name: string): string {
	return JSON.stringify({ name })
}

function fileMeta(name: string): string {
	return JSON.stringify({ name, size: 10, mime: "text/plain", key: "k", lastModified: 1_700_000_000_000, creation: 1_690_000_000_000 })
}

function inject(world: World, folders: Folder[], files: File[]): void {
	world.sync.environment.fetchDirTree = (async () => ({ files, folders, raw: "" })) as unknown as SyncDirTreeFetcher
}

/**
 * Wrap `sdk.crypto().decrypt()` so every fileMetadata/folderMetadata decrypt increments an in-flight counter on
 * entry and decrements on resolve, tracking the running maximum. crypto()/decrypt() mint a fresh object per
 * call, so we replace the stable top — `sdk.crypto` — and re-wrap on each call. The identity decrypt resolves on
 * a microtask, so within a batch every decrypt in that batch increments before any decrements: peak === batch
 * width.
 */
function instrumentDecryptConcurrency(world: World): { peak: () => number; calls: () => number } {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sdk = world.sync.sdk as any
	const origCrypto = sdk.crypto.bind(sdk)
	let inFlight = 0
	let peak = 0
	let calls = 0

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const wrap =
		(fn: (args: any) => Promise<any>) =>
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		async (args: any): Promise<any> => {
			inFlight++
			calls++

			if (inFlight > peak) {
				peak = inFlight
			}

			try {
				return await fn(args)
			} finally {
				inFlight--
			}
		}

	sdk.crypto = () => {
		const realCrypto = origCrypto()

		return {
			...realCrypto,
			decrypt: () => {
				const realDecrypt = realCrypto.decrypt()

				return {
					...realDecrypt,
					fileMetadata: wrap(realDecrypt.fileMetadata.bind(realDecrypt)),
					folderMetadata: wrap(realDecrypt.folderMetadata.bind(realDecrypt))
				}
			}
		}
	}

	return { peak: () => peak, calls: () => calls }
}

describe("RemoteFileSystem.getDirectoryTree — decrypt concurrency is bounded by REMOTE_BUILD_CONCURRENCY", () => {
	it("a file population far larger than the cap never runs more than the cap of file decrypts at once", async () => {
		const world = await createWorld({ mode: "twoWay" })
		const rootUUID = world.cloud.controls.rootUUID

		const folders: Folder[] = [[rootUUID, folderMeta("Sync"), "base"]]
		const files: File[] = Array.from({ length: COUNT }, (_, i) => [
			`file-${i}`,
			"bucket",
			"region",
			1,
			rootUUID,
			fileMeta(`f${i}.txt`),
			2,
			1_700_000_000_000
		])

		inject(world, folders, files)

		const meter = instrumentDecryptConcurrency(world)
		const result = await world.sync.remoteFileSystem.getDirectoryTree(true)

		// Every file was placed (sanity: the batching itself did not drop items).
		expect(result.result.size).toBe(COUNT)
		// Every file (plus the root folder) was decrypted exactly once.
		expect(meter.calls()).toBe(COUNT + 1)

		// The KEY invariant: peak in-flight decrypts is the CAP, not the item count. An eager `.map()` over all
		// files would make peak === COUNT (2*cap+50) and OOM at scale.
		expect(meter.peak(), "peak concurrent file decrypts exceeded REMOTE_BUILD_CONCURRENCY").toBeLessThanOrEqual(
			REMOTE_BUILD_CONCURRENCY
		)
		expect(meter.peak(), "the batch never saturated the cap — the population is too small to be a real guard").toBe(
			REMOTE_BUILD_CONCURRENCY
		)
		expect(meter.peak()).toBeLessThan(COUNT)
	})

	it("a folder population far larger than the cap never runs more than the cap of folder decrypts at once", async () => {
		const world = await createWorld({ mode: "twoWay" })
		const rootUUID = world.cloud.controls.rootUUID

		// root + COUNT direct children of root.
		const folders: Folder[] = [
			[rootUUID, folderMeta("Sync"), "base"],
			...Array.from({ length: COUNT }, (_, i): Folder => [`folder-${i}`, folderMeta(`d${i}`), rootUUID])
		]

		inject(world, folders, [])

		const meter = instrumentDecryptConcurrency(world)
		const result = await world.sync.remoteFileSystem.getDirectoryTree(true)

		expect(result.result.size).toBe(COUNT)
		// root + COUNT children decrypted exactly once each.
		expect(meter.calls()).toBe(COUNT + 1)

		expect(meter.peak(), "peak concurrent folder decrypts exceeded REMOTE_BUILD_CONCURRENCY").toBeLessThanOrEqual(
			REMOTE_BUILD_CONCURRENCY
		)
		expect(meter.peak(), "the batch never saturated the cap — the population is too small to be a real guard").toBe(
			REMOTE_BUILD_CONCURRENCY
		)
		expect(meter.peak()).toBeLessThan(COUNT + 1)
	})
})
