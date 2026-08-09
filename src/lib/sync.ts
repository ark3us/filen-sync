import FilenSDK, { type PauseSignal } from "@filen/sdk"
import { type SyncPair, type SyncMode } from "../types"
import { SYNC_INTERVAL, LOCAL_TRASH_NAME } from "../constants"
import { LocalFileSystem, LocalTree, type LocalTreeError } from "./filesystems/local"
import { RemoteFileSystem, RemoteTree } from "./filesystems/remote"
import Deltas, { type Delta } from "./deltas"
import Tasks, { type TaskError } from "./tasks"
import State from "./state"
import { postMessageToMain } from "./ipc"
import Ignorer from "../ignorer"
import { serializeError } from "../utils"
import type SyncWorker from ".."
import Lock from "./lock"
import pathModule from "path"
import { type SyncEnvironment } from "./environment"
import { v4 as uuidv4 } from "uuid"
import FastGlob from "fast-glob"

/**
 * Normalize a user-supplied large-deletion threshold (absolute number of deletions at which the
 * confirmation prompt fires). Only a whole number >= 1 is honored; everything else (0, negative,
 * fractional, NaN, Infinity, wrong type — it comes from a config file we do not control) falls back to
 * `undefined`, i.e. the default "the deletions would wipe out the whole previously-known tree" rule.
 * The fallback is deliberately the SAFE direction: a malformed value must never silently disable the
 * gate, and a 0/negative one would prompt on every single deleted file until the user gave up on it.
 */
export function normalizeLargeDeletionThreshold(value?: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined
}

/**
 * Sync
 *
 * @export
 * @class Sync
 * @typedef {Sync}
 */
export class Sync {
	public readonly sdk: FilenSDK
	public readonly environment: SyncEnvironment
	public readonly syncPair: SyncPair
	private isInitialized = false
	public readonly localFileSystem: LocalFileSystem
	public readonly remoteFileSystem: RemoteFileSystem
	public readonly deltas: Deltas
	public previousLocalTree: LocalTree = {
		tree: {},
		inodes: {},
		size: 0
	}
	public previousRemoteTree: RemoteTree = {
		tree: {},
		uuids: {},
		size: 0
	}
	public localFileHashes: Record<string, string> = {}
	public readonly tasks: Tasks
	public readonly state: State
	public readonly dbPath: string
	public readonly abortControllers: Record<string, AbortController> = {}
	public readonly pauseSignals: Record<string, PauseSignal> = {}
	public readonly ignorer: Ignorer
	public paused: boolean
	public mode: SyncMode
	public excludeDotFiles: boolean
	public readonly worker: SyncWorker
	public removed: boolean = false
	public readonly lock: Lock
	public taskErrors: TaskError[] = []
	public localTrashDisabled: boolean
	public localTreeErrors: LocalTreeError[] = []
	public cleaningLocalTrash: boolean = false
	public cleanupLocalTrashInterval: ReturnType<typeof setInterval> | undefined = undefined
	public isPreviousSavedTreeStateEmpty: boolean = true
	public requireConfirmationOnLargeDeletion: boolean
	public largeDeletionThreshold: number | undefined
	public deletionConfirmationResult: "delete" | "restart" | "waiting" = "waiting"
	/** Set of gated deletions the user was last asked about ("<side>:<count>"), null when nothing is pending. */
	public promptedDeletionFingerprint: string | null = null
	/** The set the user approved. Applied only if the next cycle's set still matches it, then cleared. */
	public approvedDeletionFingerprint: string | null = null
	/** Re-posted on cycles that end early, so the renderer's pending-deletion banner survives them. */
	public lastConfirmDeletionMessage: { where: "local" | "remote" | "both"; previous: number; current: number; count: number } | null =
		null

	/**
	 * Creates an instance of Sync.
	 *
	 * @constructor
	 * @public
	 * @param {{ syncPair: SyncPair; worker: SyncWorker }} param0
	 * @param {SyncPair} param0.syncPair
	 * @param {SyncWorker} param0.worker
	 */
	public constructor({ syncPair, worker }: { syncPair: SyncPair; worker: SyncWorker }) {
		this.worker = worker
		this.syncPair = syncPair
		this.mode = syncPair.mode
		this.paused = syncPair.paused
		this.excludeDotFiles = syncPair.excludeDotFiles
		this.dbPath = worker.dbPath
		this.sdk = worker.sdk
		this.environment = worker.environment
		this.localTrashDisabled = syncPair.localTrashDisabled
		this.requireConfirmationOnLargeDeletion =
			typeof syncPair.requireConfirmationOnLargeDeletion === "boolean" ? syncPair.requireConfirmationOnLargeDeletion : false
		this.largeDeletionThreshold = normalizeLargeDeletionThreshold(syncPair.largeDeletionThreshold)
		this.localFileSystem = new LocalFileSystem(this)
		this.remoteFileSystem = new RemoteFileSystem(this)
		this.deltas = new Deltas(this)
		this.tasks = new Tasks(this)
		this.state = new State(this)
		this.ignorer = new Ignorer(this, "ignorer")
		this.lock = new Lock({
			sync: this,
			resource: `sync-remoteParentUUID-${this.syncPair.remoteParentUUID}`
		})

		this.cleanupLocalTrash()
	}

