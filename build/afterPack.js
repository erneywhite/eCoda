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
// We deliberately DON'T pass `--options runtime`. The bundled standalone
// Python (resources/python-mac/) ships its own pre-signed libraries with
// a different Team ID; hardened-runtime forces all dlopen'd libraries to
// match the outer binary's Team ID, and that breakage was paid for in
// blood during the 0.0.47 mac port (Python.framework refused to load).
//
// === Why all the work happens in /tmp ===
// The repo lives under ~/Documents, which iCloud Drive ("Desktop &
// Documents Folders" sync) manages. iCloud's file provider continuously
// stamps `com.apple.fileprovider.fpfs#P` (and provenance) onto every
// file there — these are RESTRICTED system xattrs that `xattr -c` can't
// remove and that get re-added within milliseconds. codesign refuses to
// sign a bundle carrying them ("resource fork, Finder information, or
// similar detritus not allowed"). So we copy the bundle to a /tmp
// scratch dir (NOT file-provider-managed), do all the signing there
// where nothing re-stamps it, then copy the signed bundle back. The
// fpfs xattrs the destination re-acquires afterwards don't affect the
// signature — mild verify (what Squirrel runs) is content-hash based and
// ignores xattrs.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BUNDLE_ID = 'com.erneywhite.ecoda'
// Designated requirement pinned to the bundle identifier, NOT a cdhash.
// Without an Apple Developer identity, ad-hoc signing's default
// designated requirement is `cdhash H"..."` — the hash of this exact
// build. Squirrel.Mac validates a downloaded update against the RUNNING
// app's designated requirement, so a cdhash requirement means every new
// version (different code = different cdhash) fails with errSecCSReqFailed
// ("не удалось удовлетворить требованию к коду"). Pinning to the
// identifier lets any build with that id satisfy it → auto-update works.
const REQ = `designated => identifier "${BUNDLE_ID}"`

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${res.status}`)
  }
  return res
}

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  const productName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${productName}.app`

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ecoda-sign-'))
  const scratchApp = path.join(scratch, `${productName}.app`)
  try {
    // Copy into /tmp WITHOUT xattrs/resource forks (--noextattr --norsrc
    // drops the iCloud fpfs + provenance stamps). /tmp is not file-
    // provider-managed, so nothing re-adds them while we sign.
    console.log(`[afterPack] copying bundle to scratch ${scratchApp}`)
    run('ditto', ['--noextattr', '--norsrc', appPath, scratchApp])

    // Pass 1 — deep: sign every nested binary (Electron Framework, the
    // Helper .app bundles, our spawned yt-dlp/deno) + the top-level
    // bundle, each with its own default designated requirement.
    console.log('[afterPack] ad-hoc signing (pass 1: deep)')
    run('codesign', ['--force', '--deep', '--sign', '-', scratchApp])

    // Pass 2 — top-level ONLY (no --deep) with the identifier-based
    // requirement. NOT --deep: nested Helpers have different identifiers
    // (….helper.Renderer etc.), so forcing the top-level identifier on
    // them makes `codesign --verify` report "nested code is modified or
    // invalid". The requirement must be a single `-r=<text>` token —
    // `['-r', REQ]` (two args) makes codesign treat REQ as a file path.
    console.log('[afterPack] ad-hoc signing (pass 2: top-level + identifier requirement)')
    run('codesign', ['--force', '--sign', '-', `-r=${REQ}`, scratchApp])

    // Verify exactly what Squirrel.Mac runs: SecStaticCodeCheckValidity
    // with default flags === `codesign --verify --deep` WITHOUT --strict.
    // (--strict rejects the FinderInfo macOS re-stamps on Helper bundles
    // and isn't what Squirrel uses, so it'd be a flaky false negative.)
    console.log('[afterPack] verifying (mild, matches Squirrel.Mac)')
    run('codesign', ['--verify', '--deep', scratchApp])

    // Confirm the designated requirement is identifier-based, not cdhash.
    // If it's a cdhash, auto-update silently breaks — fail loudly here.
    const reqCheck = spawnSync('codesign', ['-d', '-r-', scratchApp], {
      encoding: 'utf8'
    })
    const reqLine = `${reqCheck.stdout ?? ''}${reqCheck.stderr ?? ''}`
    if (!reqLine.includes(`identifier "${BUNDLE_ID}"`)) {
      throw new Error(
        `designated requirement is not identifier-based (got: ${reqLine.trim()}) — auto-update would break`
      )
    }

    // Swap the signed bundle back into place. The destination (in iCloud-
    // managed Documents) will re-acquire fpfs xattrs, but that's after
    // signing and doesn't affect the content-hash-based signature.
    console.log('[afterPack] swapping signed bundle back into dist')
    fs.rmSync(appPath, { recursive: true, force: true })
    run('ditto', [scratchApp, appPath])

    console.log(
      '[afterPack] ad-hoc signature + identifier-based designated requirement confirmed — build OK'
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
