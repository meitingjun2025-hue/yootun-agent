/** Manual-replace installation of one unsigned macOS Desktop update. */

// yootun enterprise tier (registered inline change): Squirrel.Mac rejects unsigned bundles at
// install time, so unsigned macOS packages hand the extracted app to the user in Finder instead
// of driving the native installer. Windows and signed macOS packages keep the stock updater.
// See yootun/docs/inline-changes.md and yootun/docs/1110/18-macos-manual-update.md.

import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { app, shell } from 'electron'
import { MacUpdater, type AppUpdater, type UpdateDownloadedEvent } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { valid } from 'semver'
import { DesktopUpdateHttpExecutor } from './updates/electron-updater/http-executor.ts'

/** Packaged install mode resolved from the application manifest. */
export type DesktopUpdateInstall = 'system' | 'manual'

/**
 * Read the packaged manual-install marker; manifests without it keep system installation.
 * @param manifest Parsed application manifest.
 * @returns Validated install mode. Invalid explicit values reject instead of switching installers.
 */
export function desktopUpdateInstall(manifest: unknown): DesktopUpdateInstall {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  if (!('dshDesktopUpdateInstall' in manifest)) return 'system'
  const install = manifest.dshDesktopUpdateInstall
  if (install !== 'manual') throw new Error('desktop update: invalid packaged install mode')
  return install
}

/**
 * Install the Desktop HTTP executor on a non-singleton updater. The coordinator wires this
 * transport only onto the shared autoUpdater; this deliberate copy of its construction keeps
 * update-coordinator.ts unchanged while manual mode needs the same inactivity deadlines.
 * @param updater - Updater whose requests should carry the Desktop transport.
 */
export function installDesktopUpdateHttpExecutor(updater: AppUpdater): void {
  // electron-updater omits this internal transport property from its public declarations.
  const transportOwner = updater as AppUpdater & { httpExecutor: DesktopUpdateHttpExecutor }
  transportOwner.httpExecutor = new DesktopUpdateHttpExecutor(
    Number(process.env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS ?? 60_000),
    (authInfo, callback) => { updater.emit('login', authInfo, callback) },
  )
}

/**
 * Create the manual-replace updater for one packaged manifest and platform: macOS plus the
 * manual marker only. Every other combination returns undefined and keeps the stock updater,
 * including Windows manifests that carry the marker.
 * @param manifest - Parsed application manifest.
 * @param platform - Running or target platform of the application.
 * @returns The updater to hand to the coordinator, or undefined for the stock updater.
 */
export function manualDesktopUpdater(manifest: unknown, platform: string): ManualInstallMacUpdater | undefined {
  if (platform !== 'darwin' || desktopUpdateInstall(manifest) !== 'manual') return undefined
  const updater = new ManualInstallMacUpdater()
  installDesktopUpdateHttpExecutor(updater)
  return updater
}

/**
 * Extracts one SHA-512-verified update zip and returns the extracted .app bundle path.
 * @param zipPath - Verified zip reported by the updater's downloaded event.
 * @param version - Version the update feed declared; the extracted bundle must match it.
 * @param isCancelled - Read before extraction starts; a cancelled download never extracts.
 */
export type MacOSUpdateBundleExtractor =
  (zipPath: string, version: string, isCancelled: () => boolean) => Promise<string>

/** Characters removed from the application name before it names an extraction directory. */
const UNSAFE_DIRECTORY_CHARACTERS = /[/\\:\u0000-\u001f]/gu

/** Directory under the application-data path tried when Downloads is unavailable. */
const EXTRACTION_FALLBACK_DIRECTORY_NAME = 'updates'

/** Finder folder opened when the installed app's own folder cannot be derived. */
const MACOS_APPLICATIONS_FOLDER = '/Applications'

/** Bound on waiting for the folder handoff before quitting; expiry and failure still quit. */
const FOLDER_OPEN_LIMIT_MS = 3_000

/** Extraction subprocess bounds: total runtime and captured output. */
const COMMAND_TIMEOUT_MS = 5 * 60_000
const COMMAND_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024

/** Bounds for reading the extracted bundle version, a one-line plist value. */
const VERSION_PROBE_TIMEOUT_MS = 10_000
const VERSION_PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024

/** Extraction tool that preserves macOS bundle metadata inside the unzipped tree. */
const MACOS_DITTO = '/usr/bin/ditto'

/** Property-list reader for the extracted bundle's packaged version. */
const MACOS_PLUTIL = '/usr/bin/plutil'

/** Info.plist key carrying the user-facing bundle version. */
const BUNDLE_VERSION_KEY = 'CFBundleShortVersionString'

/**
 * Resolve one extraction target and require it to stay a direct child of the base directory.
 * The target is deleted wholesale before extraction, so an escape outside the base directory
 * would delete unrelated files.
 * @param baseDirectory - Downloads or the application-data fallback directory.
 * @param leafName - Final path segment of the requested target.
 * @returns The resolved target directory path.
 * @throws When the resolved target is not a direct child of the base directory.
 */
