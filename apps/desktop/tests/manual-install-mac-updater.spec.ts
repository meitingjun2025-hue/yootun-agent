import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { desktopUpdateReadyConfirmation, zh } from '../src/locale.ts'
import {
  ManualInstallMacUpdater, checkedUpdateTargetDirectory, desktopUpdateInstall,
  manualDesktopUpdater, resolveMacOSUpdateTargetDirectory,
} from '../src/manual-install-mac-updater.ts'
import { DesktopUpdateHttpExecutor } from '../src/updates/electron-updater/http-executor.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } = await import('node:fs')
  const paths = new Map<string, string>()
  const app = {
    isPackaged: true,
    getName: vi.fn(() => 'Yootun-Agent'),
    getPath: vi.fn((name: string): string => {
      const value = paths.get(name)
      if (value === undefined) throw new Error(`no ${name} path is configured in this fixture`)
      return value
    }),
    quit: vi.fn(),
  }
  const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
  // Native updater stand-in: the manual handoff must never touch any of these methods.
  const nativeUpdater = { quitAndInstall: vi.fn(), checkForUpdates: vi.fn(), setFeedURL: vi.fn() }
  // Base-class download stand-in: emits the downloaded event and resolves with the verified
  // paths unless a test configures a failure or a silent completion.
  const superDownload = {
    failure: undefined as (Error & { killed?: boolean }) | undefined,
    silent: false,
    zipPath: '/library-cache/verified.zip',
    version: '1.2.3',
    result: ['/library-cache/verified.zip'] as Array<string>,
  }
  const superQuitAndInstall = vi.fn()
  // The real base creates its Squirrel proxy server during download and closes it through
  // this runtime prototype method; manual replacement closes it after extraction.
  const superCloseServer = vi.fn()
  class FakeMacUpdater extends EventEmitter {
    async doDownloadUpdate(_downloadUpdateOptions: unknown): Promise<Array<string>> {
      if (superDownload.failure !== undefined) throw superDownload.failure
      if (!superDownload.silent) {
        this.emit('update-downloaded', { version: superDownload.version, downloadedFile: superDownload.zipPath })
      }
      return superDownload.result
    }
    closeServerIfExists(): void { superCloseServer() }
    quitAndInstall(): void { superQuitAndInstall() }
  }
  const childProcess = {
    commands: [] as Array<{ file: string; args: Array<string> }>,
    failure: undefined as (Error & { killed?: boolean }) | undefined,
    layout: 'bundle' as 'bundle' | 'none' | 'two' | 'symlink',
    bundleVersion: undefined as string | undefined,
  }
  const execFile = vi.fn((file: string, args: Array<string>, _options: object,
    callback: (error: Error | null, stdout: string) => void) => {
    childProcess.commands.push({ file, args })
    if (childProcess.failure !== undefined) { callback(childProcess.failure, ''); return }
    if (file === '/usr/bin/ditto') {
      const target = args[3]!
      if (childProcess.layout === 'bundle') {
        mkdirSync(join(target, 'Yootun-Agent.app', 'Contents'), { recursive: true })
        writeFileSync(join(target, 'Yootun-Agent.app', 'Contents', 'Info.plist'), childProcess.bundleVersion ?? superDownload.version)
      } else if (childProcess.layout === 'two') {
        mkdirSync(join(target, 'One.app'), { recursive: true })
        mkdirSync(join(target, 'Two.app'), { recursive: true })
      } else if (childProcess.layout === 'symlink') {
        symlinkSync(target, join(target, 'Yootun-Agent.app'), 'dir')
      }
      callback(null, '')
      return
    }
    if (file === '/usr/bin/plutil') {
      callback(null, readFileSync(args[5]!, 'utf8'))
      return
    }
    callback(new Error(`unexpected command ${file}`), '')
  })
  return { app, shell, nativeUpdater, FakeMacUpdater, superDownload, superQuitAndInstall, superCloseServer,
    childProcess, execFile, paths, existsSync }
})

vi.mock('electron', () => ({ app: fixture.app, shell: fixture.shell, autoUpdater: fixture.nativeUpdater }))
vi.mock('electron-updater', () => ({ MacUpdater: fixture.FakeMacUpdater, default: { autoUpdater: fixture.nativeUpdater } }))
vi.mock('node:child_process', () => ({ execFile: fixture.execFile }))

const roots: Array<string> = []

