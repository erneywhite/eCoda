// electron-builder afterPack hook: runs after the .app is assembled in
// dist/mac-arm64/ but BEFORE it's wrapped into the .dmg/.zip. We use it
// to add a deep ad-hoc codesign to the .app, which electron-builder
// itself can't do directly — its `identity: "-"` config is interpreted
// as an identity *name* to look up in the keychain, not as the special
// `codesign --sign -` ad-hoc marker, so without us it just emits
// `skipped macOS application code signing`.
//
// Why we need this: Squirrel.Mac (the framework electron-updater drives
// on macOS for auto-updates) calls SecStaticCodeCheckValidity on the
// downloaded .app before applying the update. An unsigned .app has no
// `Contents/_CodeSignature/CodeResources` manifest, and Squirrel fails
// with "code has no resources but signature indicates they must be
// present". A deep ad-hoc sign creates the missing manifest with
// consistent hashes for every nested binary + resource, so the check
// passes — even though we're still NOT Apple-Developer-ID-signed, so
// Gatekeeper still blocks first launch (user has to "Open Anyway"
// from System Settings → Privacy & Security).
//
// We deliberately DON'T pass `--options runtime` here. The bundled
// standalone Python (resources/python-mac/) ships its own pre-signed
// libraries with a different Team ID; hardened-runtime forces all
// dlopen'd libraries to match the outer binary's Team ID, and that
// breakage was paid for in blood during the 0.0.47 mac port (we tried
// it on yt-dlp_macos and Python.framework refused to load).
const { spawnSync } = require('node:child_process')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  const productName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${productName}.app`

  // Strip extended attributes first — codesign refuses to sign a bundle
  // that contains files with `com.apple.FinderInfo`, `com.apple.Resource-
  // Fork`, or (on macOS Sequoia+) `com.apple.provenance` and
  // `com.apple.fileprovider.fpfs#P`. The PROBLEM with provenance is that
  // it's a restricted system xattr — `xattr -c` silently no-ops on it
  // (yes, even as root in some cases). The standard workaround is to
  // round-trip the bundle through `ditto --noextattr --norsrc`, which
  // copies everything WITHOUT extended attributes or resource forks —
  // effectively creating a clean version of the .app that codesign will
  // accept.
  console.log(`[afterPack] round-tripping ${appPath} via ditto to strip xattrs`)
  const tmpClean = `${appPath}.clean-tmp`
  const fs = require('node:fs')
  if (fs.existsSync(tmpClean)) {
    fs.rmSync(tmpClean, { recursive: true, force: true })
  }
  const dittoRes = spawnSync(
    'ditto',
    ['--noextattr', '--norsrc', appPath, tmpClean],
    { stdio: 'inherit' }
  )
  if (dittoRes.status !== 0) {
    throw new Error(`ditto exited with status ${dittoRes.status}`)
  }
  fs.rmSync(appPath, { recursive: true, force: true })
  fs.renameSync(tmpClean, appPath)

  console.log(`[afterPack] ad-hoc signing ${appPath}`)
  const res = spawnSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', appPath],
    { stdio: 'inherit' }
  )
  if (res.status !== 0) {
    throw new Error(`codesign exited with status ${res.status}`)
  }

  // Quick sanity check — Squirrel.Mac runs this exact validation on the
  // downloaded .app and refuses to apply the update if it fails. If we
  // ship a build that doesn't pass this here, auto-update is broken.
  const verify = spawnSync(
    'codesign',
    ['--verify', '--deep', '--strict', appPath],
    { stdio: 'inherit' }
  )
  if (verify.status !== 0) {
    throw new Error(
      `codesign --verify --deep --strict failed on ${appPath} — Squirrel.Mac will reject this build`
    )
  }
  console.log(`[afterPack] ad-hoc signature verified — Squirrel.Mac will accept this build`)
}
