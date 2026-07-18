import { Volume, createFsFromVolume, type IFs } from "memfs"
import pathModule from "path"
import { type SyncFS, type SyncGlobFS } from "../../src/lib/environment"

/**
 * Declarative description of an initial in-memory tree.
 *
 * Key   = absolute path (e.g. "/local/a.txt").
 * Value = `string`        → a file with that UTF-8 content,
 *         `VfsFileSpec`   → a file with content and/or an explicit mtime,
 *         `null`          → an (empty) directory.
 *
 * Intermediate directories are created automatically.
 */
export type VfsFileSpec = { content?: string; mtimeMs?: number }
export type VfsSpec = Record<string, string | VfsFileSpec | null>

export type VirtualFS = {
	/** The {@link SyncFS} surface to inject into the engine's environment. */
	fs: SyncFS
	/** The fast-glob filesystem adapter to inject as `globFs`. */
	globFs: SyncGlobFS
	/** The underlying memfs volume (for advanced manipulation in tests). */
	vol: InstanceType<typeof Volume>
	/** The memfs fs implementation backing both {@link fs} and {@link globFs}. */
	ifs: IFs
	controls: {
		/** Current inode of a path, or null if it does not exist. */
		getInode(path: string): number | null
		/**
		 * Force `stat`/`lstat` of `path` to report inode `ino`, simulating an OS (ext4) that recycles a
		 * freed inode number for the next-created file. memfs has no native reuse, so this is the only way
		 * to reproduce the inode-reuse rename misdetection deterministically. Use the real posix path the
		 * engine will stat (e.g. "/local/c.txt").
		 */
		setInode(path: string, ino: number): void
		/** Remove a previously forced inode for `path`. */
		clearInode(path: string): void
		/** Whether a path currently exists (no symlink following beyond stat). */
		exists(path: string): boolean
		/** Force the next fs operation that touches `path` to throw `error`. */
		setError(path: string, error: NodeJS.ErrnoException): void
		/** Remove a previously injected error for `path`. */
		clearError(path: string): void
		/**
		 * Force `globFs.readdir(dirPath)` (the FastGlob scan enumeration) to fail with `error`, modelling a
		 * transient network-share enumeration failure that silently omits `dirPath`'s subtree from the scan.
		 * `dirPath` is the ABSOLUTE path the walk enumerates (e.g. "/local/photos/2020").
		 */
		setGlobReaddirError(dirPath: string, error: NodeJS.ErrnoException): void
		/** Remove a previously injected glob-readdir error for `dirPath`. */
		clearGlobReaddirError(dirPath: string): void
		/** Remove all injected errors. */
		clearAllErrors(): void
		/**
		 * Register a callback invoked synchronously AFTER every `lstat`/`stat` returns, with the posix path
		 * just stat'd. Lets a test edit a file mid-scan (after the engine has already read it) to reproduce a
		 * read-during-scan race deterministically. The callback should gate itself (path match + a one-shot
		 * flag) and is cleared with {@link clearStatHook}. Only one hook is active at a time.
		 */
		onStat(hook: (posixPath: string) => void): void
		/** Remove the {@link onStat} hook. */
		clearStatHook(): void
		/** Flat JSON view of the volume (file path → content, dir → null). */
		toJSON(): Record<string, string | null>
	}
}

/**
 * Build a Node `ErrnoException` with a `code` (e.g. "ENOENT", "EACCES").
 */
export function makeErrnoError(code: string, message?: string): NodeJS.ErrnoException {
	const error = new Error(message ?? code) as NodeJS.ErrnoException

	error.code = code

	return error
}

