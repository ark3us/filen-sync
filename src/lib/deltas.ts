import type Sync from "./sync"
import { type SyncMode } from "../types"
import { type LocalTree, type LocalItem, type LocalTreeError, type LocalTreeIgnored } from "./filesystems/local"
import { type RemoteTree } from "./filesystems/remote"
import { replacePathStartWithFromAndTo, pathIncludesDotFile, normalizeLastModifiedMsForComparison, isSyncedIgnoreFile } from "../utils"

export type Delta = { path: string } & (
	| {
			type: "uploadFile"
			size: number
			md5Hash?: string
	  }
	| {
			type: "createRemoteDirectory"
	  }
	| {
			type: "createLocalDirectory"
	  }
	| {
			type: "deleteLocalFile"
	  }
	| {
			type: "deleteRemoteFile"
	  }
	| {
			type: "deleteLocalDirectory"
	  }
	| {
			type: "deleteRemoteDirectory"
	  }
	| {
			type: "downloadFile"
			size: number
	  }
	| {
			type: "renameLocalFile"
			from: string
			to: string
	  }
	| {
			type: "renameRemoteFile"
			from: string
			to: string
	  }
	| {
			type: "renameRemoteDirectory"
			from: string
			to: string
	  }
	| {
			type: "renameLocalDirectory"
			from: string
			to: string
	  }
)

/**
 * Collapses child rename/move/delete deltas into the parent-directory delta that already covers them.
 *
 * When a directory is renamed or deleted, the tree diff also emits a delta for every descendant (each
 * child's path changed too). Executing all of them is wasteful — the parent op already moves or removes
 * the whole subtree — so each child is folded into its parent here, saving disk usage and API calls.
 *
 * Pure and side-effect free so it can be unit-tested directly against adversarial delta arrays. Two
 * correctness properties that the previous in-place version did NOT guarantee:
 *
 *   1. Most-specific parent wins. A child can sit under more than one renamed ancestor (e.g. both
 *      "/a" -> "/x" and "/a/b" -> "/x/y" cover "/a/b/c.txt"). The longest-`from` ancestor is the
 *      immediate enclosing renamed directory, and its `to` already reflects every outer rename — so
 *      applying ONLY that one yields the correct post-rename source. Composing every match in array
 *      order (the old loop) was order-dependent and could mis-compose.
 *   2. No neighbour corruption. We build a fresh array instead of splicing the input while iterating.
 *      The old loop spliced `deltas[i]` in place, so a removal shifted an unrelated delta into slot `i`
 *      that a later iteration could overwrite — silently dropping a real op and leaving a bogus one.
 */
/**
 * Walk `path`'s ancestor directories from the immediate parent upward, returning the value of the FIRST
 * (deepest, i.e. longest) ancestor that is a key of `map` — the most-specific enclosing entry — or
 * `undefined`. Equivalent to scanning every entry for the longest key that is a strict ancestor of `path`
 * (`path.startsWith(key + "/")`), but O(depth) map lookups instead of O(entries) prefix comparisons. The
 * walk stops above the root and never returns `path` itself, matching the original `startsWith(key + "/")`
 * (strict-ancestor) semantics, including the "/" boundary that stops "/abc" matching a key of "/ab".
 */
function nearestAncestor<T>(path: string, map: ReadonlyMap<string, T>): T | undefined {
	let end = path.lastIndexOf("/")

	while (end > 0) {
		const hit = map.get(path.slice(0, end))

		if (hit !== undefined) {
			return hit
		}

		end = path.lastIndexOf("/", end - 1)
	}

	return undefined
}

/** Whether any strict ancestor directory of `path` is in `set` (same ancestor-walk as {@link nearestAncestor}). */
function hasAncestorIn(path: string, set: ReadonlySet<string>): boolean {
	let end = path.lastIndexOf("/")

	while (end > 0) {
		if (set.has(path.slice(0, end))) {
			return true
		}

		end = path.lastIndexOf("/", end - 1)
	}

	return false
}

export function collapseDeltas({
	deltas,
	renamedLocalDirectories,
	renamedRemoteDirectories,
	deletedLocalDirectories,
	deletedRemoteDirectories
}: {
	deltas: Delta[]
	renamedLocalDirectories: Delta[]
	renamedRemoteDirectories: Delta[]
	deletedLocalDirectories: Delta[]
	deletedRemoteDirectories: Delta[]
}): Delta[] {
	// Index the renamed/deleted directories by path so each child delta finds its nearest enclosing ancestor
	// via an O(depth) ancestor-walk instead of an O(directories) scan. A deep/wide directory move otherwise
	// makes this pass O(deltas * directories * pathLength) — super-linear, seconds-long for a large move (P1).
	const localRenameByFrom = new Map<string, Extract<Delta, { type: "renameLocalDirectory" }>>()
	const remoteRenameByFrom = new Map<string, Extract<Delta, { type: "renameRemoteDirectory" }>>()
	const localDeletedDirs = new Set<string>()
	const remoteDeletedDirs = new Set<string>()

	for (const directoryDelta of renamedLocalDirectories) {
		if (directoryDelta.type === "renameLocalDirectory") {
			localRenameByFrom.set(directoryDelta.from, directoryDelta)
		}
	}

	for (const directoryDelta of renamedRemoteDirectories) {
		if (directoryDelta.type === "renameRemoteDirectory") {
			remoteRenameByFrom.set(directoryDelta.from, directoryDelta)
		}
	}

	for (const directoryDelta of deletedLocalDirectories) {
		if (directoryDelta.type === "deleteLocalDirectory") {
			localDeletedDirs.add(directoryDelta.path)
		}
	}

	for (const directoryDelta of deletedRemoteDirectories) {
		if (directoryDelta.type === "deleteRemoteDirectory") {
			remoteDeletedDirs.add(directoryDelta.path)
		}
	}

	const collapsed: Delta[] = []

	for (const delta of deltas) {
		if (delta.type === "renameLocalDirectory" || delta.type === "renameLocalFile") {
			const parent = nearestAncestor(delta.from, localRenameByFrom)

			if (parent) {
				const newFromPath = replacePathStartWithFromAndTo(delta.from, parent.from, parent.to)

				// Equal to the target => the parent rename already lands the child here, so it is redundant.
				if (newFromPath !== delta.to) {
					collapsed.push({ ...delta, from: newFromPath })
				}

				continue
			}
		} else if (delta.type === "renameRemoteDirectory" || delta.type === "renameRemoteFile") {
			const parent = nearestAncestor(delta.from, remoteRenameByFrom)

			if (parent) {
				const newFromPath = replacePathStartWithFromAndTo(delta.from, parent.from, parent.to)

				if (newFromPath !== delta.to) {
					collapsed.push({ ...delta, from: newFromPath })
				}

				continue
			}
		} else if (delta.type === "deleteLocalDirectory" || delta.type === "deleteLocalFile") {
			if (hasAncestorIn(delta.path, localDeletedDirs)) {
				continue
			}
		} else if (delta.type === "deleteRemoteDirectory" || delta.type === "deleteRemoteFile") {
			if (hasAncestorIn(delta.path, remoteDeletedDirs)) {
				continue
			}
		}

		collapsed.push(delta)
	}

	return collapsed
}

/**
 * Find directories slated for deletion that STILL hold live content on the deleting-resistant side — a
 * freshly-added child, or a base child kept alive by newer-modify-wins — and must therefore survive.
 *
 * When one side deletes a directory and the other adds/keeps something inside it in the same cycle, the
 * raw delta set contains both `deleteXDirectory <dir>` and the child's own add. Left alone, collapseDeltas
 * subsumes the child's sibling DELETES under the dir-delete and the dir-delete then cascades over the
 * surviving child at execution time — wiping a brand-new file before it is ever propagated (data loss).
 * Newer content beats a delete (the same rule the per-file passes already apply), so the directory must
 * stay: drop its delete and let the surviving child's own add re-assert it.
 *
 * A child "survives under <dir>" iff it is present in the current tree (`tree`), is NOT itself slated for
 * deletion (same-direction `delete{File,Directory}`), and is NOT leaving via a rename — neither the child
 * itself nor any ancestor is the `from` of a same-direction `rename{File,Directory}` (a renamed directory
 * carries all its descendants out with it). Without the rename exclusion, a directory rename — which is
 * emitted as "rename the children to the new path + delete the now-empty old directory" — would look like
 * the old directory still has live children and never get deleted (its children are still at their old
 * paths in this pre-rebase tree). Returns the set of dir paths to KEEP. Pure: the caller applies the
 * pruning. Linear in tree size times depth; short-circuits when nothing is being deleted.
 */
export function directoriesWithSurvivingChildren(
	deltas: Delta[],
	dirDeleteType: "deleteLocalDirectory" | "deleteRemoteDirectory",
	fileDeleteType: "deleteLocalFile" | "deleteRemoteFile",
	renameDirType: "renameLocalDirectory" | "renameRemoteDirectory",
	renameFileType: "renameLocalFile" | "renameRemoteFile",
	tree: Record<string, unknown>
): Set<string> {
	const deletedDirPaths = new Set<string>()
	const deletedPaths = new Set<string>()
	const renamedFromPaths = new Set<string>()

	for (const delta of deltas) {
		if (delta.type === dirDeleteType) {
			deletedDirPaths.add(delta.path)
			deletedPaths.add(delta.path)
		} else if (delta.type === fileDeleteType) {
			deletedPaths.add(delta.path)
		} else if (delta.type === renameDirType || delta.type === renameFileType) {
			renamedFromPaths.add(delta.from)
		}
	}

	const keep = new Set<string>()

	if (deletedDirPaths.size === 0) {
		return keep
	}

	for (const path in tree) {
		if (deletedPaths.has(path) || renamedFromPaths.has(path)) {
			continue
		}

		// Walk the ancestor chain once, collecting any deleted-directory ancestors. If ANY ancestor is the
		// source of a rename, this whole subtree is moving away, so it keeps nothing alive — discard them.
		const deletedDirAncestors: string[] = []
		let leaving = false
		let parent = path
		let slash = parent.lastIndexOf("/")

		while (slash > 0) {
			parent = parent.slice(0, slash)

			if (renamedFromPaths.has(parent)) {
				leaving = true

				break
			}

			if (deletedDirPaths.has(parent)) {
				deletedDirAncestors.push(parent)
			}

			slash = parent.lastIndexOf("/")
		}

		if (!leaving) {
			for (const ancestor of deletedDirAncestors) {
				keep.add(ancestor)
			}
		}
	}

	return keep
}

