import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const pkgDir = path.resolve('pkg')

function run () {
  console.log('Building WASM with wasm-pack...')
  try {
    // Run the WASM build
    execSync('wasm-pack build --target web --out-dir pkg', { stdio: 'inherit' })

    // Files to remove from the pkg directory
    const filesToRemove = [
      'package.json',
      '.gitignore',
      'README.md'
    ]

    console.log('Cleaning up unnecessary files in pkg/ folder...')
    filesToRemove.forEach(file => {
      const filePath = path.join(pkgDir, file)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        console.log(`Removed: ${file}`)
      }
    })

    console.log('Build and cleanup completed successfully.')
  } catch (error) {
    console.error('Build failed:', error.message)
    process.exit(1)
  }
}

run()