/**
 * Normalize a path the ENGINE produced into the posix form memfs understands.
 *
 * memfs is strictly posix (it rejects backslashes), and the virtual tree is seeded with `/`-paths. But
 * the engine joins local paths with the host's real `path` module, so on a Windows runner it emits
 * backslash separators — and FastGlob/@nodelib may resolve the posix `cwd` to a drive-rooted absolute
 * like `C:\local\...`. Stripping a leading drive letter and converting `\`→`/` lets the in-memory fs
 * accept whatever the host's path module emits, so the identical suite runs on win32/darwin/linux.
 *
 * On posix hosts this is a no-op (no drive letter, no backslashes). Only paths the engine passes in are
 * normalized here; test-side `ifs`/`vol` access stays posix (tests always use `/`).
 */
export function toPosixPath<T>(path: T): T {
	return (typeof path === "string" ? path.replace(/^[a-zA-Z]:(?=[\\/])/, "").replace(/\\/g, "/") : path) as T
}

/**
 * Materialize a {@link VfsSpec} into a memfs filesystem.
 */
export function applyVfsSpec(ifs: IFs, spec: VfsSpec): void {
	for (const [path, value] of Object.entries(spec)) {
		if (value === null) {
			ifs.mkdirSync(path, { recursive: true })

			continue
		}

		const content = typeof value === "string" ? value : value.content ?? ""

		ifs.mkdirSync(pathModule.posix.dirname(path), { recursive: true })
		ifs.writeFileSync(path, content)

		const mtimeMs = typeof value === "string" ? undefined : value.mtimeMs

		if (typeof mtimeMs === "number") {
			const seconds = mtimeMs / 1000

			ifs.utimesSync(path, seconds, seconds)
		}
	}
}

export type CreateVirtualFSOptions = {
	/**
	 * Model a CASE-INSENSITIVE, case-PRESERVING volume (Windows NTFS / macOS APFS / an SMB share) instead of
	 * memfs's native posix case-SENSITIVITY. When on, any path the engine passes is resolved against the
	 * actually-stored casing at each segment before it reaches memfs — so `stat("/local/INDEX.html")` finds a
	 * file created as `/local/index.html`, and writing `/local/INDEX.html` over it OVERWRITES it while keeping
	 * the stored name. A `readdir` (and therefore the glob scan) still returns the stored casing, so the local
	 * tree is keyed by the on-disk case exactly as on a real device. A case-ONLY rename (`index.html` →
	 * `Index.html`) still changes the stored casing (the destination leaf keeps its requested case). This is
	 * what lets the suite reproduce case-divergence bugs that memfs (case-sensitive) structurally cannot.
	 */
	caseInsensitive?: boolean
	/**
	 * Model a volume that does not expose stable per-file inodes. Many SMB / network mounts report `ino: 0`
	 * (or a value that is not stable across a remount) for every entry — memfs always hands out unique, stable
	 * inodes, so the engine's inode-based rename/identity detection is never exercised against this reality
	 * without it. `"zero"` forces every stat/lstat to report `ino: 0`.
	 */
	inodeMode?: "stable" | "zero"
	/**
	 * Add a deterministic sub-millisecond fraction to every reported `mtimeMs` (both stat and lstat), modelling
	 * the fractional precision a real filesystem returns (NTFS 100ns, ext4/APFS ns) that memfs's integer-ms
	 * clock does not. Exercises the engine's whole-second mtime normalization against non-integer inputs.
	 */
	fractionalMtime?: boolean
	/**
	 * Model a volume that cannot report a file creation/birth time. SMB/CIFS, tmpfs and old ext4 return
	 * `birthtimeMs: 0` for every entry — memfs always hands out a real birthtime, so the engine's birthtime-based
	 * inode-reuse rename guard (F8) is never exercised against this reality without it. `"zero"` forces every
	 * stat/lstat to report `birthtimeMs: 0` (→ the local item's `creation` becomes 0).
	 */
	birthtimeMode?: "stable" | "zero"
}

/**
 * Create an in-memory filesystem that satisfies the engine's {@link SyncFS} and
 * {@link SyncGlobFS} contracts. Backed by memfs (battle-tested), with the
 * fs-extra conveniences the engine relies on (`ensureDir`, `exists`,
 * `pathExists`, `move`) layered on top, plus a per-path error-injection map for
 * resilience tests. Pass `{ caseInsensitive: true }` to model a Windows/macOS/SMB volume.
 */