/**
 * Whether the NEAREST EXISTING ancestor of `path` in `tree` is a NON-directory (a file). Used to veto a
 * rename whose destination cannot be reached because an ancestor is currently a file being type-changed
 * into a directory in the same cycle — the file↔directory name-swap family, including the deep case where
 * a moved child lands in a brand-new subdirectory of the type-changing file (e.g. `/a` (file) → `/a/sub/
 * child.txt`, where `/a/sub` is absent but `/a` is still a file). The backend cannot create a directory
 * under a file, so the move would silently fail and lose the child; suppressing it lets the addition pass
 * rebuild the child under the freshly-created directory instead.
 *
 * Walks UP from the immediate parent to the first ancestor that EXISTS in `tree`: a file there blocks the
 * rename; a directory (or reaching the root with only absent ancestors — they will be created) does not.
 * An absent immediate parent therefore stays a cheap server-side rename (no re-upload) for the common
 * "move into a brand-new directory" case. O(depth), evaluated only for an already-identified rename
 * candidate (a path that actually changed), so it never touches the unchanged bulk of a large tree.
 */
function renameDestinationBlockedByFileAncestor(
	tree: { tree: Record<string, { type: "file" | "directory" } | undefined> },
	path: string
): boolean {
	let slash = path.lastIndexOf("/")

	// Walk ancestors from the immediate parent upward; stop at the root ("/x" has slash === 0).
	while (slash > 0) {
		const ancestor = tree.tree[path.slice(0, slash)]

		if (ancestor) {
			// Nearest existing ancestor decides: a file blocks the rename, a directory permits it.
			return ancestor.type !== "directory"
		}

		slash = path.lastIndexOf("/", slash - 1)
	}

	// No existing ancestor before the root: every intermediate will be created as a directory.
	return false
}

/**
 * Whether an ADDITION at `path` cannot be written because the nearest existing ancestor on the DESTINATION
 * side is a FILE that will NOT be replaced by a directory this cycle. The backend cannot place a child under a
 * file, so emitting the upload/mkdir would be rejected EVERY cycle and wedge the pair on a repeating
 * taskError. This is the additive-backup foreign-type-change case: localBackup tolerates a foreign remote
 * dir→file at `/d` (reverting it would delete the backup), but still tried to back up `/d/child` under the
 * remote file. A file ancestor CLAIMED FOR REPLACEMENT this cycle (`pathsAdded[ancestor]` — the type-change
 * pass emitted a create*Directory for it, which runs first in phase order) is NOT a blocker; only an
 * unreplaced one is. Suppressing the addition leaves the subtree un-synced until the foreign file is removed —
 * no wedge, and the additive contract (never delete the foreign side) is preserved. Walks to the nearest
 * existing ancestor; O(depth), evaluated only for an addition candidate, so it never scans the unchanged bulk.
 */
function additionBlockedByUnreplacedFileAncestor(
	tree: { tree: Record<string, { type: "file" | "directory" } | undefined> },
	path: string,
	pathsAdded: Record<string, boolean>
): boolean {
	let slash = path.lastIndexOf("/")

	while (slash > 0) {
		const ancestorPath = path.slice(0, slash)
		const ancestor = tree.tree[ancestorPath]

		if (ancestor) {
			// Nearest existing ancestor decides: a file blocks — unless it is being replaced by a directory this
			// cycle (its create*Directory delta runs before this addition). A directory never blocks.
			return ancestor.type !== "directory" && !pathsAdded[ancestorPath]
		}

		slash = path.lastIndexOf("/", slash - 1)
	}

	// No existing ancestor before the root: every intermediate will be created as a directory.
	return false
}

/**
 * Whether a directory rename `fromDir` → `toDir` is corroborated by a surviving child IDENTITY: some inode
 * that lived under `fromDir` in the base now lives under `toDir` in the current tree. Used only as a
 * fallback when the directory's birthtime does not match across the rename (a platform that rewrites a
 * directory's creation time on rename — observed on Windows), to tell a genuine move from an inode-reuse
 * coincidence: a reused directory inode belongs to a brand-new directory that shares NONE of the old
 * children, so it finds no corroborating child and is still rejected. O(inodes), short-circuits on the
 * first match, and only evaluated for a directory rename candidate whose birthtime already failed the
 * cheap equality/zero checks — so it never runs on the normal path.
 */
export function directoryRenameCorroboratedByChild(fromDir: string, toDir: string, currentTree: LocalTree, previousTree: LocalTree): boolean {
	const fromPrefix = `${fromDir}/`
	const toPrefix = `${toDir}/`

	for (const inode in currentTree.inodes) {
		const current = currentTree.inodes[inode]
		const previous = previousTree.inodes[inode]

		if (current && previous && current.path.startsWith(toPrefix) && previous.path.startsWith(fromPrefix)) {
			return true
		}
	}

	return false
}

/**
 * Whether a matching inode across a LOCAL path change is corroborated as a GENUINE rename (vs an ext4-style
 * inode-reuse coincidence, where "delete a.txt + create c.txt" lands c.txt on a.txt's freed inode). A genuine
 * rename preserves the file's birthtime; a reused inode belongs to a freshly-created file with a newer one.
 *
 * The birthtime signal is unavailable on whole volumes that report `creation` as 0 (SMB/CIFS/tmpfs/old-ext4).
 * MIRROR modes (twoWay/localToCloud) may still DEGRADE to inode-only there, because a phantom rename
 * self-heals: the stale source path was going to be deleted anyway, and F1 re-uploads the new content — the
 * worlds converge. But an ADDITIVE backup (localBackup) NEVER propagates the source deletion, so a phantom
 * file rename would rename the kept backup out from under the original name and destroy it: permanent, silent
 * data loss. On a birthtime-0 volume the inode-only degradation gives that mode ZERO protection, so for
 * localBackup a FILE rename requires a RELIABLE (both non-zero, equal) birthtime, and a DIRECTORY rename
 * requires surviving-child identity (a reused dir inode has none of the old children). When neither holds the
 * candidate is left to the delete+add passes, which for an additive backup simply keep the old copy and
 * upload the new one — exactly the mode's contract.
 *
 * Checks are ordered cheapest-first and the O(inodes) child-identity walk is only reached as a last resort,
 * so the normal path pays nothing.
 */
export function localRenameCorroborated(
	mode: SyncMode,
	currentItem: LocalItem,
	previousItem: LocalItem,
	currentLocalTree: LocalTree,
	previousLocalTree: LocalTree
): boolean {
	// A reliable (both non-zero, equal) birthtime is a genuine-rename signal in every mode.
	if (currentItem.creation !== 0 && previousItem.creation !== 0 && currentItem.creation === previousItem.creation) {
		return true
	}

	// Birthtime unreliable (reported 0 on either side). A mirror mode degrades to inode-only; an additive
	// backup must NOT (a phantom file rename would destroy the kept backup).
	if (mode !== "localBackup" && (currentItem.creation === 0 || previousItem.creation === 0)) {
		return true
	}

	// Last resort (both modes): a DIRECTORY rename corroborated by a surviving child's identity — reliable even
	// when the birthtime was rewritten (Windows) or is unavailable, and a reused dir inode is still rejected.
	return (
		currentItem.type === "directory" &&
		directoryRenameCorroboratedByChild(previousItem.path, currentItem.path, currentLocalTree, previousLocalTree)
	)
}

/**
 * Remaps `path` across a set of propagated directory renames, returning its post-rename path (unchanged if
 * none applies). The most-specific (longest `from`) ancestor wins, and each rename's `to` already encodes
 * any outer renames (the rename pass records every directory's FINAL position), so one pass handles
 * independent AND nested directory renames correctly.
 */
export function rebasePathAcrossRenames(path: string, renames: { from: string; to: string }[]): string {
	let best: { from: string; to: string } | undefined

	for (const rename of renames) {
		if (path.startsWith(`${rename.from}/`) && (!best || rename.from.length > best.from.length)) {
			best = rename
		}
	}

	return best ? best.to + path.slice(best.from.length) : path
}

/**
 * Returns a COPY of `tree` with every DESCENDANT of a renamed directory moved to its post-rename path. The
 * input is never mutated (entries outside any renamed subtree are shared by reference). The renamed
 * directory nodes themselves are NOT moved here — they are handled via `pathsAdded` — only their children.
 * Used to realign the base + the not-yet-renamed side so the per-descendant passes attribute change at the
 * correct post-rename path (BUG-A / BUG-B).
 */
export function rebaseLocalTreeAcrossRenames(tree: LocalTree, renames: { from: string; to: string }[]): LocalTree {
	// No rename touches this tree (the common single-direction cycle) — return it as-is rather than copying
	// the whole map for nothing. (P1)
	if (renames.length === 0) {
		return tree
	}

	// Index renames by `from` so each entry locates its nearest renamed ancestor in O(depth), not O(renames).
	const renameByFrom = new Map(renames.map(rename => [rename.from, rename]))
	const newTree: LocalTree["tree"] = {}
	const newINodes: LocalTree["inodes"] = {}

	for (const path in tree.tree) {
		const item = tree.tree[path]!
		const parent = nearestAncestor(path, renameByFrom)
		const rebasedPath = parent ? parent.to + path.slice(parent.from.length) : path
		const newItem = rebasedPath === path ? item : { ...item, path: rebasedPath }

		newTree[rebasedPath] = newItem
		newINodes[newItem.inode] = newItem
	}

	return { tree: newTree, inodes: newINodes, size: tree.size }
}

export function rebaseRemoteTreeAcrossRenames(tree: RemoteTree, renames: { from: string; to: string }[]): RemoteTree {
	if (renames.length === 0) {
		return tree
	}

	const renameByFrom = new Map(renames.map(rename => [rename.from, rename]))
	const newTree: RemoteTree["tree"] = {}
	const newUUIDs: RemoteTree["uuids"] = {}

	for (const path in tree.tree) {
		const item = tree.tree[path]!
		const parent = nearestAncestor(path, renameByFrom)
		const rebasedPath = parent ? parent.to + path.slice(parent.from.length) : path
		const newItem = rebasedPath === path ? item : { ...item, path: rebasedPath }

		newTree[rebasedPath] = newItem
		newUUIDs[newItem.uuid] = newItem
	}

	return { tree: newTree, uuids: newUUIDs, size: tree.size }
}

/**
 * Deltas
 * @date 3/1/2024 - 11:11:32 PM
 *
 * @export
 * @class Deltas
 * @typedef {Deltas}
 */
export class Deltas {
	private readonly sync: Sync

	/**
	 * Creates an instance of Deltas.
	 *
	 * @constructor
	 * @public
	 * @param {Sync} sync
	 */
	public constructor(sync: Sync) {
		this.sync = sync
	}