export function checkedUpdateTargetDirectory(baseDirectory: string, leafName: string): string {
  const directory = resolve(baseDirectory, leafName)
  if (dirname(directory) !== resolve(baseDirectory)) {
    throw new Error(`desktop update: the extraction target ${leafName} must be a direct child of its base directory`)
  }
  return directory
}

/**
 * Compose the extraction target from the application name and the checked version.
 * @param baseDirectory - Downloads or the application-data fallback directory.
 * @param appName - Application name as packaged; separator and control characters are stripped.
 * @param version - Checked update version; must be a valid semantic version.
 * @returns The validated target directory path.
 */
export function resolveMacOSUpdateTargetDirectory(baseDirectory: string, appName: string, version: string): string {
  if (valid(version) === null) throw new Error(`desktop update: the update version ${version} is not a valid semantic version`)
  const name = appName.replace(UNSAFE_DIRECTORY_CHARACTERS, '').trim()
  if (name.length === 0) throw new Error('desktop update: the application name is unusable for an extraction directory')
  return checkedUpdateTargetDirectory(baseDirectory, `${name}-${version}`)
}

/**
 * Run one extraction subprocess and return its standard output.
 * @param file - Absolute tool path; ditto and plutil stay outside the updater process.
 * @param args - Tool arguments.
 * @param timeoutMs - Total runtime bound; expiry kills the subprocess and rejects.
 * @param outputLimitBytes - Captured-output bound; excess kills the subprocess and rejects.
 * @returns Standard output as UTF-8 text.
 */
function runCommand(file: string, args: readonly string[], timeoutMs: number, outputLimitBytes: number): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: outputLimitBytes }, (failure: Error | null, stdout: string) => {
      if (failure !== null) { reject(failure); return }
      resolveCommand(stdout)
    })
  })
}

/** Render one unknown failure as a short message for a structured update error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Electron path lookup that reports an unavailable path as undefined instead of throwing.
 * @param name - Electron path registry key.
 * @returns The resolved path, or undefined when Electron rejects the lookup.
 */
function optionalApplicationPath(name: 'downloads' | 'userData'): string | undefined {
  try { return app.getPath(name) } catch (_error: unknown) {
    // Electron rejects some path lookups outside packaged contexts; extraction falls back.
    return undefined
  }
}

/** Extraction bases in fallback order: Downloads, then the application-data directory. */
function extractionBaseDirectories(): Array<string> {
  const directories: Array<string> = []
  const downloads = optionalApplicationPath('downloads')
  if (downloads !== undefined) directories.push(downloads)
  const userData = optionalApplicationPath('userData')
  if (userData !== undefined) directories.push(join(userData, EXTRACTION_FALLBACK_DIRECTORY_NAME))
  return directories
}

/**
 * Require exactly one real .app directory directly inside the extraction target.
 * @param directory - Extraction target that ditto has finished writing.
 * @returns The extracted .app bundle path.
 */
async function extractedAppBundlePath(directory: string): Promise<string> {
  const bundles = (await readdir(directory)).filter(entry => entry.endsWith('.app'))
  const bundle = bundles[0]
  if (bundles.length !== 1 || bundle === undefined) {
    throw new Error(`desktop update: the extracted macOS update must contain exactly one .app bundle, found ${bundles.length}`)
  }
  const appPath = join(directory, bundle)
  // lstat rejects a symlinked bundle: the target must be the extracted directory itself.
  if (!(await lstat(appPath)).isDirectory()) throw new Error(`desktop update: the extracted .app bundle ${bundle} is not a directory`)
  return appPath
}

/**
 * Extract the verified zip into the first usable base directory.
 * @param zipPath - Verified downloaded zip.
 * @param version - Version the update feed declared, also used in the directory name.
 * @returns The extracted .app bundle path.
 */
async function extractAppBundle(zipPath: string, version: string): Promise<string> {
  const bases = extractionBaseDirectories()
  if (bases.length === 0) throw new Error('desktop update: no Downloads or application-data directory is available for the extracted update')
  let preparationFailure: unknown
  for (const base of bases) {
    const directory = resolveMacOSUpdateTargetDirectory(base, app.getName(), version)
    try {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
    } catch (error: unknown) {
      // An unwritable base falls back to the next candidate; the last failure is reported below.
      preparationFailure = error
      continue
    }
    await runCommand(MACOS_DITTO, ['-x', '-k', zipPath, directory], COMMAND_TIMEOUT_MS, COMMAND_OUTPUT_LIMIT_BYTES)
    return await extractedAppBundlePath(directory)
  }
  throw new Error(`desktop update: no extraction directory could be prepared: ${describeError(preparationFailure)}`)
}

/**
 * Reject an extracted bundle whose packaged version differs from the checked update version.
 * @param appPath - Extracted .app bundle path.
 * @param version - Version the update feed declared.
 */
