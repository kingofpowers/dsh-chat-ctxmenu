/**
 * Read files out of an Electron app.asar archive without Electron.
 *
 *   node tools/asar-read.mjs <asar> <inner/path> [pattern]
 *
 * Prints the whole file, or only matching lines (with line numbers) when a
 * pattern is given. Used to inspect the shipped Harness implementation.
 */
import { readFileSync } from 'node:fs'

const [archivePath, innerPath, pattern] = process.argv.slice(2)
if (archivePath === undefined || innerPath === undefined) {
  console.error('usage: node tools/asar-read.mjs <asar> <inner/path> [pattern]')
  process.exit(2)
}

const archive = readFileSync(archivePath)

// Electron writes an 8/16 byte prefix before the JSON directory. The exact
// prefix length depends on the asar format revision, so locate the directory
// itself instead of assuming a fixed offset.
const jsonStart = archive.indexOf('{"files"')
if (jsonStart === -1) {
  console.error('not an asar archive (no file directory found)')
  process.exit(1)
}
const declaredSize = archive.readUInt32LE(8)
let directoryEnd = -1
if (declaredSize > 0 && jsonStart + declaredSize <= archive.length) {
  try {
    JSON.parse(archive.subarray(jsonStart, jsonStart + declaredSize).toString('utf8'))
    directoryEnd = jsonStart + declaredSize
  } catch {
    directoryEnd = -1
  }
}
if (directoryEnd === -1) {
  // Fall back to a string-aware brace scan.
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = jsonStart; index < archive.length; index += 1) {
    const char = archive[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === 92) escaped = true
      else if (char === 34) inString = false
      continue
    }
    if (char === 34) inString = true
    else if (char === 123) depth += 1
    else if (char === 125) {
      depth -= 1
      if (depth === 0) {
        directoryEnd = index + 1
        break
      }
    }
  }
}
if (directoryEnd === -1) {
  console.error('could not determine the archive directory length')
  process.exit(1)
}
const header = JSON.parse(archive.subarray(jsonStart, directoryEnd).toString('utf8'))
const dataBase = directoryEnd

function lookup(root, path) {
  const parts = path.split('/').filter((part) => part !== '')
  let node = root
  for (const part of parts) {
    if (node === undefined || node.files === undefined) return undefined
    node = node.files[part]
  }
  return node
}

const entry = lookup(header, innerPath)
if (entry === undefined) {
  console.error(`not found in archive: ${innerPath}`)
  process.exit(1)
}
if (entry.files !== undefined) {
  console.error('directory entry, not a packed file')
  process.exit(1)
}
if (entry.offset === undefined) {
  console.error('unpacked entry (stored outside the archive)')
  process.exit(1)
}
const start = dataBase + Number(entry.offset)
const content = archive.subarray(start, start + Number(entry.size)).toString('utf8')

function clip(line) {
  return line.length > 600 ? `${line.slice(0, 600)} …` : line
}

if (pattern === undefined) {
  process.stdout.write(content)
} else {
  const regex = new RegExp(pattern, 'u')
  const lines = content.split('\n')
  let shown = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (!regex.test(lines[index])) continue
    shown += 1
    const from = Math.max(0, index - 4)
    const to = Math.min(lines.length, index + 12)
    console.log(`--- line ${index + 1} ---`)
    for (let at = from; at < to; at += 1) console.log(`${String(at + 1).padStart(5)} | ${clip(lines[at])}`)
    if (shown >= 4) {
      console.log('... truncated after 4 regions')
      break
    }
  }
  if (shown === 0) console.log('no match')
}