	/**
	 * Process the directory trees and return all sync deltas.
	 *
	 * @public
	 * @async
	 * @param {{
	 * 		currentLocalTree: LocalTree
	 * 		currentRemoteTree: RemoteTree
	 * 		previousLocalTree: LocalTree
	 * 		previousRemoteTree: RemoteTree
	 * 		currentLocalTreeErrors: LocalTreeError[]
	 * 	}} param0
	 * @param {LocalTree} param0.currentLocalTree
	 * @param {RemoteTree} param0.currentRemoteTree
	 * @param {LocalTree} param0.previousLocalTree
	 * @param {RemoteTree} param0.previousRemoteTree
	 * @param {{}} param0.currentLocalTreeErrors
	 * @returns {Promise<{
	 * 		deltas: Delta[],
	 * 		deleteLocalDirectoryCountRaw: number
	 * 		deleteLocalFileCountRaw: number
	 * 		deleteRemoteDirectoryCountRaw: number
	 * 		deleteRemoteFileCountRaw: number
	 * 	}>}
	 */
	public async process({
		currentLocalTree,
		currentRemoteTree,
		previousLocalTree,
		previousRemoteTree,
		currentLocalTreeErrors,
		currentLocalTreeIgnored
	}: {
		currentLocalTree: LocalTree
		currentRemoteTree: RemoteTree
		previousLocalTree: LocalTree
		previousRemoteTree: RemoteTree
		currentLocalTreeErrors: LocalTreeError[]
		currentLocalTreeIgnored: LocalTreeIgnored[]
	}): Promise<{
		deltas: Delta[]
		deleteLocalDirectoryCountRaw: number
		deleteLocalFileCountRaw: number
		deleteRemoteDirectoryCountRaw: number
		deleteRemoteFileCountRaw: number
		mode: SyncMode
	}> {
		// Snapshot the mode ONCE for the whole cycle. process() is async (it awaits hashing), and updateMode()
		// mutates this.sync.mode synchronously from the main thread at any time. Reading this.sync.mode live in
		// each of the ~20 passes below let a mid-cycle mode switch split one cycle across two modes — e.g. the
		// local-deletions pass running as twoWay while the remote-deletions pass runs as cloudToLocal — yielding
		// a self-contradictory delta set. The snapshot is returned so the caller's deletion-confirmation gate
		// evaluates against the SAME mode the deltas were computed under; a mode change takes effect next cycle.
		const mode = this.sync.mode

		if (this.sync.removed) {
			return {
				deltas: [],
				deleteLocalDirectoryCountRaw: 0,
				deleteLocalFileCountRaw: 0,
				deleteRemoteDirectoryCountRaw: 0,
				deleteRemoteFileCountRaw: 0,
				mode
			}
		}

		let deltas: Delta[] = []
		const pathsAdded: Record<string, boolean> = {}
		const erroredLocalPaths: Record<string, boolean> = {}
		const ignoredLocalPaths: Record<string, boolean> = {}
		const renamedRemoteDirectories: Delta[] = []
		const renamedLocalDirectories: Delta[] = []
		const deletedRemoteDirectories: Delta[] = []
		const deletedLocalDirectories: Delta[] = []
		// A directory rename's `from`/`to` on the delta is expressed in the OPERATING side's CURRENT-tree paths
		// (where the executor must find and place it), which for a rename cross-blocked by the OTHER side's
		// ancestor rename differs from its BASE path. The base-tree rebase below must instead key off the BASE
		// path (that is where the item sits in the not-yet-rebased base), so remember each dir rename's base
		// `from` here. Identity for an un-cross-blocked rename (base path === current path). (#10)
		const dirRenameBaseFrom = new Map<Delta, string>()
		let deleteLocalDirectoryCountRaw = 0
		let deleteLocalFileCountRaw = 0
		let deleteRemoteDirectoryCountRaw = 0
		let deleteRemoteFileCountRaw = 0

		for (const error of currentLocalTreeErrors) {
			erroredLocalPaths[error.relativePath] = true
		}

		// A path that physically exists locally but is currently NOT syncable — a symlink, an
		// unreadable/permission-denied entry, a case-insensitive duplicate, a special device, an
		// over-long name — is recorded as "ignored", never as a deletion. Suppressing remote-deletes for
		// these preserves the cloud copy of a path that was synced before it became ignored (e.g. a file
		// now skipped because it is a symlink after upgrading to lstat), mirroring how the .filenignore
		// filter below already protects ignored paths. (BUG-006)
		for (const ignored of currentLocalTreeIgnored) {
			ignoredLocalPaths[ignored.relativePath] = true
		}

		// A structurally ignored/errored DIRECTORY (one that became a symlink, an unreadable/permission-denied
		// dir, ...) HIDES its whole subtree from the local scan: the walk records the ancestor and never
		// enumerates what is behind it. Those descendants are present in the base + on the OTHER side but absent
		// from the current local tree, so without protection the deletion passes would mis-read them as "locally
		// gone" and wipe their still-valid counterpart (silent CLOUD data loss when a synced folder is replaced
		// by a symlink), and the additions pass would try to re-download them ONTO the symlink — failing to write
		// under it and WEDGING every cycle. Extend the BUG-006 / M4 "ignore ≠ delete" protection to the whole
		// subtree AND to the re-download path: an ignored/errored path or any descendant of one is left exactly
		// as the user left it — never deleted, never re-fetched. The cheap O(1) exact checks (ignoredLocalPaths/
		// erroredLocalPaths) stay in the per-pass guards; this predicate adds the O(depth) ANCESTOR walk, gated
		// so a clean scan pays nothing and the walk only runs at an actual delete/download decision (few paths),
		// never across the unchanged bulk of the tree. (Maintainer decision 2026-06-29 — "keep them".)
		const ignoredOrErroredLocalPaths = new Set<string>([...Object.keys(erroredLocalPaths), ...Object.keys(ignoredLocalPaths)])
		const hasIgnoredOrErroredLocalAncestors = ignoredOrErroredLocalPaths.size > 0
		const hasIgnoredOrErroredLocalAncestor = (path: string): boolean =>
			hasIgnoredOrErroredLocalAncestors && hasAncestorIn(path, ignoredOrErroredLocalPaths)

		// The order of delta processing:
		// 1. Local directory/file move/rename
		// 2. Remote directory/file move/rename
		// 3. Local deletions
		// 4. Remote deletions
		// 5. Local additions/filemodifications
		// 6. Remote additions/filemodifications

		// The REMOTE's own directory renames this cycle (uuid preserved, path changed), used ONLY to rebase a
		// LOCAL rename's remote-source lookup when the remote renamed an ANCESTOR directory in the same cycle
		// (the cross-side nested rename, #10 / XD4). The pass below runs BEFORE the remote-rename pass, so unlike
		// the remote pass — which reuses the already-emitted local renames — it has no emitted list to consult and
		// derives the geometry directly. Built at most once per cycle and ONLY when a base-path source lookup
		// actually misses, so a cycle without a cross-blocked local rename never pays the O(remote) scan.
		let remoteGeoDirRenamesCache: { from: string; to: string }[] | null = null
		const getRemoteGeoDirRenames = (): { from: string; to: string }[] => {
			if (remoteGeoDirRenamesCache === null) {
				remoteGeoDirRenamesCache = []

				for (const uuid in currentRemoteTree.uuids) {
					const cur = currentRemoteTree.uuids[uuid]
					const prev = previousRemoteTree.uuids[uuid]

					if (cur && prev && cur.type === "directory" && prev.type === "directory" && cur.path !== prev.path) {
						remoteGeoDirRenamesCache.push({ from: prev.path, to: cur.path })
					}
				}
			}

			return remoteGeoDirRenamesCache
		}

		// Local file/directory move/rename
		if (mode === "twoWay" || mode === "localBackup" || mode === "localToCloud") {
			for (const inode in currentLocalTree.inodes) {
				const currentItem = currentLocalTree.inodes[inode]
				const previousItem = previousLocalTree.inodes[inode]

				if (
					!currentItem ||
					!previousItem ||
					pathsAdded[currentItem.path] ||
					pathsAdded[previousItem.path] ||
					erroredLocalPaths[currentItem.path] ||
					erroredLocalPaths[previousItem.path]
				) {
					continue
				}

				// Path from current item changed, it was either renamed or moved (same type)
				if (
					currentItem.path !== previousItem.path &&
					currentItem.type === previousItem.type &&
					// A matching inode is NOT sufficient proof of a rename. The OS recycles inode numbers, and
					// ext4 hands a freed inode straight to the next file created — so "delete a.txt + create
					// c.txt" can land c.txt on a.txt's old inode and be misread as "rename a.txt -> c.txt".
					// That phantom rename propagates as a REMOTE rename and DELETES the original: silent data
					// loss in modes that keep deletions (localBackup), and invisible in twoWay only because the
					// stale path was going to be deleted anyway. A genuine rename preserves the file's
					// creation/birthtime (even a rename+modify only touches mtime/size); a reused inode belongs
					// to a freshly-created file with a newer birthtime. Require both to match. Two safe relaxations
					// for platforms that report birthtime unreliably (without ever weakening the ext4 file
					// inode-reuse protection, which always yields two DIFFERENT non-zero birthtimes):
					//   (a) treat 0 on EITHER side as "unknown" and degrade to inode-only — a fs that cannot report
					//       a birthtime reads 0;
					//   (b) for a DIRECTORY whose birthtime changed, corroborate by IDENTITY — if a child inode that
					//       lived under the old path now lives under the new path, this is the same directory moving,
					//       not an inode-reuse coincidence (a reused inode belongs to a brand-new directory that has
					//       NONE of the old children). Windows was observed to rewrite a directory's birthtime across
					//       a rename, which silently broke cross-side dir-rename reconciliation; (b) restores it
					//       while a reused dir inode (no surviving children) is still correctly rejected.
					// (F8 — inode reuse; birthtime-unreliable hardening; #5 — a birthtime-0 volume must not let an
					// inode-reuse coincidence become a phantom rename that destroys a localBackup copy)
					localRenameCorroborated(mode, currentItem, previousItem, currentLocalTree, previousLocalTree) &&
					// Does ANY item already occupy the rename target in the current remote tree? If so, do not
					// propagate the rename. A same-type occupant was probably moved there by something else; a
					// DIFFERENT-type occupant (e.g. a file↔directory name swap) cannot be overwritten by a rename
					// on the backend at all — renaming a file onto a directory's name (or vice versa) silently
					// fails and the worlds diverge. In both cases the correct resolution is to leave the path
					// unmarked so the type-change / addition / deletion passes rebuild it via delete+recreate.
					!currentRemoteTree.tree[currentItem.path] &&
					// Nor may the destination's PARENT currently be a file: a child moving into a directory that is
					// itself being type-changed from a file in the same cycle (the non-empty file↔dir name swap)
					// cannot be placed under that file on the backend. Suppress so the addition pass rebuilds the
					// child under the freshly-created directory; an ABSENT parent stays a cheap rename (no re-upload).
					!renameDestinationBlockedByFileAncestor(currentRemoteTree, currentItem.path) &&
					// Because only comparing strings can be weird sometimes
					Buffer.from(currentItem.path, "utf-8").toString("hex") !== Buffer.from(previousItem.path, "utf-8").toString("hex")
				) {
					// Only propagate the rename if the REMOTE source is unchanged since the base — the same
					// node (uuid) still sits at the old path. If the other side deleted, modified, or renamed
					// that file/directory in the same window, renaming the stale remote node is invalid: skip
					// it, leave the paths unmarked, and let the renamed item be re-added under its new name
					// while the other side's change is applied by its own pass. The worlds still converge,
					// keeping both edits rather than silently dropping one. (F2–F4)
					//
					// The source is looked up in the current remote tree at the base path. When that MISSES, the
					// remote may have carried the source elsewhere by renaming an ANCESTOR directory this cycle:
					// rebase the base path across the remote's own dir renames and retry, so a cross-side nested
					// rename composes instead of decomposing into delete+add (#10 / XD4, symmetric to the remote
					// pass). The geo scan is built lazily on this first miss, so the common case never pays it.
					let remoteSourcePath = previousItem.path
					let remoteRebasedTarget = currentItem.path
					let remoteSource = currentRemoteTree.tree[remoteSourcePath]

					if (!remoteSource) {
						const rebasedSource = rebasePathAcrossRenames(previousItem.path, getRemoteGeoDirRenames())

						if (rebasedSource !== remoteSourcePath) {
							remoteSourcePath = rebasedSource
							remoteRebasedTarget = rebasePathAcrossRenames(currentItem.path, getRemoteGeoDirRenames())
							remoteSource = currentRemoteTree.tree[remoteSourcePath]
						}
					}

					const baseRemoteSource = previousRemoteTree.tree[previousItem.path]
					const remoteSourceUnchanged = !!remoteSource && !!baseRemoteSource && remoteSource.uuid === baseRemoteSource.uuid

					if (!remoteSourceUnchanged) {
						continue
					}

					const delta: Delta = {
						type: currentItem.type === "directory" ? "renameRemoteDirectory" : "renameRemoteFile",
						path: remoteRebasedTarget,
						from: remoteSourcePath,
						to: remoteRebasedTarget
					}

					deltas.push(delta)

					if (currentItem.type === "directory") {
						renamedRemoteDirectories.push(delta)
						dirRenameBaseFrom.set(delta, previousItem.path)
					}

					pathsAdded[remoteRebasedTarget] = true
					pathsAdded[remoteSourcePath] = true

					// Rename + in-place content modify of the SAME file in ONE cycle: the rename marks the new
					// path "added", so the modification pass below would skip it and the new bytes would never
					// upload (the remote would keep the OLD content under the new name, forever). Detect the
					// content change here against the base and emit the upload too; phase order runs the rename
					// (phase 4) before the upload (phase 11), so it lands on the renamed remote node. (F1)
					if (currentItem.type === "file") {
						const contentChanged =
							currentItem.size !== previousItem.size ||
							normalizeLastModifiedMsForComparison(currentItem.lastModified) !==
								normalizeLastModifiedMsForComparison(previousItem.lastModified)

						if (contentChanged) {
							deltas.push({
								type: "uploadFile",
								path: remoteRebasedTarget,
								size: currentItem.size
							})
						}
					}
				}
			}
		}

		// Remote file/directory move/rename
		if (mode === "twoWay" || mode === "cloudBackup" || mode === "cloudToLocal") {
			// Local-originated directory renames already emitted by the pass above (as renameRemoteDirectory
			// deltas). A remote rename whose SOURCE sits inside a directory the LOCAL side renamed in this same
			// cycle has physically moved on disk — it is at its base path only in the (not-yet-rebased) base tree,
			// but lives under the local rename's target now. Looking the source up at the base path therefore
			// MISSES and the remote rename is silently dropped, decomposing into delete+add. When the descendant
			// is ALSO modified on the renaming side, that decomposition strands the edit at the pre-inner-rename
			// path AND re-creates it at the composed path: a permanent duplicate (#10 / XD2). Rebase the source
			// LOOKUP and the emitted from/to to where that subtree now lives locally. Empty in the common
			// single-side cycle, so rebasePathAcrossRenames is a no-op and this costs nothing. (#10)
			const localOriginatedDirRenames = renamedRemoteDirectories.flatMap(delta =>
				delta.type === "renameRemoteDirectory" ? [{ from: delta.from, to: delta.to }] : []
			)
			// Zero local directory renames this cycle (the overwhelmingly common case) → no source can be
			// cross-blocked, so skip the per-item rebase entirely and use the paths as-is.
			const hasLocalDirRenames = localOriginatedDirRenames.length > 0

			for (const uuid in currentRemoteTree.uuids) {
				const currentItem = currentRemoteTree.uuids[uuid]
				const previousItem = previousRemoteTree.uuids[uuid]

				if (!currentItem || !previousItem || pathsAdded[currentItem.path] || pathsAdded[previousItem.path]) {
					continue
				}

				// Where this item's base path and its current-remote path map to on the LOCAL disk after the local
				// side's own directory renames this cycle (identity for an item outside any locally-renamed subtree).
				const localSourcePath = hasLocalDirRenames ? rebasePathAcrossRenames(previousItem.path, localOriginatedDirRenames) : previousItem.path
				const localTargetPath = hasLocalDirRenames ? rebasePathAcrossRenames(currentItem.path, localOriginatedDirRenames) : currentItem.path

				// Path from current item changed, it was either renamed or moved (same type)
				if (
					currentItem.path !== previousItem.path &&
					currentItem.type === previousItem.type &&
					// Does ANY item already occupy the rename target in the current local tree? Symmetric to the
					// local-rename guard above: a same-type occupant was probably moved there independently, and a
					// DIFFERENT-type occupant (file↔directory name swap) cannot be overwritten by a rename — leave
					// the path unmarked so the type-change / addition / deletion passes rebuild it via delete+recreate.
					// Evaluated at the REBASED local target (where the rename actually lands on disk).
					!currentLocalTree.tree[localTargetPath] &&
					// Symmetric to the local pass: the destination's parent must not currently be a file (a child
					// moving into a directory mid-type-change). Suppress so the addition pass rebuilds it locally.
					!renameDestinationBlockedByFileAncestor(currentLocalTree, localTargetPath) &&
					// Because only comparing strings can be weird sometimes
					Buffer.from(currentItem.path, "utf-8").toString("hex") !== Buffer.from(previousItem.path, "utf-8").toString("hex")
				) {
					// Symmetric to the local rename pass: only propagate the remote rename if the LOCAL source
					// is unchanged since the base — same inode AND (for files) same content. A remote modify
					// mints a new uuid, but a LOCAL modify keeps the inode, so checking the inode alone would
					// let a remote rename fire over a file the user edited in the same window and silently drop
					// that edit. If the local side deleted, modified, or renamed it, skip the rename and let
					// the file be handled by the deletion/addition passes → convergence, keeping both. (F2–F4)
					// The source is looked up at its REBASED local path; the base is the un-rebased base tree.
					const localSource = currentLocalTree.tree[localSourcePath]
					const baseLocalSource = previousLocalTree.tree[previousItem.path]
					const localSourceUnchanged =
						!!localSource &&
						!!baseLocalSource &&
						localSource.inode === baseLocalSource.inode &&
						(currentItem.type === "directory" ||
							(localSource.size === baseLocalSource.size &&
								normalizeLastModifiedMsForComparison(localSource.lastModified) ===
									normalizeLastModifiedMsForComparison(baseLocalSource.lastModified)))

					if (!localSourceUnchanged) {
						continue
					}

					const delta: Delta = {
						type: currentItem.type === "directory" ? "renameLocalDirectory" : "renameLocalFile",
						path: localTargetPath,
						from: localSourcePath,
						to: localTargetPath
					}

					deltas.push(delta)

					if (currentItem.type === "directory") {
						renamedLocalDirectories.push(delta)
						dirRenameBaseFrom.set(delta, previousItem.path)
					}

					pathsAdded[localTargetPath] = true
					pathsAdded[localSourcePath] = true
				}
			}
		}

		// Rename-aware rebase (BUG-A / BUG-B): a propagated directory rename relocates its ENTIRE subtree, but
		// every per-descendant pass below compares the current tree against the base BY PATH. A child changed
		// on the OTHER side still sits at the pre-rename path, so without realigning it is mis-attributed — the
		// rename moves it to the new path while a stale same-path upload/download/delete clobbers the change
		// (silent data loss, BUG-A) or resurrects a deleted child (BUG-B). Model the post-rename state: for
		// every propagated dir rename F->T, remap the affected subtree to T in the BASE (both sides) and in the
		// OTHER side's CURRENT tree (the emitted rename physically moves it there; the child transfer runs
		// AFTER the rename in phase order). The renamed side's current tree already sits at T, and the directory
		// nodes themselves are handled via pathsAdded, so only descendants are remapped. Skipped entirely when
		// no directory rename happened, so the common case pays nothing. The originals are not mutated — these
		// computation-only copies never feed the persisted base (advanced from the task results), they only
		// correct THIS cycle's delta attribution.
		if (renamedRemoteDirectories.length > 0 || renamedLocalDirectories.length > 0) {
			// renameRemoteDirectory deltas come from LOCAL-originated dir renames; renameLocalDirectory deltas
			// from REMOTE-originated ones. Build the raw list (original destinations) to detect cross-side
			// rename-into-renamed-directory collisions BEFORE rebasing anything.
			const dirRenamesRaw = [
				...renamedRemoteDirectories.flatMap(delta => (delta.type === "renameRemoteDirectory" ? [{ from: delta.from, to: delta.to }] : [])),
				...renamedLocalDirectories.flatMap(delta => (delta.type === "renameLocalDirectory" ? [{ from: delta.from, to: delta.to }] : []))
			]

			// A rename emitted by the passes above may TARGET a path INSIDE a directory the OTHER side renamed
			// in this same cycle — e.g. local moves /outside.txt INTO /dir, or moves the whole /sub directory
			// INTO /dir, while the remote renamed /dir -> /dir2. The rename pass recorded the destination at its
			// PRE-rename path (/dir/inside.txt, /dir/sub), but the operating side's directory now lives at /dir2.
			// Left alone, the emitted rename lands under the OLD directory name — resurrecting it on the backend —
			// while the additions pass, seeing the rebased current path (/dir2/inside.txt) un-marked, ALSO
			// transfers it: the item is DUPLICATED and the old directory comes back (ZW4 files, ZW9 directories).
			// Realign each emitted rename's destination across the dir renames and move its `pathsAdded` marker to
			// the rebased path, so the additions pass recognises it as already handled. The rename objects are
			// shared with renamedRemote/LocalDirectories, so correcting a directory rename in place also feeds the
			// corrected destination into the tree rebases + collapse below. A rename's destination is never inside
			// its OWN source (move-into-self is rejected) and a SAME-side rename already sits at its final path
			// (so it never matches the OLD `from` of a sibling), so this only fires for the cross-side collision.
			// The `from` is the real source on the operating side and is left untouched. Cheap: O(renames).
			for (const delta of deltas) {
				// A rename+in-place-modify of the SAME file (F1) emits, ALONGSIDE the rename, an `uploadFile` at
				// the new path so the changed bytes upload onto the renamed node. When that destination is inside a
				// directory the OTHER side renamed, the upload must follow to the rebased path too — otherwise it
				// reads the file at the OLD path (already physically moved by the dir rename in phase order), finds
				// nothing, and is SKIPPED, so the rename moves the STALE bytes and the modification is LOST. (Only
				// live-reproducible: a real fs preserves the inode across move+modify so this F1 path fires, whereas
				// memfs replaces it, turning the case into a delete+add. The `pathsAdded` marker for this path was
				// already moved by the sibling rename's correction below.)
				if (delta.type === "uploadFile") {
					delta.path = rebasePathAcrossRenames(delta.path, dirRenamesRaw)

					continue
				}

				if (
					delta.type !== "renameLocalFile" &&
					delta.type !== "renameRemoteFile" &&
					delta.type !== "renameLocalDirectory" &&
					delta.type !== "renameRemoteDirectory"
				) {
					continue
				}

				const rebasedTo = rebasePathAcrossRenames(delta.to, dirRenamesRaw)

				if (rebasedTo !== delta.to) {
					delete pathsAdded[delta.to]

					delta.to = rebasedTo
					delta.path = rebasedTo
					pathsAdded[rebasedTo] = true
				}
			}

			// (Re)build the rename lists from the (possibly corrected) delta objects, then model the post-rename
			// state. The base follows BOTH sides' renames; each side's CURRENT tree follows only the OTHER side's
			// rename (its own rename already moved its current tree to the new path).
			//
			// The delta `from` is the OPERATING side's CURRENT-tree path (where the executor acts). For the
			// CURRENT-tree rebases that is exactly right — the other side's current tree holds the item at that
			// same path. But the BASE tree holds it at its BASE path, which for a rename cross-blocked by the
			// other side's ancestor rename differs from the current path (`dirRenameBaseFrom`). Rebase the base
			// off the base `from`; both share the SAME composed `to` (the item's final position). Without this
			// split a nested cross-side rename mis-composes the base subtree (only the outer rename applies), and
			// the descendant then reads as delete-old-path + add-new-path instead of a clean rename. (#10)
			const localOriginatedRenames = renamedRemoteDirectories.flatMap(delta =>
				delta.type === "renameRemoteDirectory" ? [{ from: delta.from, to: delta.to }] : []
			)
			const remoteOriginatedRenames = renamedLocalDirectories.flatMap(delta =>
				delta.type === "renameLocalDirectory" ? [{ from: delta.from, to: delta.to }] : []
			)
			const allDirRenamesForBase = [...renamedRemoteDirectories, ...renamedLocalDirectories].flatMap(delta =>
				delta.type === "renameRemoteDirectory" || delta.type === "renameLocalDirectory"
					? [{ from: dirRenameBaseFrom.get(delta) ?? delta.from, to: delta.to }]
					: []
			)

			previousLocalTree = rebaseLocalTreeAcrossRenames(previousLocalTree, allDirRenamesForBase)
			previousRemoteTree = rebaseRemoteTreeAcrossRenames(previousRemoteTree, allDirRenamesForBase)
			currentRemoteTree = rebaseRemoteTreeAcrossRenames(currentRemoteTree, localOriginatedRenames)
			currentLocalTree = rebaseLocalTreeAcrossRenames(currentLocalTree, remoteOriginatedRenames)
		}

		// Case-insensitive MATCHING (whole path). The backend is case-insensitive, so a path that differs only
		// in casing between the local disk and the cloud is the SAME item. Every cross-tree lookup in the
		// add / delete / modify / type-change passes below goes through `ciGet` so a case-only divergence
		// (a fresh sync, cleared state, or a cross-device difference) never reads as present-here/absent-there
		// and churns (endless upload / download / delete). The RENAME passes ABOVE stay case-SENSITIVE — they
		// detect and propagate a real case-only rename (Category ZQ) and run first, claiming it via
		// `pathsAdded`, so a genuine rename is handled before this folding ever applies. Each tree already holds
		// at most one item per case-folded path (computeLocalCaseWinners + the remote build's dedup), so the
		// fold is collision-free. The per-tree fold index is built LAZILY on the first exact miss and cached by
		// the tree's map reference, so a settled cycle (every lookup an exact hit) builds nothing, and a rebased
		// tree (new map) indexes fresh. `path.toLowerCase()` mirrors the whole-path fold both builders use.
		//
		// Gated OFF whenever a DIRECTORY-rename composition is in flight this cycle. A cross-side directory
		// rename that also changes casing (or composes with one deeper in the same chain — Category XN) is
		// converged by the add/delete passes as an exact-case delete-old + create-new of the renamed subtree;
		// folding would see the old-case and new-case paths as the SAME item and suppress that convergence,
		// leaving the two sides cased differently forever. Those cycles keep exact-case matching (their prior,
		// correct behavior); the passive case-divergence this fold targets never coincides with a dir rename.
		const foldCaseInsensitive = renamedLocalDirectories.length === 0 && renamedRemoteDirectories.length === 0
		const foldIndexCache = new WeakMap<object, Map<string, string>>()
		const ciGet = <T>(treeMap: Record<string, T>, path: string): T | undefined => {
			const exact = treeMap[path]

			if (exact !== undefined || !foldCaseInsensitive) {
				return exact
			}

			let index = foldIndexCache.get(treeMap)

			if (!index) {
				index = new Map<string, string>()

				for (const existingPath in treeMap) {
					const lowercased = existingPath.toLowerCase()

					// First occurrence wins — order-independent because each tree is already deduped to one item
					// per case-folded path upstream, so at most one real path maps to each fold in practice.
					if (!index.has(lowercased)) {
						index.set(lowercased, existingPath)
					}
				}

				foldIndexCache.set(treeMap, index)
			}

			const realPath = index.get(path.toLowerCase())

			return realPath !== undefined ? treeMap[realPath] : undefined
		}

		// Local deletions
		if (mode === "twoWay" || mode === "localToCloud") {
			if (mode === "twoWay") {
				for (const path in previousLocalTree.tree) {
					if (pathsAdded[path] || erroredLocalPaths[path] || ignoredLocalPaths[path]) {
						continue
					}

					const previousLocalItem = ciGet(previousLocalTree.tree, path)
					const currentLocalItem = ciGet(currentLocalTree.tree, path)

					// If the item does not exist in the current tree but does in the previous one, it has been deleted.
					// We also check if the previous inode does not exist in the current tree, and if so, we skip it (only in cloud -> local modes. It should always be deleted in local -> cloud modes if it exists remotely).
					if (
						!currentLocalItem &&
						previousLocalItem //&&
						//(mode !== "localToCloud" ? !currentLocalTree.inodes[previousLocalItem.inode] : true)
					) {
						// A descendant hidden behind an ignored/errored ancestor (a symlink-replaced folder, an
						// unreadable directory) is not "locally gone", it is unscannable — never propagate it as a
						// deletion. Checked only at this delete decision, so the unchanged bulk of the tree pays
						// nothing. (BUG-006 extended to the subtree — maintainer decision "keep them".)
						if (hasIgnoredOrErroredLocalAncestor(path)) {
							continue
						}

						// Symmetric to the remote-deletions resurrect (OBS-001): the local copy was deleted, but
						// if the REMOTE file was modified since the base — a new uuid, i.e. a real re-upload — the
						// newer modification wins over the delete. Skip the delete and leave the path unmarked so
						// the remote-additions pass downloads (resurrects) it locally. A newer modify always beats
						// a delete, in either direction. (F7)
						if (previousLocalItem.type === "file") {
							const previousRemoteItem = ciGet(previousRemoteTree.tree, path)
							const currentRemoteItem = ciGet(currentRemoteTree.tree, path)

							if (
								currentRemoteItem &&
								currentRemoteItem.type === "file" &&
								previousRemoteItem &&
								currentRemoteItem.uuid !== previousRemoteItem.uuid
							) {
								continue
							}
						}

						// A type CHANGE on the other side is newer data, exactly like a modify: if the REMOTE replaced
						// this path with a DIFFERENT type since the base (file↔directory), that new item must win over
						// the local delete. Skip the delete and leave the path unmarked so the remote-additions pass
						// creates the new-type item locally. Extends modify-beats-delete (F7) to type changes — without
						// it, a type-change racing a delete loses the new item on the real backend, where deleting the
						// OLD type executes against the NEW-type item now at that path. (F7 — type change beats delete)
						const remoteTypeChangedItem = ciGet(currentRemoteTree.tree, path)

						if (remoteTypeChangedItem && remoteTypeChangedItem.type !== previousLocalItem.type) {
							continue
						}

						const delta: Delta = {
							type: previousLocalItem.type === "directory" ? "deleteRemoteDirectory" : "deleteRemoteFile",
							path
						}

						deltas.push(delta)

						if (previousLocalItem.type === "directory") {
							deletedRemoteDirectories.push(delta)

							deleteRemoteDirectoryCountRaw += 1
						} else {
							deleteRemoteFileCountRaw += 1
						}

						pathsAdded[path] = true
						pathsAdded[previousLocalItem.path] = true
					}
				}
			} else {
				for (const path in currentRemoteTree.tree) {
					if (pathsAdded[path] || erroredLocalPaths[path] || ignoredLocalPaths[path]) {
						continue
					}

					const currentLocalItem = ciGet(currentLocalTree.tree, path)
					const currentRemoteItem = ciGet(currentRemoteTree.tree, path)

					// If the item does not exist in the current local tree but does in the remote one, it needs to be deleted remotely in localToCloud mode.
					if (!currentLocalItem && currentRemoteItem) {
						// A remote path whose local counterpart is hidden behind an ignored/errored ancestor is
						// unscannable, not deleted — keep the cloud copy (BUG-006 extended to the subtree).
						if (hasIgnoredOrErroredLocalAncestor(path)) {
							continue
						}

						const delta: Delta = {
							type: currentRemoteItem.type === "directory" ? "deleteRemoteDirectory" : "deleteRemoteFile",
							path
						}

						deltas.push(delta)

						if (currentRemoteItem.type === "directory") {
							deletedRemoteDirectories.push(delta)

							deleteRemoteDirectoryCountRaw += 1
						} else {
							deleteRemoteFileCountRaw += 1
						}

						pathsAdded[path] = true
					}
				}
			}
		}

		// Remote deletions
		if (mode === "twoWay" || mode === "cloudToLocal") {
			if (mode === "twoWay") {
				for (const path in previousRemoteTree.tree) {
					// Symmetric to the local-deletions guard (BUG-006): never delete the LOCAL copy of a path the
					// local scan ignored or errored on. Such a path is physically present on disk but absent from
					// the scanned tree (an over-long name, an invalid path, a default-ignore that grew across an
					// upgrade, a case-duplicate); when its REMOTE copy is deleted, propagating that delete would
					// wipe a file the user never asked to sync. The end-of-process ignore filter does not catch
					// these — it only knows the .filenignore matcher, not the nameLength/pathLength/invalidPath/
					// defaultIgnore/duplicate reasons carried in ignoredLocalPaths. (M4)
					if (pathsAdded[path] || erroredLocalPaths[path] || ignoredLocalPaths[path]) {
						continue
					}

					const previousRemoteItem = ciGet(previousRemoteTree.tree, path)
					const currentRemoteItem = ciGet(currentRemoteTree.tree, path)

					// If the item does not exist in the current tree but does in the previous one, it has been deleted.
					// We also check if the previous UUID does not exist in the current tree, and if so, we skip it (only in local -> cloud modes. It should always be deleted in cloud -> local modes if it exists locally).
					if (
						!currentRemoteItem &&
						previousRemoteItem //&&
						//(mode !== "cloudToLocal" ? !currentRemoteTree.uuids[previousRemoteItem.uuid] : true)
					) {
						// Never delete the LOCAL copy of a descendant hidden behind an ignored/errored ancestor
						// (symmetric to the local-deletions guard above; BUG-006 / M4 extended to the subtree).
						if (hasIgnoredOrErroredLocalAncestor(path)) {
							continue
						}

						// E2E-OBS-001 (newer-modify-wins): the remote deleted this path, but if the local FILE
						// was modified since the last sync the modification wins — skip the delete and leave the
						// path unmarked so the local-additions pass re-uploads (resurrects) it remotely. "Modified"
						// requires a real CONTENT change: a size difference, or (same size, mtime moved) a cached
						// upload hash that no longer matches. A bare mtime touch — or a same-size change we cannot
						// confirm because no hash was stored — is NOT a modification, so the delete proceeds. The
						// hash is an optional signal (older files carry none).
						if (previousRemoteItem.type === "file") {
							const previousLocalItem = ciGet(previousLocalTree.tree, path)
							const currentLocalItem = ciGet(currentLocalTree.tree, path)

							if (currentLocalItem && currentLocalItem.type === "file" && previousLocalItem) {
								let localContentChanged = currentLocalItem.size !== previousLocalItem.size

								if (
									!localContentChanged &&
									normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) !==
										normalizeLastModifiedMsForComparison(previousLocalItem.lastModified)
								) {
									const cachedHash = this.sync.localFileHashes[currentLocalItem.path]

									if (cachedHash) {
										try {
											const currentHash = await this.sync.localFileSystem.createFileHash({
												relativePath: path,
												algorithm: "md5"
											})

											localContentChanged = currentHash !== cachedHash
										} catch {
											// The file is mid-rename (a pending dir rename will move it to `path`); we cannot
											// confirm a same-size content change without reading it, so leave it as "not
											// modified" — the hash-optional policy already lets such a delete proceed.
										}
									}
								}

								if (localContentChanged) {
									continue
								}
							}
						}

						// Symmetric to the local-deletions guard: a type CHANGE on the LOCAL side is newer data. If the
						// local side replaced this path with a DIFFERENT type since the base (file↔directory), that new
						// item must win over the remote delete — skip it so the local-additions pass pushes the new-type
						// item up. (F7 — type change beats delete)
						const localTypeChangedItem = ciGet(currentLocalTree.tree, path)

						if (localTypeChangedItem && localTypeChangedItem.type !== previousRemoteItem.type) {
							continue
						}

						const delta: Delta = {
							type: previousRemoteItem.type === "directory" ? "deleteLocalDirectory" : "deleteLocalFile",
							path
						}

						deltas.push(delta)

						if (previousRemoteItem.type === "directory") {
							deletedLocalDirectories.push(delta)

							deleteLocalDirectoryCountRaw += 1
						} else {
							deleteLocalFileCountRaw += 1
						}

						pathsAdded[path] = true
						pathsAdded[previousRemoteItem.path] = true
					}
				}
			} else {
				for (const path in currentLocalTree.tree) {
					if (pathsAdded[path]) {
						continue
					}

					const currentLocalItem = ciGet(currentLocalTree.tree, path)
					const currentRemoteItem = ciGet(currentRemoteTree.tree, path)

					// If the item does not exist in the current remote tree but does in the local one, it needs to be deleted locally in cloudToLocal mode.
					if (!currentRemoteItem && currentLocalItem) {
						const delta: Delta = {
							type: currentLocalItem.type === "directory" ? "deleteLocalDirectory" : "deleteLocalFile",
							path
						}

						deltas.push(delta)

						if (currentLocalItem.type === "directory") {
							deletedLocalDirectories.push(delta)

							deleteLocalDirectoryCountRaw += 1
						} else {
							deleteLocalFileCountRaw += 1
						}

						pathsAdded[path] = true
					}
				}
			}
		}