	public async smokeTest(): Promise<void> {
		// Loop rather than recurse: during a prolonged outage this retries once per SYNC_INTERVAL, and the
		// old `return await this.smokeTest()` tail-recursion accumulated one suspended async frame per retry
		// (unbounded memory growth over a long outage). `this.removed` is re-checked every iteration so a
		// pair removed mid-outage aborts promptly. The caller runs this BEFORE acquiring the lock, so an
		// outage stalls only this pair's cycle and never holds the account lock (cross-device starvation).
		while (true) {
			if (this.removed) {
				throw new Error("Aborted")
			}

			const localSmokeTest =
				this.mode === "cloudBackup" || this.mode === "cloudToLocal" || this.mode === "twoWay"
					? await this.localFileSystem.isPathWritable(this.syncPair.localPath)
					: await this.localFileSystem.isPathReadable(this.syncPair.localPath)

			if (!localSmokeTest) {
				await this.localFileSystem.stopDirectoryWatcher()

				this.worker.logger.log(
					"error",
					"Local smoke test failed, path not existing or not readable or writable",
					this.syncPair.localPath
				)

				postMessageToMain({
					type: "cycleLocalSmokeTestFailed",
					syncPair: this.syncPair
				})

				await new Promise<void>(resolve => setTimeout(resolve, SYNC_INTERVAL))

				continue
			}

			const remoteSmokeTest = await this.remoteFileSystem.remoteDirPathExisting()

			if (!remoteSmokeTest) {
				this.worker.logger.log("error", "Remote smoke test failed, path does not exist or is in the trash", this.syncPair.remotePath)

				postMessageToMain({
					type: "cycleRemoteSmokeTestFailed",
					syncPair: this.syncPair
				})

				await new Promise<void>(resolve => setTimeout(resolve, SYNC_INTERVAL))

				continue
			}

			return
		}
	}

	public cleanupLocalTrash(): void {
		// Keep the timer handle so cleanup() can clear it. Previously the handle was discarded, so a removed
		// pair's interval kept firing every 5 minutes forever — pinning the whole Sync (and its trees) in
		// memory and burning a periodic glob/stat on a dead pair.
		this.cleanupLocalTrashInterval = setInterval(() => {
			void this.cleanupLocalTrashOnce()
		}, 300000)
	}

	public async cleanupLocalTrashOnce(): Promise<void> {
		if (this.cleaningLocalTrash) {
			return
		}

		this.cleaningLocalTrash = true

		try {
			const localTrashPath = pathModule.join(this.syncPair.localPath, LOCAL_TRASH_NAME)

			if (await this.environment.fs.exists(localTrashPath)) {
				const now = Date.now()
				const dir = await FastGlob.async("**/*", {
					dot: true,
					onlyDirectories: false,
					// Deletes move whole DIRECTORIES into the trash (by basename), so the eviction sweep must
					// age out directories too. With onlyFiles:true the glob skipped every trashed directory and
					// (because deep:0 also stops it descending) their contents — so trashed directories leaked
					// and accumulated forever. The rm below already recurses, so an old top-level dir is removed
					// wholesale.
					onlyFiles: false,
					throwErrorOnBrokenSymbolicLink: false,
					cwd: localTrashPath,
					followSymbolicLinks: false,
					deep: 0,
					fs: this.environment.globFs,
					suppressErrors: true,
					stats: true,
					unique: true,
					objectMode: true
				})

				for (const entry of dir) {
					if (!entry) {
						continue
					}

					if (entry.stats && entry.stats.atimeMs + 86400000 * 30 < now) {
						await this.environment.fs.rm(pathModule.join(localTrashPath, entry.path), {
							force: true,
							maxRetries: 60 * 10,
							recursive: true,
							retryDelay: 100
						})
					}
				}
			}
		} catch (e) {
			this.worker.logger.log("error", e, "sync.cleanupLocalTrash")
			this.worker.logger.log("error", e)
		} finally {
			this.cleaningLocalTrash = false
		}
	}