afterEach(async () => {
  // clearAllMocks keeps the fixture implementations and only drops recorded calls; the shell
  // fns get explicit resets so a per-test implementation cannot leak into the next test.
  vi.useRealTimers()
  vi.clearAllMocks()
  fixture.shell.showItemInFolder.mockReset()
  fixture.shell.openPath.mockReset().mockImplementation(async () => '')
  fixture.superDownload.failure = undefined
  fixture.superDownload.silent = false
  fixture.superDownload.zipPath = '/library-cache/verified.zip'
  fixture.superDownload.version = '1.2.3'
  fixture.superDownload.result = ['/library-cache/verified.zip']
  fixture.childProcess.commands.length = 0
  fixture.childProcess.failure = undefined
  fixture.childProcess.layout = 'bundle'
  fixture.childProcess.bundleVersion = undefined
  fixture.paths.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Configure Downloads, the userData fallback, and the executable path in one temporary root. */
async function pathsFixture(): Promise<{ downloads: string; userData: string }> {
  const root = await mkdtemp(join(tmpdir(), 'manual-mac-updater-'))
  roots.push(root)
  const downloads = join(root, 'Downloads')
  const userData = join(root, 'UserData')
  await mkdir(downloads, { recursive: true })
  await mkdir(userData, { recursive: true })
  fixture.paths.set('downloads', downloads)
  fixture.paths.set('userData', userData)
  fixture.paths.set('exe', join(downloads, 'Applications', 'Yootun-Agent.app', 'Contents', 'MacOS', 'yootun-agent'))
  return { downloads, userData }
}

/** Feed stand-in data: the download path reads only the cancellation token, so the provider slot is an empty stand-in. */
function downloadOptions(cancelled: boolean): DownloadUpdateOptions {
  return {
    updateInfoAndProvider: {
      info: updateInfoFixture(fixture.superDownload.version),
      provider: {} as DownloadUpdateOptions['updateInfoAndProvider']['provider'],
    },
    requestHeaders: {},
    cancellationToken: { cancelled } as DownloadUpdateOptions['cancellationToken'],
  }
}

/** Feed-info stand-in; the legacy required members are filled without being read. */
function updateInfoFixture(version: string): DownloadUpdateOptions['updateInfoAndProvider']['info'] {
  return Object.assign({ version, files: [] as Array<never>, releaseDate: '' }, { path: '', sha512: '' })
}

/** Flush the pending microtasks so a settled folder handoff reaches its quit call. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/** Drive the protected download override with the fixture's cancellation state. */
class TestDownload extends ManualInstallMacUpdater {
  run(cancelled = false): Promise<Array<string>> { return this.doDownloadUpdate(downloadOptions(cancelled)) }
}

describe('desktop update install marker', () => {
  it('reads the packaged manual-install marker with the channel strictness', () => {
    expect(desktopUpdateInstall({ version: '1.0.0', dshDesktopUpdateInstall: 'manual' })).toBe('manual')
    expect(desktopUpdateInstall({ version: '1.0.0' })).toBe('system')
    expect(() => desktopUpdateInstall({ dshDesktopUpdateInstall: 'guided' })).toThrow(/install mode/u)
    expect(() => desktopUpdateInstall(null)).toThrow(/manifest/u)
  })
})

describe('manual updater selection', () => {
  it('builds the manual updater with the Desktop transport only on darwin with the marker', () => {
    const updater = manualDesktopUpdater({ dshDesktopUpdateInstall: 'manual' }, 'darwin')
    expect(updater).toBeInstanceOf(ManualInstallMacUpdater)
    const transportOwner = updater as ManualInstallMacUpdater & { httpExecutor?: DesktopUpdateHttpExecutor }
    expect(transportOwner.httpExecutor).toBeInstanceOf(DesktopUpdateHttpExecutor)
  })

  it('keeps the stock updater without the marker, on non-darwin platforms, and rejects invalid values', () => {
    expect(manualDesktopUpdater({}, 'darwin')).toBeUndefined()
    expect(manualDesktopUpdater({ dshDesktopUpdateInstall: 'manual' }, 'win32')).toBeUndefined()
    expect(manualDesktopUpdater({ dshDesktopUpdateInstall: 'manual' }, 'linux')).toBeUndefined()
    expect(() => manualDesktopUpdater(null, 'darwin')).toThrow(/manifest/u)
    expect(() => manualDesktopUpdater({ dshDesktopUpdateInstall: 'guided' }, 'darwin')).toThrow(/install mode/u)
  })
})

describe('manual download preparation', () => {
  it('extracts the zip path from the downloaded event and forwards the base return value', async () => {
    fixture.superDownload.zipPath = '/library-cache/event.zip'
    fixture.superDownload.result = ['/library-cache/returned.zip']
    const extracted: Array<[string, string, boolean]> = []
    const updater = new TestDownload(async (zipPath, version, isCancelled) => {
      extracted.push([zipPath, version, isCancelled()])
      return '/downloads/Yootun-Agent.app'
    })
    await expect(updater.run()).resolves.toEqual(['/library-cache/returned.zip'])
    expect(extracted).toEqual([['/library-cache/event.zip', '1.2.3', false]])
    expect(updater.listenerCount('update-downloaded')).toBe(0)
    const cancelled = new TestDownload(async (_zipPath, _version, isCancelled) => {
      expect(isCancelled()).toBe(true)
      return '/downloads/Yootun-Agent.app'
    })
    await cancelled.run(true)
  })

  it('propagates a base download failure without extracting', async () => {
    fixture.superDownload.failure = new Error('checksum rejected')
    const extract = vi.fn(async () => '/downloads/Yootun-Agent.app')
    const updater = new TestDownload(extract)
    await expect(updater.run()).rejects.toThrow('checksum rejected')
    expect(extract).not.toHaveBeenCalled()
    expect(updater.listenerCount('update-downloaded')).toBe(0)
  })

  it('rejects a silent completion that never reported the downloaded package', async () => {
    fixture.superDownload.silent = true
    const extract = vi.fn(async () => '/downloads/Yootun-Agent.app')
    const updater = new TestDownload(extract)
    await expect(updater.run()).rejects.toThrow(/reporting the downloaded package/u)
    expect(extract).not.toHaveBeenCalled()
    expect(updater.listenerCount('update-downloaded')).toBe(0)
  })

  it('turns an extraction failure into a download failure and never hands off', async () => {
    const updater = new TestDownload(async () => { throw new Error('ditto died') })
    await expect(updater.run()).rejects.toThrow('ditto died')
    const errors: Array<Error> = []
    updater.on('error', (error) => { errors.push(error) })
    updater.quitAndInstall()
    expect(errors).toHaveLength(1)
    expect(fixture.app.quit).not.toHaveBeenCalled()
    expect(fixture.shell.showItemInFolder).not.toHaveBeenCalled()
    expect(fixture.nativeUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(fixture.superQuitAndInstall).not.toHaveBeenCalled()
  })

  it('closes the base Squirrel proxy once extraction succeeds and not before', async () => {
    fixture.superDownload.silent = true
    await expect(new TestDownload(async () => '/Downloads/Yootun-Agent.app').run()).rejects.toThrow(/reporting the downloaded package/u)
    expect(fixture.superCloseServer).not.toHaveBeenCalled()
    fixture.superDownload.silent = false
    await new TestDownload(async () => '/Downloads/Yootun-Agent.app').run()
    expect(fixture.superCloseServer).toHaveBeenCalledOnce()
  })
})

describe('manual quit and install handoff', () => {
  async function preparedUpdater(): Promise<TestDownload> {
    const updater = new TestDownload(async () => '/Downloads/Yootun-Agent-1.2.3/Yootun-Agent.app')
    await updater.run()
    return updater
  }

  it('reveals the extracted app once, opens the installed folder, and quits exactly once', async () => {
    const { downloads } = await pathsFixture()
    const updater = await preparedUpdater()
    updater.quitAndInstall()
    updater.quitAndInstall()
    expect(fixture.shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/Downloads/Yootun-Agent-1.2.3/Yootun-Agent.app')
    await settle()
    expect(fixture.app.quit).toHaveBeenCalledOnce()
    expect(fixture.shell.openPath).toHaveBeenCalledExactlyOnceWith(join(downloads, 'Applications'))
    // The manual handoff never drives the native updater or its base-class install path.
    expect(fixture.nativeUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(fixture.nativeUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(fixture.nativeUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(fixture.superQuitAndInstall).not.toHaveBeenCalled()
  })

  it('reports an unprepared handoff through the error event without quitting', async () => {
    await pathsFixture()
    const updater = new TestDownload(async () => '/Downloads/Yootun-Agent.app')
    const errors: Array<Error> = []
    updater.on('error', (error) => { errors.push(error) })
    updater.quitAndInstall()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/not ready/u)
    expect(fixture.app.quit).not.toHaveBeenCalled()
    expect(fixture.shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('reports a failed Finder reveal without quitting and stays retryable', async () => {
    await pathsFixture()
    fixture.shell.showItemInFolder.mockImplementationOnce(() => { throw new Error('reveal refused') })
    const updater = await preparedUpdater()
    const errors: Array<Error> = []
    updater.on('error', (error) => { errors.push(error) })
    updater.quitAndInstall()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('reveal refused')
    expect(fixture.app.quit).not.toHaveBeenCalled()
    updater.quitAndInstall()
    expect(fixture.shell.showItemInFolder).toHaveBeenCalledTimes(2)
  })

  it('keeps quitting when the installed folder cannot be opened', async () => {
    await pathsFixture()
    const warnings: Array<string> = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
    fixture.shell.openPath.mockResolvedValueOnce('folder is locked')
    const updater = await preparedUpdater()
    updater.quitAndInstall()
    // The folder warning lands after the fire-and-forget open resolves, not inside the quit call.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(fixture.app.quit).toHaveBeenCalledOnce()
    expect(warnings.some(message => message.includes('could not open the installed application folder'))).toBe(true)
    warn.mockRestore()
  })

  it('falls back to /Applications when the executable path cannot be derived', async () => {
    await pathsFixture()
    fixture.paths.delete('exe')
    const updater = await preparedUpdater()
    updater.quitAndInstall()
    await settle()
    expect(fixture.shell.openPath).toHaveBeenCalledWith('/Applications')
    expect(fixture.app.quit).toHaveBeenCalledOnce()
  })

  it('quits only after the folder handoff resolves', async () => {
    await pathsFixture()
    let resolveOpen: (failure: string) => void = () => {}
    fixture.shell.openPath.mockImplementation(() => new Promise((resolve) => { resolveOpen = resolve }))
    const updater = await preparedUpdater()
    updater.quitAndInstall()
    expect(fixture.app.quit).not.toHaveBeenCalled()
    resolveOpen('')
    await settle()
    expect(fixture.app.quit).toHaveBeenCalledOnce()
  })

  it('quits at the folder handoff limit when opening never settles', async () => {
    vi.useFakeTimers()
    await pathsFixture()
    fixture.shell.openPath.mockImplementation(() => new Promise<string>(() => {}))
    const updater = await preparedUpdater()
    updater.quitAndInstall()
    expect(fixture.app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fixture.app.quit).toHaveBeenCalledOnce()
    expect(fixture.shell.showItemInFolder).toHaveBeenCalledOnce()
  })
})

describe('default macOS extraction', () => {
  it('extracts with ditto into a fresh Downloads target and verifies the bundle version', async () => {
    const { downloads } = await pathsFixture()
    const zipPath = '/library-cache/verified.zip'
    const updater = new TestDownload()
    // The override forwards the base return value; the extracted bundle shows up in the handoff.
    await expect(updater.run()).resolves.toEqual(['/library-cache/verified.zip'])
    expect(fixture.childProcess.commands).toEqual([
      { file: '/usr/bin/ditto', args: ['-x', '-k', zipPath, join(downloads, 'Yootun-Agent-1.2.3')] },
      { file: '/usr/bin/plutil', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(downloads, 'Yootun-Agent-1.2.3', 'Yootun-Agent.app', 'Contents', 'Info.plist')] },
    ])
    updater.quitAndInstall()
    expect(fixture.shell.showItemInFolder).toHaveBeenCalledWith(join(downloads, 'Yootun-Agent-1.2.3', 'Yootun-Agent.app'))
  })

  it('deletes a stale target directory before extraction starts', async () => {
    const { downloads } = await pathsFixture()
    const target = join(downloads, 'Yootun-Agent-1.2.3')
    const stale = join(target, 'stale.txt')
    await mkdir(target, { recursive: true })
    writeFileSync(stale, 'stale', 'utf8')
    const updater = new TestDownload()
    await updater.run()
    expect(fixture.childProcess.commands[0]).toBeDefined()
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(join(target, 'Yootun-Agent.app'))).toBe(true)
  })

  it('rejects a ditto failure and a ditto timeout as download failures', async () => {
    await pathsFixture()
    fixture.childProcess.failure = Object.assign(new Error('Command failed: ditto exited 1'), { killed: false })
    await expect(new TestDownload().run()).rejects.toThrow('ditto exited 1')
    fixture.childProcess.failure = Object.assign(new Error('Command failed: ditto'), { killed: true })
    await expect(new TestDownload().run()).rejects.toThrow('Command failed: ditto')
    expect(fixture.childProcess.commands).toHaveLength(2)
  })

  it('never starts extraction for a cancelled download', async () => {
    await pathsFixture()
    await expect(new TestDownload().run(true)).rejects.toThrow(/cancelled before the macOS update could be extracted/u)
    expect(fixture.childProcess.commands).toHaveLength(0)
  })

  it.each(['none', 'two', 'symlink'] as const)('rejects a %s .app extraction result', async (layout) => {
    await pathsFixture()
    fixture.childProcess.layout = layout
    await expect(new TestDownload().run()).rejects.toThrow(layout === 'symlink'
      ? /is not a directory/u
      : /exactly one \.app bundle, found/u)
  })

  it('rejects an extracted bundle whose version differs from the update version', async () => {
    await pathsFixture()
    fixture.childProcess.bundleVersion = '0.9.0'
    await expect(new TestDownload().run()).rejects.toThrow(/0\.9\.0 does not match the update version 1\.2\.3/u)
  })

  it('falls back to the application-data directory when Downloads is unavailable', async () => {
    const { userData } = await pathsFixture()
    fixture.paths.delete('downloads')
    const updater = new TestDownload()
    await updater.run()
    updater.quitAndInstall()
    expect(fixture.shell.showItemInFolder).toHaveBeenCalledWith(join(userData, 'updates', 'Yootun-Agent-1.2.3', 'Yootun-Agent.app'))
  })

  it('rejects the download when no extraction base is available', async () => {
    await pathsFixture()
    fixture.paths.delete('downloads')
    fixture.paths.delete('userData')
    await expect(new TestDownload().run()).rejects.toThrow(/no Downloads or application-data directory is available/u)
    expect(fixture.childProcess.commands).toHaveLength(0)
  })
})

describe('extraction target validation', () => {
  it('rejects escape leaves and invalid versions, and strips separator characters from the name', () => {
    expect(() => checkedUpdateTargetDirectory('/downloads', '../escape')).toThrow(/direct child/u)
    expect(() => checkedUpdateTargetDirectory('/downloads', '.')).toThrow(/direct child/u)
    expect(checkedUpdateTargetDirectory('/downloads', 'Yootun-Agent-1.2.3')).toBe('/downloads/Yootun-Agent-1.2.3')
    expect(() => resolveMacOSUpdateTargetDirectory('/downloads', 'Yootun-Agent', 'not-a-version')).toThrow(/semantic version/u)
    expect(resolveMacOSUpdateTargetDirectory('/downloads', 'Yootun/Agent', '1.2.3')).toBe('/downloads/YootunAgent-1.2.3')
    expect(() => resolveMacOSUpdateTargetDirectory('/downloads', '  ', '1.2.3')).toThrow(/unusable/u)
  })
})

describe('manual update copy', () => {
  it('switches the downloaded-confirmation detail only for manual mode on darwin', () => {
    expect(desktopUpdateReadyConfirmation(zh, '1.2.3', 'darwin', true).detail).toBe(zh.updateDownloadedDetailManual)
    expect(desktopUpdateReadyConfirmation(zh, '1.2.3', 'darwin', false).detail).toBe(zh.updateDownloadedDetail)
    expect(desktopUpdateReadyConfirmation(zh, '1.2.3', 'win32', true).detail).toBe(zh.updateDownloadedDetailWindows)
    expect(desktopUpdateReadyConfirmation(zh, '1.2.3', 'win32', false).detail).toBe(zh.updateDownloadedDetailWindows)
    expect(desktopUpdateReadyConfirmation(zh, '1.2.3', 'darwin', true).message)
      .toBe(desktopUpdateReadyConfirmation(zh, '1.2.3', 'darwin', false).message)
  })

  it('rejects a default extractor call whose version is not a semantic version', async () => {
    await pathsFixture()
    fixture.superDownload.version = 'latest'
    await expect(new TestDownload().run()).rejects.toThrow(/semantic version/u)
    expect(fixture.childProcess.commands).toHaveLength(0)
  })
})