		// Don't cascade a directory deletion over live content the OTHER side did not delete. When one side
		// removes a directory while this side adds (or keeps a modified) child inside it, drop the directory
		// delete so the surviving child's own add re-creates the directory — the genuinely-deleted siblings
		// still delete individually. Without this the dir-delete subsumes the child at execution and the
		// brand-new file is lost (newer content must beat a delete, symmetric to the per-file passes). (H5)
		const localDirsToKeep = directoriesWithSurvivingChildren(
			deltas,
			"deleteLocalDirectory",
			"deleteLocalFile",
			"renameLocalDirectory",
			"renameLocalFile",
			currentLocalTree.tree
		)
		const remoteDirsToKeep = directoriesWithSurvivingChildren(
			deltas,
			"deleteRemoteDirectory",
			"deleteRemoteFile",
			"renameRemoteDirectory",
			"renameRemoteFile",
			currentRemoteTree.tree
		)

		if (localDirsToKeep.size > 0 || remoteDirsToKeep.size > 0) {
			deltas = deltas.filter(delta => {
				if (delta.type === "deleteLocalDirectory" && localDirsToKeep.has(delta.path)) {
					deleteLocalDirectoryCountRaw -= 1
					// Un-mark so the additions pass re-creates the surviving directory on the deleting side.
					delete pathsAdded[delta.path]

					return false
				}

				if (delta.type === "deleteRemoteDirectory" && remoteDirsToKeep.has(delta.path)) {
					deleteRemoteDirectoryCountRaw -= 1
					delete pathsAdded[delta.path]

					return false
				}

				return true
			})

			// Keep the bookkeeping arrays consistent — collapseDeltas uses them to subsume descendant
			// deletes, and a kept directory must no longer subsume its (legitimately deleted) children.
			for (let i = deletedLocalDirectories.length - 1; i >= 0; i--) {
				if (localDirsToKeep.has(deletedLocalDirectories[i]!.path)) {
					deletedLocalDirectories.splice(i, 1)
				}
			}

			for (let i = deletedRemoteDirectories.length - 1; i >= 0; i--) {
				if (remoteDirsToKeep.has(deletedRemoteDirectories[i]!.path)) {
					deletedRemoteDirectories.splice(i, 1)
				}
			}
		}