	public async initialize(): Promise<void> {
		if (this.isInitialized) {
			return
		}

		this.isInitialized = true

		try {
			// Do NOT block on the startup smoke test here. It retries every SYNC_INTERVAL until the local/remote
			// path is reachable — unbounded for an offline drive — and initialize() runs inside updateSyncPairs'
			// mutex, so one offline pair used to stall worker init AND every later updateSyncPairs (the mutex was
			// never released). State + ignorer init are path-independent for the common offline cases (state lives
			// in the app db dir; the ignorer degrades to its stored copy when the physical .filenignore is
			// unreachable), and run()'s OWN per-cycle smoke test (runCycle) still gates all real work until the
			// path returns. So admit the pair immediately and let the cycle loop wait for availability. (#14)
			await Promise.all([this.state.initialize(), this.ignorer.initialize()])

			this.worker.logger.log("info", "Initialized", this.syncPair.localPath)

			this.run()
		} catch (e) {
			this.worker.logger.log("error", e, "sync.initialize")
			this.worker.logger.log("error", e)

			this.isInitialized = false

			throw e
		}
	}

	public async cleanup({ deleteLocalDbFiles = false }: { deleteLocalDbFiles?: boolean }): Promise<void> {
		if (this.cleanupLocalTrashInterval) {
			clearInterval(this.cleanupLocalTrashInterval)

			this.cleanupLocalTrashInterval = undefined
		}

		try {
			await Promise.all([
				this.localFileSystem.stopDirectoryWatcher(),
				deleteLocalDbFiles ? this.deleteLocalSyncDbFiles() : Promise.resolve()
			])

			this.worker.logger.log("info", "Cleanup done", this.syncPair.localPath)
		} catch (e) {
			this.worker.logger.log("error", e, "sync.cleanup")
			this.worker.logger.log("error", e)
		}

		this.isInitialized = false
		this.removed = true

		postMessageToMain({
			type: "cycleExited",
			syncPair: this.syncPair
		})
	}

	public async deleteLocalSyncDbFiles(): Promise<void> {
		await Promise.all([this.remoteFileSystem.clearDeviceId(), this.state.clear(), this.ignorer.clearFile()])
	}

	private async run(): Promise<void> {
		if (this.removed) {
			await this.cleanup({
				deleteLocalDbFiles: true
			})

			return
		}

		try {
			await this.runCycle()
		} finally {
			if (this.worker.runOnce || this.removed) {
				await this.cleanup({
					deleteLocalDbFiles: this.removed
				})
			} else {
				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				setTimeout(() => {
					this.run()
				}, SYNC_INTERVAL)
			}
		}
	}

