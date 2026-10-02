import { describe, it, expect } from "vitest"
import pathModule from "path"
import { createWorld, type World } from "../harness/world"

/**
 * The directory watcher must not watch what the sync ignores. On Linux, Node's recursive fs.watch arms one
 * inotify watch per directory (and, on Node 24, per file), so a `.filenignore`'d `tmp/` holding a million
 * entries exhausted the user's inotify budget for every other program while contributing nothing to the sync.
 * These tests pin the predicate handed to the watcher factory and the watcher's rebuild on a rules change.
 */
type Captured = {
	ignore: (relativePath: string) => boolean
	closed: boolean
}

function captureWatchers(world: World): Captured[] {
	const captured: Captured[] = []

	world.sync.environment.createWatcher = async (_path, _onChange, ignore) => {
		const entry: Captured = { ignore, closed: false }

		captured.push(entry)

		return {
			close: async (): Promise<void> => {
				entry.closed = true
			}
		}
	}

	return captured
}

describe("Directory watcher — ignore rules", () => {
	it("skips every entry below a .filenignore'd directory but keeps the directory entry itself", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "tmp/\n*.log" })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()

		const ignore = captured[0]!.ignore

		expect(ignore("tmp/review-1")).toBe(true)
		expect(ignore("tmp/review-1/out.bin")).toBe(true)
		expect(ignore("src/tmp/cache")).toBe(true)
		expect(ignore("debug.log")).toBe(true)
		expect(ignore("src/main.ts")).toBe(false)
		// The callback is not told the entry type, and `tmp/` ignores only a DIRECTORY named tmp: a FILE named
		// tmp still syncs, so the entry itself stays watched (one watch) while all of its children are skipped.
		expect(ignore("tmp")).toBe(false)
	})

	it("never skips a path the sync keeps when a negation re-includes its directory form", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "foo\n!foo/" })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()

		expect(captured[0]!.ignore("foo")).toBe(false)
		expect(captured[0]!.ignore("foo/bar.txt")).toBe(false)
	})

	it("skips the local trash and other default-ignored names", async () => {
		const world = await createWorld({ mode: "twoWay" })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()

		const ignore = captured[0]!.ignore

		expect(ignore(".filen.trash.local")).toBe(true)
		expect(ignore(".filen.trash.local/old/file.txt")).toBe(true)
		// DEFAULT_IGNORED.relativeGlobs: covered by the per-segment name check the watcher uses instead of micromatch.
		expect(ignore("$RECYCLE.BIN/S-1-5/x")).toBe(true)
		expect(ignore("System Volume Information/x")).toBe(true)
		expect(ignore("docs/Thumbs.db")).toBe(true)
		expect(ignore("docs/report.pdf")).toBe(false)
	})

	it("skips dotfiles only when they are excluded, and always watches the root .filenignore", async () => {
		const world = await createWorld({ mode: "twoWay", excludeDotFiles: true })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()

		expect(captured[0]!.ignore(".git")).toBe(true)
		expect(captured[0]!.ignore("src/.cache/x")).toBe(true)
		expect(captured[0]!.ignore(".filenignore")).toBe(false)

		const kept = await createWorld({ mode: "twoWay", excludeDotFiles: false })
		const keptCaptured = captureWatchers(kept)

		await kept.sync.localFileSystem.startDirectoryWatcher()

		expect(keptCaptured[0]!.ignore(".git")).toBe(false)
	})

	it("normalizes platform separators before matching", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "tmp/" })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()

		expect(captured[0]!.ignore(["src", "tmp", "x"].join(pathModule.sep))).toBe(true)
	})
})

describe("Directory watcher — rebuild on a rules change", () => {
	it("keeps the running watcher while the rules are unchanged", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "tmp/" })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()
		await world.sync.ignorer.initialize()
		await world.sync.localFileSystem.startDirectoryWatcher()

		expect(captured).toHaveLength(1)
		expect(captured[0]!.closed).toBe(false)
	})

	it("rebuilds the watcher when .filenignore changes, so newly ignored subtrees release their watches", async () => {
		const world = await createWorld({ mode: "twoWay", filenIgnore: "tmp/" })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()
		await world.worker.updateIgnorerContent(world.syncPair.uuid, "tmp/\nnode_modules/")

		world.sync.localFileSystem.getDirectoryTreeCache.timestamp = Date.now()

		await world.sync.localFileSystem.startDirectoryWatcher()

		expect(captured).toHaveLength(2)
		expect(captured[0]!.closed).toBe(true)
		expect(captured[1]!.closed).toBe(false)
		expect(captured[1]!.ignore("node_modules/x")).toBe(true)
		// The old watcher is gone before the new one is armed: force a rescan so nothing in the gap is missed.
		expect(world.sync.localFileSystem.getDirectoryTreeCache.timestamp).toBe(0)
	})

	it("rebuilds the watcher when excludeDotFiles is toggled", async () => {
		const world = await createWorld({ mode: "twoWay", excludeDotFiles: false })
		const captured = captureWatchers(world)

		await world.sync.localFileSystem.startDirectoryWatcher()

		world.worker.updateExcludeDotFiles(world.syncPair.uuid, true)

		await world.sync.localFileSystem.startDirectoryWatcher()

		expect(captured).toHaveLength(2)
		expect(captured[0]!.closed).toBe(true)
		expect(captured[1]!.ignore(".git")).toBe(true)
	})
})