		// Type change at a path (file <-> directory). The path exists in BOTH current trees but as
		// different types, so it slips through every other pass: the rename passes need a matching
		// inode/uuid (a type change has neither), the deletion passes need the path ABSENT on the other
		// side (here it is present, only a different type), and the addition passes skip a path whose
		// other-side item already exists. Left unhandled, the stale-type item lingers and its replacement
		// cannot be created over it (E2E-BUG-001).
		//
		// We attribute the change against the last-synced base: whichever side's type differs from the
		// base is the one that changed. In twoWay, if both changed (or neither is in the base) local wins,
		// matching the tie policy used elsewhere; directional modes force the authoritative side. The
		// authoritative side's new item is created and the other side's stale item is deleted — the
		// phase-ordered task runner always runs deletes before creates, so the delete lands first. When
		// the deleted (stale) side is a directory, its descendants are marked "added" so the addition
		// passes don't try to sync now-obsolete children; the recursive delete removes them (and any
		// child-delete deltas already emitted collapse into the parent). The surviving side's descendants
		// stay unmarked and sync normally.
		{
			const canWriteRemote =
				mode === "twoWay" || mode === "localBackup" || mode === "localToCloud"
			const canWriteLocal =
				mode === "twoWay" || mode === "cloudBackup" || mode === "cloudToLocal"
			const markSubtreeAdded = (treePaths: Record<string, unknown>, parentPath: string): void => {
				const prefix = `${parentPath}/`

				for (const descendantPath in treePaths) {
					if (descendantPath.startsWith(prefix)) {
						pathsAdded[descendantPath] = true
					}
				}
			}

			for (const path in currentLocalTree.tree) {
				if (pathsAdded[path] || erroredLocalPaths[path] || ignoredLocalPaths[path]) {
					continue
				}

				const currentLocalItem = ciGet(currentLocalTree.tree, path)
				const currentRemoteItem = ciGet(currentRemoteTree.tree, path)

				if (!currentLocalItem || !currentRemoteItem || currentLocalItem.type === currentRemoteItem.type) {
					continue
				}

				// Both sides have this path, with different types. Attribute the change against the base.
				const previousLocalItem = ciGet(previousLocalTree.tree, path)
				const previousRemoteItem = ciGet(previousRemoteTree.tree, path)
				const localChangedType = !previousLocalItem || previousLocalItem.type !== currentLocalItem.type
				const remoteChangedType = !previousRemoteItem || previousRemoteItem.type !== currentRemoteItem.type

				// Additive backup modes TOLERATE a FOREIGN type change on the non-authoritative (target) side,
				// exactly as the modify branch tolerates a foreign CONTENT edit (V8/X8): reverting it would
				// re-assert the authoritative side and DELETE the foreign item — a deletion on the very side
				// these modes promise never to delete (localBackup never deletes the remote, cloudBackup never
				// deletes the local). So only an ORIGINATED type change (the authoritative side is the one that
				// diverged from base) propagates; a foreign one is left alone and the sides simply diverge at this
				// path. The strict-mirror modes (localToCloud/cloudToLocal) still REVERT it (Category ZA), and
				// twoWay still resolves by which side changed. (Maintainer decision 2026-06-29.)
				if ((mode === "localBackup" && !localChangedType) || (mode === "cloudBackup" && !remoteChangedType)) {
					continue
				}

				// Additive backup, ORIGINATED dir->file (#13, sibling of #6): propagating it would recursively
				// delete the backup-side DIRECTORY — destroying any FOREIGN child another device added under it, and
				// even the synced children this mode keeps on a local deletion. The contract is "never delete the
				// backup", so tolerate the divergence instead: keep the backup directory + its children, leave the
				// new file un-backed-up. Only a directory delete recurses, so this is gated on the target being a
				// directory; a file->dir change (deleting a leaf file) is unaffected.
				if (
					(mode === "localBackup" && currentRemoteItem.type === "directory") ||
					(mode === "cloudBackup" && currentLocalItem.type === "directory")
				) {
					continue
				}

				let localWins: boolean

				if (mode === "localBackup" || mode === "localToCloud") {
					localWins = true
				} else if (mode === "cloudBackup" || mode === "cloudToLocal") {
					localWins = false
				} else {
					// twoWay: whoever's type diverged from base wins; local wins a tie / a both-changed conflict.
					localWins = localChangedType || !remoteChangedType
				}

				if (localWins && canWriteRemote) {
					const deleteDelta: Delta = {
						type: currentRemoteItem.type === "directory" ? "deleteRemoteDirectory" : "deleteRemoteFile",
						path
					}

					deltas.push(deleteDelta)

					if (currentRemoteItem.type === "directory") {
						deletedRemoteDirectories.push(deleteDelta)

						deleteRemoteDirectoryCountRaw += 1

						markSubtreeAdded(currentRemoteTree.tree, path)
					} else {
						deleteRemoteFileCountRaw += 1
					}

					deltas.push(
						currentLocalItem.type === "directory"
							? { type: "createRemoteDirectory", path }
							: { type: "uploadFile", path, size: currentLocalItem.size }
					)

					pathsAdded[path] = true
				} else if (!localWins && canWriteLocal) {
					const deleteDelta: Delta = {
						type: currentLocalItem.type === "directory" ? "deleteLocalDirectory" : "deleteLocalFile",
						path
					}

					deltas.push(deleteDelta)

					if (currentLocalItem.type === "directory") {
						deletedLocalDirectories.push(deleteDelta)

						deleteLocalDirectoryCountRaw += 1

						markSubtreeAdded(currentLocalTree.tree, path)
					} else {
						deleteLocalFileCountRaw += 1
					}

					deltas.push(
						currentRemoteItem.type === "directory"
							? { type: "createLocalDirectory", path }
							: { type: "downloadFile", path, size: currentRemoteItem.size }
					)

					pathsAdded[path] = true
				}
			}
		}

