import { describe, it, expect } from "vitest"
import { runScenario, runCycle } from "../harness/runner"
import { BASE_TIME } from "../harness/world"
import { messagesOfType } from "../harness/snapshot"
import { type SyncMessage } from "../../src/types"
import type { VfsSpec } from "../fakes/virtual-fs"

/**
 * Anti-SILENT-DROP. Several v3.0.50 reports were the OPPOSITE of churn — files that simply never synced
 * ("150 GB missing", "most of my files don't upload"). The cause class: a pre-filter that judges a perfectly
 * syncable item too long / invalid and drops it, visible only as an "ignored" reason the user never sees. The
 * invariant here: an item the OS + Node CAN represent MUST sync — nothing valid is silently dropped. Each test
 * seeds valid-but-edge-case items and asserts (a) every one lands on the remote and (b) NO structural-ignore
 * reason (`pathLength` / `nameLength` / `invalidPath`) was emitted. Names are chosen to be legal on every
 * platform so the assertions hold on all CI legs. add-only.
 */
function ignoredReasons(messages: SyncMessage[]): string[] {
	const local = messagesOfType(messages, "localTreeIgnored").flatMap(m => m.data.ignored.map(entry => entry.reason))
	const remote = messagesOfType(messages, "remoteTreeIgnored").flatMap(m => m.data.ignored.map(entry => entry.reason))

	return [...local, ...remote]
}

const DROP_REASONS = ["pathLength", "nameLength", "invalidPath"]

async function syncLocalTree(spec: Record<string, string>): Promise<{ dropped: string[]; remoteKeys: string[]; result: Awaited<ReturnType<typeof runScenario>> }> {
	const initialLocal: VfsSpec = {}

	for (const [relative, content] of Object.entries(spec)) {
		initialLocal[`/local/${relative}`] = { content, mtimeMs: BASE_TIME }
	}

	const result = await runScenario({ name: "anti-drop", mode: "twoWay", initialLocal, steps: [runCycle(), runCycle()] })

	return {
		dropped: ignoredReasons(result.messages).filter(reason => DROP_REASONS.includes(reason)),
		remoteKeys: Object.keys(result.finalRemote),
		result
	}
}

describe("Anti-silent-drop — every syncable item actually syncs", () => {
	it("ASD1: a 254-char name (just under the 255 limit) syncs, not dropped", async () => {
		const name = `${"n".repeat(250)}.txt` // 254 chars
		const { dropped, result } = await syncLocalTree({ [name]: "x" })

		expect(dropped).toEqual([])
		expect(result.finalRemote[`/${name}`]).toMatchObject({ type: "file" })
	})

	it("ASD2: unicode names — CJK, accents, and emoji — sync (they fit the per-component limits)", async () => {
		const files = {
			"日本語のファイル.txt": "cjk",
			"café-résumé.md": "accents",
			"report-📊-2026.txt": "emoji",
			"Ωμέγα.dat": "greek"
		}
		const { dropped, result } = await syncLocalTree(files)

		expect(dropped).toEqual([])
		for (const name of Object.keys(files)) {
			expect(result.finalRemote[`/${name}`], `unicode name "${name}" was dropped`).toMatchObject({ type: "file" })
		}
	})

	it("ASD3: names with interior spaces and dots sync", async () => {
		const files = {
			"my report final.txt": "spaces",
			"archive.tar.gz": "dots",
			"v1.2.3 release notes.md": "both"
		}
		const { dropped, result } = await syncLocalTree(files)

		expect(dropped).toEqual([])
		for (const name of Object.keys(files)) {
			expect(result.finalRemote[`/${name}`]).toMatchObject({ type: "file" })
		}
	})

	it("ASD4: a broad tree of 120 files syncs COMPLETELY — no item silently missing", async () => {
		const files: Record<string, string> = {}

		for (let i = 0; i < 120; i++) {
			files[`dir${i % 8}/file-${i}.txt`] = `content-${i}`
		}

		const { dropped, result } = await syncLocalTree(files)

		expect(dropped).toEqual([])
		// Every single file is present on the remote — a partial sync (some files missing) fails here.
		const missing = Object.keys(files).filter(name => result.finalRemote[`/${name}`] === undefined)

		expect(missing, `files silently missing from the remote: ${missing.slice(0, 5).join(", ")}…`).toEqual([])
	})

	it("ASD5: a deep + moderately-long valid path syncs (under every platform's PATH_MAX)", async () => {
		// 30 levels × 20-char segments ≈ a 620-char path — over the OLD win32 512 cap, under macOS 1024.
		const deep = `${Array.from({ length: 30 }, (_, i) => `level${String(i).padStart(2, "0")}segment`).join("/")}/leaf.txt`
		const { dropped, result } = await syncLocalTree({ [deep]: "deep" })

		expect(dropped).toEqual([])
		expect(result.finalRemote[`/${deep}`]).toMatchObject({ type: "file" })
	})
})