	/**
	 * Run exactly one synchronization cycle without scheduling the next one.
	 *
	 * This is the body of a single pass: error/pause gating, lock acquisition,
	 * tree diffing, delta processing, task execution and state persistence. It
	 * never throws (failures are caught and reported as a "cycleError" message)
	 * and never reschedules — {@link run} owns the self-scheduling loop. Exposed
	 * so a single cycle can be driven deterministically.
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async runCycle(): Promise<void> {
		try {
			if (this.taskErrors.length > 0 || this.localTreeErrors.length > 0) {
				if (this.worker.runOnce) {
					await this.cleanup({
						deleteLocalDbFiles: false
					})

					return
				}

				postMessageToMain({
					type: "taskErrors",
					syncPair: this.syncPair,
					data: {
						errors: this.taskErrors.map(e => ({
							...e,
							error: serializeError(e.error)
						}))
					}
				})

				postMessageToMain({
					type: "localTreeErrors",
					syncPair: this.syncPair,
					data: {
						errors: this.localTreeErrors.map(e => ({
							...e,
							error: serializeError(e.error)
						}))
					}
				})

				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				this.worker.logger.log("error", "Not continueing sync cycle, got taskErrors or localTreeErrors", this.syncPair.localPath)
				this.worker.logger.log(
					"error",
					{
						taskErrors: this.taskErrors,
						localTreeErrors: this.localTreeErrors
					},
					this.syncPair.localPath
				)

				return
			}

			if (this.paused) {
				if (this.worker.runOnce) {
					await this.cleanup({
						deleteLocalDbFiles: false
					})

					return
				}

				postMessageToMain({
					type: "cyclePaused",
					syncPair: this.syncPair
				})

				postMessageToMain({
					type: "cycleSuccess",
					syncPair: this.syncPair
				})

				postMessageToMain({
					type: "cycleRestarting",
					syncPair: this.syncPair
				})

				return
			}

			// It will only start it once. We call it here every run in case it hasn't been started yet for some reason.
			// This is useful for example after a failed local smoke test.
			await this.localFileSystem.startDirectoryWatcher()

			postMessageToMain({
				type: "cycleStarted",
				syncPair: this.syncPair
			})

			// Smoke-test BEFORE acquiring the lock. The local smoke test retries every SYNC_INTERVAL for as
			// long as the local path is unavailable (an unmounted drive, a disconnected network FS). Under the
			// lock that would hold the account lock for the WHOLE outage and starve every other device; run
			// outside it, an outage stalls only this pair's cycle.
			await this.smokeTest()

			const acquireLockMessageTimeout = setTimeout(() => {
				postMessageToMain({
					type: "cycleAcquiringLockStarted",
					syncPair: this.syncPair
				})
			}, 3000)

			await this.lock.acquire()

			clearTimeout(acquireLockMessageTimeout)

			postMessageToMain({
				type: "cycleAcquiringLockDone",
				syncPair: this.syncPair
			})

			try {
				await this.localFileSystem.waitForLocalDirectoryChanges()

				postMessageToMain({
					type: "cycleWaitingForLocalDirectoryChangesDone",
					syncPair: this.syncPair
				})

				const gettingTreesMessageTimeout = setTimeout(() => {
					postMessageToMain({
						type: "cycleGettingTreesStarted",
						syncPair: this.syncPair
					})
				}, 1000)

				// Init the ignorer on every run. We might have changes in the physical .filenignore file
				await this.ignorer.initialize()

				// eslint-disable-next-line prefer-const
				let [currentLocalTree, currentRemoteTree] = await Promise.all([
					this.localFileSystem.getDirectoryTree(),
					this.remoteFileSystem.getDirectoryTree()
				])

				// An INCOMPLETE remote read must never be mistaken for deletions. Two shapes make it incomplete:
				// (1) an item whose metadata could not be decrypted (a corrupted entry or transient crypto fault),
				// and (2) a STRUCTURAL orphan — an item that decrypted fine but whose parent folder tuple was absent
				// from the /v3/dir/tree response, so it resolves to no path. Either way the item is absent from the
				// fresh tree, indistinguishable from a removal, so the remote-deletion pass would delete the synced
				// LOCAL copy: silent data loss. Recover from the persisted base by uuid and carry the last-known
				// state forward — any base remote item missing from this read is re-asserted at its base path (unless
				// that path was legitimately reused by a readable item). Genuine remote deletions simply wait for a
				// clean read (self-healing); a permanently-broken item only ever blocks its own neighbourhood's
				// deletions, never causes a wrong one. Mirrors the "malformed tree must not read as a mass-deletion"
				// guard in remote.ts and the local partial-scan guard below. Runs ONLY when the read was incomplete —
				// zero cost otherwise.
				if (currentRemoteTree.decryptErrors > 0 || currentRemoteTree.structuralErrors > 0) {
					const current = currentRemoteTree.result

					for (const uuid in this.previousRemoteTree.uuids) {
						const baseItem = this.previousRemoteTree.uuids[uuid]

						if (baseItem && !current.uuids[uuid] && !current.tree[baseItem.path]) {
							current.tree[baseItem.path] = baseItem
							current.uuids[uuid] = baseItem
							current.size += 1
						}
					}
				}

				// The exact local-side analog of the decrypt-error guard above. FastGlob scans the local tree with
				// suppressErrors:true, so a transient readdir failure on one directory (EIO/EACCES/ENOTDIR — routine on
				// SMB/NFS/removable media) silently omits that WHOLE subtree from the scan. Those items are then absent
				// from the fresh tree, indistinguishable from a deletion, so the local-deletion pass would trash their
				// synced CLOUD copies: silent data loss (the "files deleted / GBs missing after a network hiccup" field
				// class). getDirectoryTree counts the failed enumerations as scanIncomplete; when >0 we re-assert every
				// base local item still missing from this read at its last-known state, so no deletion is emitted. A
				// genuine deletion simply waits for a clean scan (self-healing); a persistently-failing directory only
				// ever blocks its own subtree's deletions, never causes a wrong one. The inode index is only re-pointed
				// when the slot is free, so a readable item that legitimately reused the inode is never clobbered. Runs
				// ONLY when a scan error occurred — zero cost on every healthy cycle.
				if (currentLocalTree.scanIncomplete > 0) {
					const current = currentLocalTree.result

					for (const path in this.previousLocalTree.tree) {
						const baseItem = this.previousLocalTree.tree[path]

						if (baseItem && !current.tree[path]) {
							current.tree[path] = baseItem

							if (!current.inodes[baseItem.inode]) {
								current.inodes[baseItem.inode] = baseItem
							}

							current.size += 1
						}
					}
				}

				clearTimeout(gettingTreesMessageTimeout)

				postMessageToMain({
					type: "cycleGettingTreesDone",
					syncPair: this.syncPair
				})

				postMessageToMain({
					type: "localTreeErrors",
					syncPair: this.syncPair,
					data: {
						errors: currentLocalTree.errors.map(e => ({
							...e,
							error: serializeError(e.error)
						}))
					}
				})

				this.localTreeErrors = currentLocalTree.errors

				// Only continue if we did not encounter any local tree related errors
				if (this.localTreeErrors.length === 0) {
					postMessageToMain({
						type: "localTreeIgnored",
						syncPair: this.syncPair,
						data: {
							ignored: currentLocalTree.ignored
						}
					})

					// An approved deletion must NOT wait for the next tree change: both trees are served from cache
					// for up to LOCAL_RESCAN_SAFETY_INTERVAL, so bailing out here would leave the user's "yes"
					// unapplied for up to a minute after the click. The cached trees are exactly the ones the
					// prompt was computed from, so re-deriving the deltas from them reproduces the approved set.
					if (!currentLocalTree.changed && !currentRemoteTree.changed && !this.approvedDeletionFingerprint) {
						// A decision is still outstanding: re-post it so the renderer's banner survives this cycle
						// (it clears the banner on cycleStarted), and do NOT report success over a pending mass
						// deletion. This replaces the 1 Hz resend the blocking wait used to do.
						if (this.promptedDeletionFingerprint && this.lastConfirmDeletionMessage) {
							postMessageToMain({
								type: "confirmDeletion",
								syncPair: this.syncPair,
								data: this.lastConfirmDeletionMessage
							})
						} else {
							postMessageToMain({
								type: "cycleSuccess",
								syncPair: this.syncPair
							})
						}

						postMessageToMain({
							type: "cycleNoChanges",
							syncPair: this.syncPair
						})

						return
					}

					postMessageToMain({
						type: "remoteTreeIgnored",
						syncPair: this.syncPair,
						data: {
							ignored: currentRemoteTree.ignored
						}
					})

					postMessageToMain({
						type: "cycleProcessingDeltasStarted",
						syncPair: this.syncPair
					})

					const {
						deltas,
						deleteLocalDirectoryCountRaw,
						deleteLocalFileCountRaw,
						deleteRemoteDirectoryCountRaw,
						deleteRemoteFileCountRaw,
						// The mode the deltas were computed under (snapshotted once inside process()). Use it for the
						// deletion-confirmation gate below so the gate and the delta set never disagree when
						// updateMode() races the cycle. (M6)
						mode: cycleMode
					} = await this.deltas.process({
						currentLocalTree: currentLocalTree.result,
						currentRemoteTree: currentRemoteTree.result,
						previousLocalTree: this.previousLocalTree,
						previousRemoteTree: this.previousRemoteTree,
						currentLocalTreeErrors: currentLocalTree.errors,
						currentLocalTreeIgnored: currentLocalTree.ignored
					})

					postMessageToMain({
						type: "deltasCount",
						syncPair: this.syncPair,
						data: {
							count: deltas.length
						}
					})

					postMessageToMain({
						type: "deltasSize",
						syncPair: this.syncPair,
						data: {
							size: deltas.reduce(
								(prev, delta) => prev + (delta.type === "uploadFile" || delta.type === "downloadFile" ? delta.size : 0),
								0
							)
						}
					})

					postMessageToMain({
						type: "cycleProcessingDeltasDone",
						syncPair: this.syncPair
					})

					// Items this cycle would delete on each side. RAW counts (pre-collapse): rename/move detection
					// already decremented them, but nothing downstream can quietly shrink them below the gate.
					const remoteDeleteCount = deleteRemoteDirectoryCountRaw + deleteRemoteFileCountRaw
					const localDeleteCount = deleteLocalDirectoryCountRaw + deleteLocalFileCountRaw

					// The count at which we ask. The base rule is the previous tree's size ("everything we knew
					// about is being deleted"); a configured threshold is an ABSOLUTE number of deletions that
					// can only LOWER that bar, never raise it — min(), not ??. A threshold of 500 on a 10-item
					// pair must not mean "wiping this pair is fine", which is exactly what a plain override
					// would have meant: the wipe guarantee is the feature the setting refines, not one it may
					// switch off. The original rule also required the side to be EMPTY now; that is dropped,
					// since a threshold below the tree size could never satisfy it. Consequence on the default
					// path: a cycle that deletes the whole known tree AND creates new items now prompts too —
					// deliberate, and in the safe direction.
					const threshold = this.largeDeletionThreshold ?? Infinity
					const localDeletionTrigger = Math.min(threshold, this.previousLocalTree.size)
					const remoteDeletionTrigger = Math.min(threshold, this.previousRemoteTree.size)

					// Deletions APPLIED REMOTELY, caused by items vanishing LOCALLY — hence `where: "local"` and
					// the local tree as the reference size. `previousTree.size > 0` keeps a never-yet-scanned
					// pair (no base) from prompting on its first cycle.
					const confirmLocalDeletion =
						this.previousLocalTree.size > 0 &&
						remoteDeleteCount > 0 &&
						remoteDeleteCount >= localDeletionTrigger &&
						(cycleMode === "twoWay" || cycleMode === "localToCloud")

					const confirmRemoteDeletion =
						this.previousRemoteTree.size > 0 &&
						localDeleteCount > 0 &&
						localDeleteCount >= remoteDeletionTrigger &&
						(cycleMode === "twoWay" || cycleMode === "cloudToLocal")

					let deferGatedDeletions = false

					// The gate ASKS, it does not WAIT. The cycle used to block here until a human clicked, holding
					// the account lock the whole time — every other device on the account stalled for as long as
					// the prompt went unanswered, and an ignored prompt stalled them forever. Deferring is now
					// cheap and correct (only the gated deletions are held back), so the cycle posts the prompt,
					// defers, and finishes; the answer is consumed by a later cycle.
					if (this.requireConfirmationOnLargeDeletion && (confirmLocalDeletion || confirmRemoteDeletion)) {
						const where = confirmLocalDeletion && confirmRemoteDeletion ? "both" : confirmLocalDeletion ? "local" : "remote"
						const count =
							confirmLocalDeletion && confirmRemoteDeletion
								? remoteDeleteCount + localDeleteCount
								: confirmLocalDeletion
								? remoteDeleteCount
								: localDeleteCount
						// An approval is bound to WHAT THE USER WAS SHOWN — the side and the number of items. If the
						// deletion set grew (or moved to the other side) between the prompt and the click, the
						// fingerprint no longer matches and the user is asked again rather than having their "yes"
						// silently applied to a bigger deletion than the one they agreed to.
						const fingerprint = `${where}:${count}`

						if (this.approvedDeletionFingerprint === fingerprint) {
							// One approval, one cycle: consumed here so a later, identical-looking deletion has to
							// be confirmed on its own.
							this.approvedDeletionFingerprint = null
							this.promptedDeletionFingerprint = null
							this.deletionConfirmationResult = "waiting"
						} else {
							// Any approval still on file was for a different set — drop it rather than carry it.
							this.approvedDeletionFingerprint = null
							this.promptedDeletionFingerprint = fingerprint
							this.lastConfirmDeletionMessage = {
								where,
								previous:
									confirmLocalDeletion && confirmRemoteDeletion
										? this.previousLocalTree.size + this.previousRemoteTree.size
										: confirmLocalDeletion
										? this.previousLocalTree.size
										: this.previousRemoteTree.size,
								current:
									confirmLocalDeletion && confirmRemoteDeletion
										? currentLocalTree.result.size + currentRemoteTree.result.size
										: confirmLocalDeletion
										? currentLocalTree.result.size
										: currentRemoteTree.result.size,
								count
							}

							postMessageToMain({
								type: "confirmDeletion",
								syncPair: this.syncPair,
								data: this.lastConfirmDeletionMessage
							})

							deferGatedDeletions = true
						}
					} else {
						// The gate did not arm: whatever was pending is moot (the user restored the files, changed
						// the mode, or raised the threshold). Clearing it stops cycleSuccess from being suppressed
						// forever by a prompt nobody can answer any more.
						this.promptedDeletionFingerprint = null
						this.approvedDeletionFingerprint = null
						this.lastConfirmDeletionMessage = null
					}

					// Declined (or unanswered / paused mid-wait): drop ONLY the deletions the gate is about and run
					// the rest of the cycle. Skipping every task instead — the old behavior — held uploads and
					// downloads hostage to a prompt nobody had answered yet, and with a low threshold that stall is
					// routine rather than a once-in-a-lifetime full wipe. The base tree is deliberately NOT advanced
					// below, so the deferred deletions are re-detected (and re-prompted) next cycle; nothing is
					// silently forgotten, and the remote copies are never resurrected as "new" items.
					// Everything else queued for a PATH whose deletion is deferred waits with it. Changing an item's type
					// (a folder "notes" replaced by a file "notes") emits a delete AND a create for that one path, and the
					// create cannot succeed while the old item is still there — both sides refuse it, the cloud with
					// "a directory with that name exists" and the local FS with EISDIR. Letting it run would just fail a
					// doomed task and raise a task error on every declined cycle, on top of a prompt already waiting.
					let deltasToProcess = deltas

					if (deferGatedDeletions) {
						const gatedDeletionTypes = new Set<Delta["type"]>([
							...(confirmLocalDeletion ? (["deleteRemoteDirectory", "deleteRemoteFile"] as const) : []),
							...(confirmRemoteDeletion ? (["deleteLocalDirectory", "deleteLocalFile"] as const) : [])
						])
						// Lower-cased: on a case-insensitive volume replacing folder "Notes" with file "notes" yields a
						// gated delete at "/Notes" (previous tree's spelling) and a create at "/notes" (current tree's) —
						// they must match. On a case-sensitive volume this can only OVER-defer a case-colliding path,
						// which merely delays it one prompt; under-deferring runs a doomed task every declined cycle.
						const deferredPaths = new Set(
							deltas.filter(delta => gatedDeletionTypes.has(delta.type)).map(delta => delta.path.toLowerCase())
						)
						// A path is deferred when it IS a gated deletion (their own paths are in the set — this also
						// drops the deletions themselves) or lives UNDER one: collapseDeltas leaves only the parent
						// directory's delete delta, so a create/download at "/a/new.txt" beneath a gated "/a" would
						// otherwise slip through and resurrect part of the very tree the user is deciding about.
						const isDeferredPath = (path: string): boolean => {
							let current = path.toLowerCase()

							while (true) {
								if (deferredPaths.has(current)) {
									return true
								}

								const parentEnd = current.lastIndexOf("/")

								if (parentEnd <= 0) {
									return false
								}

								current = current.slice(0, parentEnd)
							}
						}

						// Renames wait too, whatever their path. Rename detection is not a property of one side: a move is
						// only emitted when the OTHER side still agrees with the base about the source path (see
						// remoteSourceUnchanged/localSourceUnchanged in deltas.ts). Executing a rename while the base is
						// deliberately frozen destroys that agreement, so next cycle the move can no longer be proven and
						// decomposes into a deletion of the old path plus a creation of the new one. Nothing is lost (the old
						// path is gone on both sides, so deleting it is a no-op), but the deletion count the user is asked to
						// approve inflates -- a 3-file folder moved during a 2-item prompt re-prompts as 6 -- and an approval
						// already given for the smaller set stops matching its fingerprint.
						const deferredRenameTypes = new Set<Delta["type"]>([
							"renameLocalDirectory",
							"renameLocalFile",
							"renameRemoteDirectory",
							"renameRemoteFile"
						])

						deltasToProcess = deltas.filter(delta => !deferredRenameTypes.has(delta.type) && !isDeferredPath(delta.path))
					}
					postMessageToMain({
						type: "cycleProcessingTasksStarted",
						syncPair: this.syncPair
					})

					const { doneTasks, errors } = await this.tasks.process({ deltasSorted: deltasToProcess })

					postMessageToMain({
						type: "cycleProcessingTasksDone",
						syncPair: this.syncPair
					})

					postMessageToMain({
						type: "taskErrors",
						syncPair: this.syncPair,
						data: {
							errors: errors.map(e => ({
								...e,
								error: serializeError(e.error)
							}))
						}
					})

					this.taskErrors = errors

					// Advance the base + persist state ONLY when the cycle finished cleanly and was NOT paused/
					// removed mid-processing. When paused, processTask SKIPPED the remaining tasks so this cycle
					// could return and release the account lock; advancing the base here would fold the skipped
					// work into it as already-synced (a pending upload would never fire again). Leaving the base
					// untouched makes the next cycle after resume re-fetch fresh trees and redo exactly the
					// outstanding work — the completed tasks are reflected in those fresh trees, so nothing is
					// re-done wrongly and nothing is lost (skip-and-restart, like the deletion-confirmation gate).
					if (this.taskErrors.length === 0 && !this.paused && !this.removed) {
						if (doneTasks.length > 0) {
							postMessageToMain({
								type: "cycleApplyingStateStarted",
								syncPair: this.syncPair
							})

							const didLocalChanges = doneTasks.some(
								task =>
									task.type === "createLocalDirectory" ||
									task.type === "deleteLocalDirectory" ||
									task.type === "deleteLocalFile" ||
									task.type === "renameLocalDirectory" ||
									task.type === "renameLocalFile"
							)
							const didRemoteChanges = doneTasks.some(
								task =>
									task.type === "renameRemoteDirectory" ||
									task.type === "renameRemoteFile" ||
									task.type === "createRemoteDirectory" ||
									task.type === "deleteRemoteDirectory" ||
									task.type === "deleteRemoteFile"
							)

							// Here we reset the internal local/remote tree changed times so we rescan after we did changes for consistency
							if (didLocalChanges) {
								this.localFileSystem.lastDirectoryChangeTimestamp = Date.now() - SYNC_INTERVAL * 2
								this.localFileSystem.getDirectoryTreeCache = {
									timestamp: 0,
									tree: {},
									inodes: {},
									ignored: [],
									errors: [],
									size: 0,
									scanIncomplete: 0
								}
							}

							if (didRemoteChanges) {
								this.remoteFileSystem.getDirectoryTreeCache = {
									timestamp: 0,
									tree: {},
									uuids: {},
									ignored: [],
									size: 0
								}
							}

							/* 

							Removed due to redundancy. We do not need to apply the state again since we hold a reference to the FS (remote/local) "getDirectoryTreeCache" objects.
							
							const applied = this.state.applyDoneTasksToState({
								doneTasks,
								currentLocalTree: currentLocalTree.result,
								currentRemoteTree: currentRemoteTree.result
							})

							currentLocalTree.result = applied.currentLocalTree
							currentRemoteTree.result = applied.currentRemoteTree
							*/