		// Local additions/fileModifications
		if (mode === "twoWay" || mode === "localBackup" || mode === "localToCloud") {
			for (const path in currentLocalTree.tree) {
				if (pathsAdded[path] || erroredLocalPaths[path]) {
					continue
				}

				const currentLocalItem = ciGet(currentLocalTree.tree, path)
				const currentRemoteItem = ciGet(currentRemoteTree.tree, path)

				// If the item does not exist in the current remote tree, but does in the local one, it should be uploaded.
				// We also check if it in fact has existed before (the inode), if so, we skip it (only in cloud -> local modes. It should always be uploaded in local -> cloud modes if it does not exist remotely).
				if (
					!currentRemoteItem &&
					currentLocalItem &&
					//(mode !== "localBackup" && mode !== "localToCloud"
					//	? !previousLocalTree.inodes[currentLocalItem.inode]
					//	: true) &&
					// Does an item with the same path and type already exist in the current remote tree (probably uploaded by something else prior)?
					!(ciGet(currentRemoteTree.tree, path) && ciGet(currentRemoteTree.tree, path)!.type === currentLocalItem.type)
				) {
					// Do NOT emit an upload/mkdir under a remote FILE ancestor this cycle won't replace: the backend
					// rejects a child under a file and the task errors EVERY cycle, wedging the pair. This is the
					// additive-backup foreign dir→file case (localBackup tolerates the remote file at `/d`, so
					// `/d/child` cannot be backed up under it). Leave the subtree un-synced until the foreign file is
					// gone — no wedge, additive contract preserved. (#6)
					if (additionBlockedByUnreplacedFileAncestor(currentRemoteTree, path, pathsAdded)) {
						continue
					}

					deltas.push({
						type: currentLocalItem.type === "directory" ? "createRemoteDirectory" : "uploadFile",
						path,
						size: currentLocalItem.size
					})

					pathsAdded[path] = true

					continue
				}

				// If the item exists in both trees and the local copy changed since the last sync, upload it.
				// The change is attributed against the last-synced BASE (previousLocalTree) by size + whole-
				// second mtime — not by comparing the two current sides — so an edit that lands in the same
				// whole-second as the base mtime, or that only changes the size (e.g. 0 -> N bytes), is still
				// detected (E2E-OBS-002). The remote side's change is detected by a new uuid (every re-upload
				// mints one). On a both-changed conflict the newer mtime wins; an unorderable same-second tie
				// resolves to local because this pass runs before the download pass and marks the path added.
				// The md5 comparison stays as an OPTIONAL dedup (so a pure mtime touch with identical bytes is
				// not re-uploaded) — never a required signal, since older files carry no stored hash.
				if (currentRemoteItem && currentRemoteItem.type === "file" && currentLocalItem && currentLocalItem.type === "file") {
					const previousLocalItem = ciGet(previousLocalTree.tree, path)
					const previousRemoteItem = ciGet(previousRemoteTree.tree, path)
					// With a persisted base, attribute the change against it (size + whole-second mtime). With
					// NO base — a genuine first sync, or lost/corrupt state — there is no common ancestor, so
					// the remote copy is the only reference: fall back to the side-vs-side comparison and treat
					// the file as changed only when the local copy is strictly newer (otherwise identical
					// content on both sides would be needlessly re-uploaded). OBS-002's same-second case
					// requires a base, so this fallback cannot reintroduce it.
					const localChanged = previousLocalItem
						? previousLocalItem.size !== currentLocalItem.size ||
							normalizeLastModifiedMsForComparison(previousLocalItem.lastModified) !==
								normalizeLastModifiedMsForComparison(currentLocalItem.lastModified)
						: // No base: the local copy is "changed" (relative to the stray remote) when it is strictly
							// newer OR the SIZES differ. A size difference is proof the bytes differ, so it must not be
							// discarded — without it, an equal-whole-second mtime with different sizes emitted neither an
							// upload nor a download and the two provably-different files diverged forever. The equal-mtime
							// tie resolves to local via localWins (local runs first, `>=`), symmetric to the directional
							// modes' noBaseSizeDiverged. (#11)
							normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) >
								normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified) ||
							currentLocalItem.size !== currentRemoteItem.size
					const remoteChanged = !previousRemoteItem || currentRemoteItem.uuid !== previousRemoteItem.uuid
					// Directional push modes (localToCloud / localBackup): the LOCAL side is authoritative, so a
					// local change ALWAYS wins. The newer-mtime tiebreak is twoWay conflict resolution and must
					// not let a foreign remote edit (with a newer mtime) suppress the push. (F5)
					const directionalPush = mode === "localToCloud" || mode === "localBackup"
					const localWins =
						directionalPush ||
						!remoteChanged ||
						normalizeLastModifiedMsForComparison(currentLocalItem.lastModified) >=
							normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified)

