<br/>
<p align="center">
  <h3 align="center">Filen Sync</h3>

  <p align="center">
    A package to sync local and remote directories.
    <br/>
    <br/>
  </p>
</p>

![Contributors](https://img.shields.io/github/contributors/FilenCloudDienste/filen-sync?color=dark-green) ![Forks](https://img.shields.io/github/forks/FilenCloudDienste/filen-sync?style=social) ![Stargazers](https://img.shields.io/github/stars/FilenCloudDienste/filen-sync?style=social) ![Issues](https://img.shields.io/github/issues/FilenCloudDienste/filen-sync) ![License](https://img.shields.io/github/license/FilenCloudDienste/filen-sync)

### Installation

1. Install using NPM

```sh
npm install @filen/sync@latest
```

2. Initialize sync pairs

```typescript
import { FilenSDK } from "@filen/sdk"
import path from "path"
import os from "os"
import { SyncWorker } from "@filen/sync"

// Initialize a SDK instance (optional)
const filen = new FilenSDK({
	metadataCache: true,
	connectToSocket: true,
	tmpPath: path.join(os.tmpdir(), "filen-sdk")
})

await filen.login({
	email: "your@email.com",
	password: "supersecret123",
	twoFactorCode: "123456"
})

const sync = new SyncWorker({
	syncPairs: [
		{
			uuid: "UUIDV4", // Only used locally to identify the sync pair
			localPath: pathModule.join(__dirname, "sync"), // Local absolute path
			remotePath: "/sync", // Remote absolute path (UNIX style)
			remoteParentUUID: "UUIDV4", // UUIDv4 of the remote parent directory
			mode: "twoWay", // Sync mode
			paused: false, // Start paused
			excludeDotFiles: true, // Exclude dot files and paths
			localTrashDisabled: false, // Disable the local trash
			name: "Sync", // Only used locally to identify the sync pair
			requireConfirmationOnLargeDeletion: true, // Ask before applying a large deletion (see below)
			largeDeletionThreshold: 100 // Optional: how many deletions count as "large" (default: the whole pair)
		}
	],
	sdk: filen, // You can either directly pass a configured FilenSDK instance or instantiate a new SDK instance when passing `sdkConfig` (optional)
	sdkConfig, // FilenSDK config object (omit when SDK instance is passed, needed when no SDK instance is passed)
	dbPath: pathModule.join(__dirname, "db"), // Used to store sync state and other data
	runOnce: false, // Run the sync once
	onMessage(message) {
		console.log(message.type)
	}
})

// Start the sync
await sync.initialize()
```

## About this fork — large-deletion confirmation with a configurable threshold

A sync pair can ask for confirmation before it deletes many files at once — the situation where a mass deletion is usually a mistake (a disconnected drive, a folder moved out of the sync path, a wrong click) rather than an intent. Upstream only asks when *everything* the pair has ever synced would disappear; this fork adds `largeDeletionThreshold`, an absolute number of deletions at which the question is asked instead.

- `requireConfirmationOnLargeDeletion: true` turns the gate on for the pair.
- `largeDeletionThreshold: 100` asks as soon as a cycle would delete 100 or more items. Unset, the upstream rule applies (only a full wipe asks).
- Answer through `worker.confirmDeletion(uuid, "delete" | "restart")`: `"delete"` applies the deletions, `"restart"` keeps holding them (e.g. after restoring the files manually).

### Details

- **The threshold can only lower the bar, never raise it.** It is combined as `min(threshold, size of the previously-synced tree)`, so a threshold larger than the pair can never disable the full-wipe guarantee it refines.
- **The gate asks without blocking.** The cycle posts a `confirmDeletion` message (with `count`, the number of items at stake), defers the gated deletions and finishes. Uploads, downloads and creations keep flowing while the question is open; renames wait with the deletions, because executing them under a frozen base tree would corrupt the next cycle's counts. The account lock is never held while waiting, so other devices are unaffected.
- **An approval is bound to what was shown.** The answer carries a fingerprint (side + count) of the prompt it belongs to; if the deletion set changed between prompt and click, the approval is discarded and the question is asked again instead of silently applying to a bigger set.
- **A pending question suppresses `cycleSuccess`** and the prompt is re-posted every cycle, so a UI can keep a persistent warning up without polling.
- Deletions are held by *not advancing* the base tree — nothing is forgotten across restarts, and the held items are re-detected (and re-asked about) until someone decides.

Behavior is specified by the scenario tests in `tests/scenarios/g-large-deletion.test.ts` (G1–G17).

## License

Distributed under the AGPL-3.0 License. See [LICENSE](https://github.com/FilenCloudDienste/filen-sync/blob/main/LICENSE.md) for more information.