							postMessageToMain({
								type: "cycleApplyingStateDone",
								syncPair: this.syncPair
							})
						}

						// The deletions the user declined were filtered out of this cycle, so the base must keep
						// describing the world BEFORE them. Advancing it would drop them from the delta set for good —
						// the remote copies would then read as new items and get downloaded back, silently undoing a
						// deletion the user never resolved. The cache invalidation above still runs: tasks DID happen.
						if (!deferGatedDeletions) {
							postMessageToMain({
								type: "cycleSavingStateStarted",
								syncPair: this.syncPair
							})

							// Snapshot the trees as the next cycle's base. We need NEW tree/inode/uuid MAPS so the
							// directory-tree cache's in-place incremental updates (the watcher add/remove/rename path)
							// can never bleed into the base — but the item objects can be SHARED by reference: an item
							// is always created fresh and replaced in the map, never mutated field-by-field, so the
							// base's items are immutable once snapshotted. A full structuredClone instead deep-copied
							// every item on every change-cycle — O(tree) CPU plus a second full copy of the tree in
							// memory — for isolation a shallow map copy already provides. (P3)
							// Derive `size` from the snapshotted tree, NOT from result.size. A cycle's transfer handlers
							// add/remove entries in the live tree cache's `.tree` in place but never touch its `.size`,
							// so result.size is a STALE primitive that disagrees with the tree after any upload/download/
							// delete. A stale 0 would defeat the large-deletion confirmation gate's `previousTree.size > 0`
							// guard in the universal first-sync case (an engine-seeded base). This matches exactly how
							// state.ts recomputes the size on RELOAD (Object.keys(tree).length), so the in-process base and
							// a restarted one agree. O(N) over an already-O(N) shallow map copy — negligible, once per cycle.
							const localTreeSnapshot = { ...currentLocalTree.result.tree }
							const remoteTreeSnapshot = { ...currentRemoteTree.result.tree }

							this.previousLocalTree = {
								tree: localTreeSnapshot,
								inodes: { ...currentLocalTree.result.inodes },
								size: Object.keys(localTreeSnapshot).length
							}
							this.previousRemoteTree = {
								tree: remoteTreeSnapshot,
								uuids: { ...currentRemoteTree.result.uuids },
								size: Object.keys(remoteTreeSnapshot).length
							}

							await this.state.save()

							postMessageToMain({
								type: "cycleSavingStateDone",
								syncPair: this.syncPair
							})
						}
					}

					// NOT on deferred cycles — same as main's skip path. The renderer clears the pending
					// confirmDeletion banner on cycleSuccess; emitting it here would dismiss an unresolved
					// mass-deletion warning (and, for a pair paused mid-prompt, nothing would ever re-create it).
					if (!deferGatedDeletions) {
						postMessageToMain({
							type: "cycleSuccess",
							syncPair: this.syncPair
						})
					}
				}
			} finally {
				postMessageToMain({
					type: "cycleReleasingLockStarted",
					syncPair: this.syncPair
				})

				await this.lock.release()

				postMessageToMain({
					type: "cycleReleasingLockDone",
					syncPair: this.syncPair
				})
			}
		} catch (e) {
			this.worker.logger.log("error", e, "sync.run")
			this.worker.logger.log("error", e)

			if (e instanceof Error) {
				postMessageToMain({
					type: "cycleError",
					syncPair: this.syncPair,
					data: {
						error: serializeError(e),
						uuid: uuidv4()
					}
				})
			}
		}
	}
}

export default Sync