					// Strict mirror (localToCloud only): the remote MUST equal local. If the remote was edited
					// away from what we last pushed (a new uuid) — even when the local file itself is unchanged —
					// re-assert the local copy to revert that foreign edit, bypassing the md5 dedup below (local
					// bytes still equal the last upload, so the dedup would otherwise skip). localBackup is
					// additive and deliberately tolerates foreign edits, so it is excluded. (F6)
					const mirrorRevert = mode === "localToCloud" && remoteChanged
					// Directional push with NO remote base: a stray remote file occupies a path local also has.
					// It cannot be the synced copy if the SIZES differ, so the authoritative local wins — push it
					// up over the stray. (F9, symmetric to the pull side.)
					const noBaseSizeDiverged = directionalPush && !previousRemoteItem && currentLocalItem.size !== currentRemoteItem.size

					if ((localChanged || mirrorRevert || noBaseSizeDiverged) && localWins) {
						// The md5 is an OPTIONAL dedup. When a pending directory rename will move this file to
						// `path` (a rebased descendant — BUG-A/BUG-B), the file is not at `path` yet at delta time,
						// so the read throws; we already KNOW it changed (size/mtime vs base), so emit the upload
						// and let the upload task hash the moved file. A same-content touch is still deduped when
						// the hash IS readable.
						let md5Hash: string | undefined

						try {
							md5Hash = await this.sync.localFileSystem.createFileHash({
								relativePath: path,
								algorithm: "md5"
							})
						} catch {
							md5Hash = undefined
						}

						const cachedHashForConflict = this.sync.localFileHashes[currentLocalItem.path]
						const localSizeChanged = !previousLocalItem || previousLocalItem.size !== currentLocalItem.size
						// In a twoWay CONFLICT (the remote made a confirmed new-uuid change) a SAME-SIZE local change
						// wins only when CONFIRMED a real edit — a cached hash that differs. A same-size change we
						// cannot confirm (no stored hash, or a hash that MATCHES = a bare touch) must NOT clobber the
						// remote's confirmed edit: defer to the remote so it downloads. Mirrors the resurrect pass,
						// which refuses to let an unconfirmable same-size local change beat a remote delete. Directional
						// / mirror pushes are authoritative (mirrorRevert / noBaseSizeDiverged); an UNREADABLE file
						// (md5Hash === undefined, e.g. a rebased descendant mid dir-rename) is a known change and never
						// defers. (TI5 + no-cache extension — maintainer decision.)
						const deferToConfirmedRemote =
							remoteChanged &&
							!directionalPush &&
							!mirrorRevert &&
							!noBaseSizeDiverged &&
							!localSizeChanged &&
							md5Hash !== undefined &&
							(cachedHashForConflict === undefined || md5Hash === cachedHashForConflict)

						if (
							!deferToConfirmedRemote &&
							(mirrorRevert ||
								noBaseSizeDiverged ||
								md5Hash === undefined ||
								md5Hash !== this.sync.localFileHashes[currentLocalItem.path])
						) {
							deltas.push({
								type: "uploadFile",
								path,
								size: currentLocalItem.size,
								// Omit (rather than set undefined) when unreadable, so the upload task computes it.
								...(md5Hash !== undefined ? { md5Hash } : {})
							})

							pathsAdded[path] = true
						}
					}
				}
			}
		}

		// Remote additions/changes
		if (mode === "twoWay" || mode === "cloudBackup" || mode === "cloudToLocal") {
			for (const path in currentRemoteTree.tree) {
				if (pathsAdded[path]) {
					continue
				}

				const currentLocalItem = ciGet(currentLocalTree.tree, path)
				const currentRemoteItem = ciGet(currentRemoteTree.tree, path)

				// If the item does not exist in the current local tree, but does in the remote one, it should be downloaded.
				// We also check if it in fact has existed before (the UUID), if so, we skip it (only in local -> cloud modes. It should always be downloaded in cloud -> local modes if it does not exist locally).
				if (
					!currentLocalItem &&
					currentRemoteItem &&
					//(mode !== "cloudBackup" && mode !== "cloudToLocal"
					//	? !previousRemoteTree.uuids[currentRemoteItem.uuid]
					//	: true) &&
					// Does an item with the same path and type already exist in the current local tree (probably downloaded by something else prior)?
					!(ciGet(currentLocalTree.tree, path) && ciGet(currentLocalTree.tree, path)!.type === currentRemoteItem.type)
				) {
					// Don't re-create local content that would land under a structurally ignored/errored local path
					// (a symlink-replaced FOLDER, an unreadable directory): a DESCENDANT behind such an ancestor, or
					// a remote DIRECTORY at the ignored path itself, cannot be written (the local entry is a symlink
					// to a file, not a directory) — the task would fail to write under it and WEDGE every cycle. Skip
					// it: the cloud copy stays untouched (the deletion passes already decline to delete it) and the
					// local symlink/dir is left exactly as the user left it. A remote FILE at an exactly-ignored path
					// is NOT skipped — re-downloading it simply heals the path back to a real file (the file→symlink
					// backwards-compat case, F15). (BUG-006 extended — maintainer decision "keep them".)
					if (
						hasIgnoredOrErroredLocalAncestor(path) ||
						((ignoredLocalPaths[path] || erroredLocalPaths[path]) && currentRemoteItem.type === "directory")
					) {
						continue
					}

					// Symmetric to the upload pass (#6): don't create local content under a LOCAL file ancestor this
					// cycle won't replace (the cloudBackup foreign dir→file case) — the local fs rejects a child under
					// a file and the task wedges every cycle. Leave the subtree un-synced until the foreign file is
					// gone.
					if (additionBlockedByUnreplacedFileAncestor(currentLocalTree, path, pathsAdded)) {
						continue
					}

					deltas.push({
						type: currentRemoteItem.type === "directory" ? "createLocalDirectory" : "downloadFile",
						path,
						size: currentRemoteItem.size
					})

					pathsAdded[path] = true

					continue
				}

				const previousRemoteItem = ciGet(previousRemoteTree.tree, path)

				// If the item exists in both trees and the remote copy changed since the base, download it.
				// This MIRRORS the local-additions modify branch. With a base the remote changed iff its uuid
				// changed (every re-upload mints one); with NO base — a fresh add-vs-add, or lost/corrupt state
				// — fall back to side-vs-side and treat it as changed only when the remote is strictly newer
				// (otherwise identical content on both sides would be needlessly downloaded). The local pass ran
				// first and claimed the path (pathsAdded) when local won; reaching here means the remote wins.
				// Without this no-base fallback an add-vs-add where the REMOTE is newer never converged. (F8)
				if (currentRemoteItem && currentRemoteItem.type === "file" && currentLocalItem && currentLocalItem.type === "file") {
					const previousLocalItem = ciGet(previousLocalTree.tree, path)
					const remoteChanged = previousRemoteItem
						? currentRemoteItem.uuid !== previousRemoteItem.uuid
						: normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified) >
							normalizeLastModifiedMsForComparison(currentLocalItem.lastModified)
					// Directional pull modes (cloudToLocal / cloudBackup): the REMOTE side is authoritative, so a
					// remote change ALWAYS wins; the newer-mtime tiebreak is twoWay-only and must not let a
					// foreign local edit (with a newer mtime) suppress the pull. (F5)
					const directionalPull = mode === "cloudToLocal" || mode === "cloudBackup"
					// The local copy is unchanged since the base (size + whole-second mtime both match). Then a
					// remote change is NOT a conflict — there is nothing local to lose — so it must win outright.
					// Mirrors the local pass, which already declines to claim an unchanged-local path. Without
					// this, a genuine remote edit (new uuid) whose mtime was not strictly newer than the local
					// mtime — equal whole-second, or an out-of-sync editing clock — was dropped and never pulled.
					let localUnchanged =
						!!previousLocalItem &&
						previousLocalItem.size === currentLocalItem.size &&
						normalizeLastModifiedMsForComparison(previousLocalItem.lastModified) ===
							normalizeLastModifiedMsForComparison(currentLocalItem.lastModified)

					// A bare local mtime TOUCH (size unchanged from base, only the mtime moved) is NOT a content
					// change, so it must not win the newer-mtime tiebreak below and STRAND a genuine remote edit:
					// the remote's new bytes would otherwise never download and the two sides diverge PERMANENTLY
					// (local keeps stale content under a newer touch-mtime while the real edit sits unreachable on
					// the remote). When the remote actually changed and the local size still matches base, the cached
					// upload hash decides; with NO cached hash (a downloaded file — the engine caches a hash only on
					// upload) the same-size change is UNCONFIRMABLE and DEFERS to the confirmed remote edit (maintainer
					// decision). Consistent with the resurrect pass, which already refuses to let a bare touch beat a
					// delete. (TI5 + no-cache extension)
					if (!localUnchanged && remoteChanged && previousLocalItem && previousLocalItem.size === currentLocalItem.size) {
						const cachedHash = this.sync.localFileHashes[currentLocalItem.path]

						if (cachedHash) {
							try {
								const currentHash = await this.sync.localFileSystem.createFileHash({
									relativePath: path,
									algorithm: "md5"
								})

								localUnchanged = currentHash === cachedHash
							} catch {
								// Unreadable (a pending rename has not moved the file to `path` yet) — keep the mtime result.
							}
						} else {
							localUnchanged = true
						}
					}
					// The newer-mtime tiebreak (last term) stays the CONFLICT resolver: it only decides the case
					// where the local copy ALSO changed. The local pass ran first and claimed the path when local
					// won that conflict, so reaching here with a changed local means the remote is the newer side.
					const remoteWins =
						directionalPull ||
						!previousLocalItem ||
						localUnchanged ||
						normalizeLastModifiedMsForComparison(currentRemoteItem.lastModified) >
							normalizeLastModifiedMsForComparison(currentLocalItem.lastModified)

					// Strict mirror (cloudToLocal only): local MUST equal remote. If the local copy was edited
					// away from what we last pulled (size or whole-second mtime differs from the base) — even when
					// the remote is unchanged — re-download to revert that foreign local edit. cloudBackup is
					// additive and deliberately tolerates local edits, so it is excluded. (F6)
					const localDiverged =
						!!previousLocalItem &&
						(previousLocalItem.size !== currentLocalItem.size ||
							normalizeLastModifiedMsForComparison(previousLocalItem.lastModified) !==
								normalizeLastModifiedMsForComparison(currentLocalItem.lastModified))
					// Strict mirror on NO base too (#12): a stray local file at a path the remote also holds must be
					// reverted to the remote's bytes even when the SIZES match — noBaseSizeDiverged only catches a
					// size difference, so a same-size, different-content, newer-mtime stray otherwise survives forever
					// and the "local equals remote" contract is silently broken. Symmetric to localToCloud, whose
					// mirror revert already fires on no base (remoteChanged is true there). Establishes the base on
					// the resulting download, so it does not churn.
					const mirrorRevert = mode === "cloudToLocal" && (localDiverged || !previousLocalItem)
					// Directional pull with NO local base: a stray local file occupies a path the remote also has
					// (e.g. the local copy was deleted then re-created with different content). It cannot be the
					// synced copy if the SIZES differ, so the authoritative remote wins — pull it down. (F9)
					const noBaseSizeDiverged = directionalPull && !previousLocalItem && currentLocalItem.size !== currentRemoteItem.size

					if ((remoteChanged || mirrorRevert || noBaseSizeDiverged) && remoteWins) {
						deltas.push({
							type: "downloadFile",
							path,
							size: currentRemoteItem.size
						})

						pathsAdded[path] = true
					}
				}
			}
		}

		// Filter out ignored paths. Ordering is deferred to the single sort on the collapsed result below:
		// sorting here would order the larger PRE-collapse set, and collapseDeltas never depends on its input
		// order (it indexes the renamed/deleted directories up front), so one sort on the final set suffices.
		deltas = deltas
			.filter(delta => {
				const trailingSlash =
					delta.type === "renameLocalDirectory" ||
					delta.type === "createLocalDirectory" ||
					delta.type === "createRemoteDirectory" ||
					delta.type === "deleteLocalDirectory" ||
					delta.type === "renameRemoteDirectory" ||
					delta.type === "deleteRemoteDirectory"
						? "/"
						: ""

				let keep = true

				if (
					delta.type === "renameLocalDirectory" ||
					delta.type === "renameLocalFile" ||
					delta.type === "renameRemoteDirectory" ||
					delta.type === "renameRemoteFile"
				) {
					if (
						(this.sync.excludeDotFiles &&
							((pathIncludesDotFile(delta.from) && !isSyncedIgnoreFile(delta.from)) ||
								(pathIncludesDotFile(delta.to) && !isSyncedIgnoreFile(delta.to)))) ||
						this.sync.ignorer.ignores(delta.from + trailingSlash) ||
						this.sync.ignorer.ignores(delta.to + trailingSlash)
					) {
						keep = false
					}
				} else {
					if (
						(this.sync.excludeDotFiles && pathIncludesDotFile(delta.path) && !isSyncedIgnoreFile(delta.path)) ||
						this.sync.ignorer.ignores(delta.path + trailingSlash)
					) {
						keep = false
					}
				}

				// A DELETE delta dropped here is for an ignored path - not a real deletion - so it must not inflate
				// the raw delete counts that feed the large-deletion confirmation gate (those are tallied in the
				// deletion passes BEFORE this filter). Without this, ignoring a whole already-synced subtree (which
				// the scan now PRUNES rather than carrying through `ignoredLocalPaths`) would be miscounted as
				// emptying the side and could spuriously prompt "confirm deleting everything".
				if (!keep) {
					switch (delta.type) {
						case "deleteRemoteDirectory": {
							deleteRemoteDirectoryCountRaw = Math.max(0, deleteRemoteDirectoryCountRaw - 1)

							break
						}
						case "deleteRemoteFile": {
							deleteRemoteFileCountRaw = Math.max(0, deleteRemoteFileCountRaw - 1)

							break
						}
						case "deleteLocalDirectory": {
							deleteLocalDirectoryCountRaw = Math.max(0, deleteLocalDirectoryCountRaw - 1)

							break
						}
						case "deleteLocalFile": {
							deleteLocalFileCountRaw = Math.max(0, deleteLocalFileCountRaw - 1)

							break
						}
					}
				}

				return keep
			})

		// Here we apply the "done" task to the delta state.
		// E.g. when the user renames/moves a directory from "/sync/dir" to "/sync/dir2"
		// we'll get all the rename/move deltas for the directory children aswell.
		// This is pretty unnecessary, hence we filter them here.
		// Same for deletions. We only ever need to rename/move/delete the parent directory if the children did not change.
		// This saves a lot of disk usage and API requests. This also saves time applying all done tasks to the overall state,
		// since we need to loop through less doneTasks. See collapseDeltas for the correctness properties.
		const collapsedDeltas = collapseDeltas({
			deltas,
			renamedLocalDirectories,
			renamedRemoteDirectories,
			deletedLocalDirectories,
			deletedRemoteDirectories
		})

		// Order the collapsed deltas "left to right" (ascending path depth) so the executor creates/renames
		// parents before children. Each delta's depth is computed ONCE here — a path.split inside the comparator
		// is otherwise recomputed on every comparison (O(n log n) splits) — and only the already-collapsed
		// (smallest) set is sorted.
		const sortedDeltas = collapsedDeltas
			.map(delta => [delta.path.split("/").length, delta] as const)
			.sort((a, b) => a[0] - b[0])
			.map(entry => entry[1])

		return {
			deltas: sortedDeltas,
			deleteLocalDirectoryCountRaw,
			deleteLocalFileCountRaw,
			deleteRemoteDirectoryCountRaw,
			deleteRemoteFileCountRaw,
			mode
		}
	}
}

export default Deltas
