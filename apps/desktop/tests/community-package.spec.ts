import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

const community = { DSH_DESKTOP_APP_ID: 'com.missher.deepseek-harness', DSH_DESKTOP_COMMUNITY_BUILD: '1' }
const windows = { platform: 'win32', arch: 'x64' } as const

describe('unsigned community desktop distribution', () => {
  it('builds Windows without a fake official update service and keeps the unsigned artifact suffix', () => {
    expect(() => { validateDesktopPackageEnvironment(community, windows, { unsigned: true }) }).not.toThrow()
    const config = createElectronBuilderConfig({ ...community, DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')
    expect(config.extraMetadata).toHaveProperty('dshMandatoryUpdatePolicy', undefined)
    expect(config.publish).toBeNull()
    expect(config.artifactName).toContain('-unsigned')
  })
  it('does not relax ordinary release policy or allow official identity or signed community builds', () => {
    expect(() => { validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.example.desktop' }, windows, { unsigned: true }) }).toThrow(/ORIGIN/u)
    expect(() => { validateDesktopPackageEnvironment(community, windows) }).toThrow(/unsigned/u)
    expect(() => createElectronBuilderConfig({ ...community, DSH_DESKTOP_UNSIGNED: '0' }, 'win32', 'x64')).toThrow(/unsigned/u)
    expect(() => { validateDesktopPackageEnvironment({ ...community, DSH_DESKTOP_APP_ID: 'com.deepseek.harness' }, windows, { unsigned: true }) }).toThrow(/identity/u)
    expect(() => { validateDesktopPackageEnvironment({ ...community, DSH_DESKTOP_COMMUNITY_BUILD: 'yes' }, windows, { unsigned: true }) }).toThrow(/0 or 1/u)
  })
  it('requires an explicit file setting and never inherits the community opt-out from the environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'community-package-'))
    try {
      await writeFile(join(root, '.env.windows'), 'DSH_DESKTOP_APP_ID=com.example.desktop\n')
      const ordinary = loadDesktopPackageEnvironment('win32', community, root)
      expect(ordinary.DSH_DESKTOP_COMMUNITY_BUILD).toBeUndefined()
      expect(() => { validateDesktopPackageEnvironment(ordinary, windows, { unsigned: true }) }).toThrow(/ORIGIN/u)
      await writeFile(join(root, '.env.windows'), 'DSH_DESKTOP_APP_ID=com.missher.deepseek-harness\nDSH_DESKTOP_COMMUNITY_BUILD=1\n')
      expect(() => { validateDesktopPackageEnvironment(loadDesktopPackageEnvironment('win32', {}, root), windows, { unsigned: true }) }).not.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