async function assertBundleVersion(appPath: string, version: string): Promise<void> {
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const bundleVersion = (await runCommand(MACOS_PLUTIL,
    ['-extract', BUNDLE_VERSION_KEY, 'raw', '-o', '-', plistPath],
    VERSION_PROBE_TIMEOUT_MS, VERSION_PROBE_OUTPUT_LIMIT_BYTES)).trim()
  if (bundleVersion !== version) {
    throw new Error(`desktop update: the extracted app version ${bundleVersion} does not match the update version ${version}`)
  }
}

/**
 * Default extraction: unzip with ditto into Downloads (falling back to the application-data
 * directory), require exactly one real .app bundle, and reject a version mismatch.
 * @param zipPath - Verified zip reported by the updater's downloaded event.
 * @param version - Version the update feed declared.
 * @param isCancelled - Read before extraction starts; a cancelled download never extracts.
 * @returns The extracted .app bundle path.
 */
export const extractMacOSUpdateBundle: MacOSUpdateBundleExtractor = async (zipPath, version, isCancelled) => {
  if (isCancelled()) throw new Error('desktop update: the download was cancelled before the macOS update could be extracted')
  const appPath = await extractAppBundle(zipPath, version)
  await assertBundleVersion(appPath, version)
  return appPath
}

/**
 * Open the folder that holds the installed app so a replacement drag lands on the exact copy
 * to overwrite; every failure is a warning that never blocks the quit.
 */
async function openInstalledApplicationFolder(): Promise<void> {
  let folder = MACOS_APPLICATIONS_FOLDER
  try {
    // The executable path is <folder>/<App>.app/Contents/MacOS/<binary>: four parent steps reach <folder>.
    folder = dirname(dirname(dirname(dirname(app.getPath('exe')))))
  } catch (error: unknown) {
    console.warn(`desktop update: could not derive the installed application folder, opening ${folder}: ${describeError(error)}`)
  }
  const openFailure = await shell.openPath(folder)
  if (openFailure !== '') console.warn(`desktop update: could not open the installed application folder ${folder}: ${openFailure}`)
}

/** Resolve when the folder handoff wait reaches its bound. */
function quitDelay(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, FOLDER_OPEN_LIMIT_MS) })
}

/**
 * Updater for unsigned macOS packages: the stock download stays untouched, and installation
 * becomes a Finder handoff because Squirrel.Mac cannot validate an unsigned bundle.
 */
export class ManualInstallMacUpdater extends MacUpdater {
  /** Extracted .app path recorded by the last completed download preparation. */
  private extractedAppPath: string | undefined
  /** Set once the reveal has succeeded; repeat handoffs neither show again nor quit again. */
  private quitRequested = false

  /**
   * @param extract - Extraction implementation; the default unzips with ditto into Downloads.
   */
  constructor(private readonly extract: MacOSUpdateBundleExtractor = extractMacOSUpdateBundle) { super() }

  protected override async doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<Array<string>> {
    let downloaded: UpdateDownloadedEvent | undefined
    const onDownloaded = (event: UpdateDownloadedEvent): void => { downloaded = event }
    // The base class dispatches update-downloaded before doDownloadUpdate resolves; the event
    // carries the verified zip path that manual replacement extracts.
    this.once('update-downloaded', onDownloaded)
    let downloadedPaths: Array<string>
    try {
      downloadedPaths = await super.doDownloadUpdate(downloadUpdateOptions)
    } finally {
      this.off('update-downloaded', onDownloaded)
    }
    if (downloaded === undefined) throw new Error('desktop update: the macOS updater finished without reporting the downloaded package')
    const { downloadedFile, version } = downloaded
    this.extractedAppPath = await this.extract(downloadedFile, version, () => downloadUpdateOptions.cancellationToken.cancelled)
    this.closeSquirrelProxyIfExists()
    return downloadedPaths
  }

  /**
   * Reveal the extracted app in Finder, open the installed app's folder, and quit once that
   * handoff has settled so the user can drag the replacement into place. Never calls the
   * native updater, whose signature validation an unsigned bundle cannot pass. Failures
   * report through the updater's error event and leave the application running.
   */
  override quitAndInstall(): void {
    if (this.quitRequested) return
    const appPath = this.extractedAppPath
    if (appPath === undefined) {
      this.emit('error', new Error('desktop update: the extracted macOS update is not ready for manual replacement'))
      return
    }
    try {
      shell.showItemInFolder(appPath)
    } catch (error: unknown) {
      // A failed reveal leaves the extracted bundle in place and the application running.
      this.emit('error', error instanceof Error ? error : new Error(`desktop update: Finder did not reveal the extracted update: ${describeError(error)}`))
      return
    }
    this.quitRequested = true
    void Promise.race([openInstalledApplicationFolder(), quitDelay()])
      .then(() => { app.quit() }, () => { app.quit() })
  }

  /** Close the base class's Squirrel proxy server; manual replacement never hands the zip to Squirrel. */
  private closeSquirrelProxyIfExists(): void {
    // electron-updater omits this runtime prototype method from its usable public surface by
    // declaring it private; the prototype face keeps the call typed for bases without it.
    const closer = (this.constructor.prototype as { closeServerIfExists?: (() => void) | undefined }).closeServerIfExists
    closer?.call(this)
  }
}
