export const SYNC_INTERVAL = 5000
// How often the local filesystem is force-rescanned as a SAFETY NET, independent of watcher events. When the
// watcher failed to start it is the ONLY change signal; when a watcher IS live it still runs, because fs.watch
// on SMB/NFS/some FUSE mounts can silently DROP a change notification — without a periodic bump the freshness
// gate would then serve the stale cached tree forever and the change would never sync. Bounds that staleness
// while keeping idle rescans infrequent (the watcher handles the common fast path).
export const LOCAL_RESCAN_SAFETY_INTERVAL = 60000
export const LOCAL_TRASH_NAME: string = ".filen.trash.local"
export const DEFAULT_IGNORED = {
	names: [
		".ds_store",
		"$recycle.bin",
		"system volume information",
		"._.ds_store",
		"desktop.ini",
		"thumbs.db",
		"ntuser.dat",
		".filen.trash.local",
		"AUX",
		"PRN",
		"NUL",
		"CON",
		"LPT1",
		"LPT2",
		"LPT3",
		"LPT4",
		"LPT5",
		"LPT6",
		"LPT7",
		"LPT8",
		"LPT9",
		"COM1",
		"COM2",
		"COM3",
		"COM4",
		"COM5",
		"COM6",
		"COM7",
		"COM8",
		"COM9"
	],
	extensions: [".tmp", ".temp", ".ffs_tmp", ".temporary", ".crdownload", ".~cr", ".thumbdata", ".crswap"],
	absoluteGlobs: [
		"*:/$WINDOWS.~BT/**/*",
		"*:/$RECYCLE.BIN/**/*",
		"*:/$Windows.~WS/**/*",
		"*:/$WinREAgent/**/*",
		"*:/OneDriveTemp/**/*",
		"*:/Program Files/**/*",
		"*:/Program Files (x86)/**/*",
		"*:/System Volume Information/**/*"
	],
	relativeGlobs: [".filen.trash.local/**/*", "$RECYCLE.BIN/**/*", "System Volume Information/**/*"]
}