export function createVirtualFS(initial: VfsSpec = {}, options: CreateVirtualFSOptions = {}): VirtualFS {
	const vol = new Volume()
	const ifs = createFsFromVolume(vol)
	const caseInsensitive = options.caseInsensitive ?? false
	const inodeMode = options.inodeMode ?? "stable"
	const fractionalMtime = options.fractionalMtime ?? false
	const birthtimeMode = options.birthtimeMode ?? "stable"

	applyVfsSpec(ifs, initial)

	// Resolve a posix path against the ACTUALLY-STORED casing, segment by segment, on a case-insensitive
	// volume: at each level read the parent's real entries and match case-insensitively, so a differently-cased
	// path lands on the existing file/dir. A segment with no case-insensitive match keeps its requested casing
	// (a not-yet-created leaf or ancestor). On a case-sensitive volume this is the identity. `keepLeafCase`
	// preserves the final segment's requested casing even when it case-insensitively matches an existing entry
	// — used for a rename/move DESTINATION so a case-only rename actually re-cases the stored name.
	const resolveStored = (posixPath: string, keepLeafCase = false): string => {
		if (!caseInsensitive) {
			return posixPath
		}

		const segments = posixPath.split("/").filter(segment => segment.length > 0)
		let stored = ""

		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i]!
			const isLeaf = i === segments.length - 1

			if (keepLeafCase && isLeaf) {
				stored = `${stored}/${segment}`

				continue
			}

			let entries: string[]

			try {
				entries = vol.readdirSync(stored === "" ? "/" : stored) as string[]
			} catch {
				entries = []
			}

			const match = entries.find(entry => String(entry).toLowerCase() === segment.toLowerCase())

			stored = `${stored}/${match !== undefined ? String(match) : segment}`
		}

		return stored === "" ? "/" : stored
	}

	// The single normalizer every fs method funnels its path(s) through: posix-normalize (host separators →
	// memfs posix), then case-resolve against stored casing.
	const resolvePath = <T>(path: T, keepLeafCase = false): T =>
		(typeof path === "string" ? resolveStored(toPosixPath(path), keepLeafCase) : path) as T

	const errors = new Map<string, NodeJS.ErrnoException>()
	// Forced inode numbers (posix path -> ino) so a test can reproduce ext4-style inode reuse, which
	// memfs's allocator does not surface naturally.
	const inodeOverrides = new Map<string, number>()
	// Directories whose `globFs.readdir` should fail (posix path -> error), modelling a transient
	// enumeration failure on a network share (EIO/EACCES) that FastGlob's suppressErrors swallows — the
	// only way to reproduce a PARTIAL local scan (a subtree silently omitted) that the engine must not
	// read as a mass deletion.
	const globReaddirErrors = new Map<string, NodeJS.ErrnoException>()
	// Optional one-shot-friendly hook fired after each lstat/stat returns, so a test can mutate a file
	// mid-scan (after the engine read it) to reproduce a read-during-scan race deterministically.
	let statHook: ((posixPath: string) => void) | null = null
	// `guard` is always called with an already-posix-normalized path (each method normalizes its inputs
	// at entry), so the error map — keyed by the posix paths tests inject — matches on every host.
	const guard = (path: string): void => {
		const error = errors.get(path)

		if (error) {
			throw error
		}
	}

	const promises = ifs.promises

	// Apply the configured volume traits to a raw memfs Stats: inode model (SMB `ino: 0`), a per-path inode
	// override (ext4-reuse tests), and a fractional-mtime component (real-fs sub-ms precision). Mutates and
	// returns the same Stats object.
	type MutableStats = { ino: number; mtimeMs: number; mtime: Date; birthtimeMs: number; birthtime: Date }
	const applyStatTraits = (stats: MutableStats, path: string): MutableStats => {
		if (inodeMode === "zero") {
			stats.ino = 0
		}

		const overriddenInode = inodeOverrides.get(path)

		if (overriddenInode !== undefined) {
			stats.ino = overriddenInode
		}

		if (birthtimeMode === "zero" && stats.birthtimeMs !== 0) {
			stats.birthtimeMs = 0
			stats.birthtime = new Date(0)
		}

		let mtimeMs = stats.mtimeMs

		// A fixed, deterministic fraction — enough to be non-integer, small enough never to cross a whole
		// second on its own (so it only ever exercises the flooring, never shifts the second).
		if (fractionalMtime) {
			mtimeMs += 0.4482
		}

		if (mtimeMs !== stats.mtimeMs) {
			stats.mtimeMs = mtimeMs
			stats.mtime = new Date(mtimeMs)
		}

		return stats
	}

	const fs = {
		constants: ifs.constants,
		stat: async (path: string) => {
			path = resolvePath(path)
			guard(path)

			const stats = applyStatTraits((await promises.stat(path)) as unknown as MutableStats, path)

			if (statHook) {
				statHook(path)
			}

			return stats
		},
		lstat: async (path: string) => {
			path = resolvePath(path)
			guard(path)

			const stats = applyStatTraits((await promises.lstat(path)) as unknown as MutableStats, path)

			if (statHook) {
				statHook(path)
			}

			return stats
		},
		access: async (path: string, mode?: number) => {
			path = resolvePath(path)
			guard(path)

			return await promises.access(path, mode)
		},
		exists: async (path: string): Promise<boolean> => {
			try {
				path = resolvePath(path)
				guard(path)

				await promises.access(path)

				return true
			} catch {
				return false
			}
		},
		pathExists: async (path: string): Promise<boolean> => {
			try {
				path = resolvePath(path)
				guard(path)

				await promises.access(path)

				return true
			} catch {
				return false
			}
		},
		ensureDir: async (path: string): Promise<void> => {
			path = resolvePath(path)
			guard(path)

			await promises.mkdir(path, { recursive: true })
		},
		mkdir: async (path: string, options?: { recursive?: boolean }) => {
			path = resolvePath(path)
			guard(path)

			return await promises.mkdir(path, options)
		},
		rm: async (
			path: string,
			options?: { force?: boolean; maxRetries?: number; recursive?: boolean; retryDelay?: number }
		): Promise<void> => {
			path = resolvePath(path)
			guard(path)

			await promises.rm(path, options)
		},
		rename: async (src: string, dest: string): Promise<void> => {
			src = resolvePath(src)
			// keepLeafCase: a case-only rename must re-case the stored leaf, not resolve back onto the source.
			dest = resolvePath(dest, true)
			guard(src)

			await promises.rename(src, dest)
		},
		move: async (src: string, dest: string, options?: { overwrite?: boolean }): Promise<void> => {
			src = resolvePath(src)
			dest = resolvePath(dest, true)
			guard(src)

			await promises.mkdir(pathModule.posix.dirname(dest), { recursive: true })

			if (options?.overwrite) {
				try {
					await promises.rm(dest, { recursive: true, force: true })
				} catch {
					// destination did not exist — nothing to overwrite
				}
			}

			await promises.rename(src, dest)
		},
		utimes: async (path: string, atime: number | Date, mtime: number | Date): Promise<void> => {
			path = resolvePath(path)
			guard(path)

			await promises.utimes(path, atime, mtime)
		},
		readFile: async (path: string, options?: { encoding?: BufferEncoding }) => {
			path = resolvePath(path)
			guard(path)

			return await promises.readFile(path, options)
		},
		writeFile: async (path: string, data: string | Uint8Array, options?: { encoding?: BufferEncoding }): Promise<void> => {
			path = resolvePath(path)
			guard(path)

			await promises.writeFile(path, data, options)
		},
		createReadStream: (path: string, options?: Parameters<IFs["createReadStream"]>[1]) => {
			path = resolvePath(path)
			guard(path)

			return ifs.createReadStream(path, options)
		},
		createWriteStream: (path: string, options?: Parameters<IFs["createWriteStream"]>[1]) => {
			path = resolvePath(path)
			guard(path)

			return ifs.createWriteStream(path, options)
		}
	}

	// FastGlob walks the tree through this adapter (lstat/stat/readdir + sync variants). On a Windows
	// runner @nodelib builds child paths with the host separator and may resolve the posix `cwd` to a
	// drive-rooted absolute, so every path it hands us is posix-normalized before reaching memfs. The
	// returned glob entries are already forward-slash (fast-glob normalizes its output on all platforms).
	const globFs = {
		lstat: (path: string, ...rest: unknown[]) => (ifs.lstat as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		lstatSync: (path: string, ...rest: unknown[]) => (ifs.lstatSync as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		stat: (path: string, ...rest: unknown[]) => (ifs.stat as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		statSync: (path: string, ...rest: unknown[]) => (ifs.statSync as (...args: unknown[]) => unknown)(toPosixPath(path), ...rest),
		readdir: (path: string, ...rest: unknown[]) => {
			const posix = toPosixPath(path)
			const injected = globReaddirErrors.get(posix)
			const callback = rest[rest.length - 1]

			// FastGlob's async reader calls readdir callback-style; deliver the injected error via the callback
			// exactly as a real failing readdir would, so suppressErrors swallows it and the subtree is omitted.
			if (injected && typeof callback === "function") {
				;(callback as (error: unknown) => void)(injected)

				return
			}

			return (ifs.readdir as (...args: unknown[]) => unknown)(posix, ...rest)
		},
		readdirSync: (path: string, ...rest: unknown[]) => {
			const posix = toPosixPath(path)
			const injected = globReaddirErrors.get(posix)

			if (injected) {
				throw injected
			}

			return (ifs.readdirSync as (...args: unknown[]) => unknown)(posix, ...rest)
		}
	}

	const controls: VirtualFS["controls"] = {
		// Every path-keyed control normalizes with resolvePath, exactly as the fs methods do before they
		// consult these maps: posix-normalize (host separators → memfs posix) and, on a case-insensitive
		// volume, resolve against the stored casing — so an injected key matches the path the engine actually
		// stats/opens regardless of the casing the test wrote. On a case-sensitive volume this is the identity.
		getInode: (path: string): number | null => {
			try {
				return Number(vol.statSync(resolvePath(path)).ino)
			} catch {
				return null
			}
		},
		exists: (path: string): boolean => {
			try {
				vol.statSync(resolvePath(path))

				return true
			} catch {
				return false
			}
		},
		setInode: (path: string, ino: number): void => {
			inodeOverrides.set(resolvePath(path), ino)
		},
		clearInode: (path: string): void => {
			inodeOverrides.delete(resolvePath(path))
		},
		setError: (path: string, error: NodeJS.ErrnoException): void => {
			errors.set(resolvePath(path), error)
		},
		clearError: (path: string): void => {
			errors.delete(resolvePath(path))
		},
		setGlobReaddirError: (dirPath: string, error: NodeJS.ErrnoException): void => {
			globReaddirErrors.set(toPosixPath(dirPath), error)
		},
		clearGlobReaddirError: (dirPath: string): void => {
			globReaddirErrors.delete(toPosixPath(dirPath))
		},
		clearAllErrors: (): void => {
			errors.clear()
		},
		onStat: (hook: (posixPath: string) => void): void => {
			statHook = hook
		},
		clearStatHook: (): void => {
			statHook = null
		},
		toJSON: (): Record<string, string | null> => vol.toJSON()
	}

	return {
		fs: fs as unknown as SyncFS,
		globFs: globFs as unknown as SyncGlobFS,
		vol,
		ifs,
		controls
	}
}
