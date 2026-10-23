/**
 * List DSH packages inside the Desktop app.asar whose name matches a pattern.
 *
 *   node tools/asar-list.mjs <regex>
 */
import { readFileSync } from 'node:fs'

const pattern = process.argv[2] ?? '.*'
const archivePath = process.argv[3] ?? 'D:/dsh/resources/app.asar'
const archive = readFileSync(archivePath)

const jsonStart = archive.indexOf(Buffer.from('{"files"'))
if (jsonStart === -1) {
  console.error('not an asar archive')
  process.exit(1)
}
let depth = 0
let inString = false
let escaped = false
let directoryEnd = -1
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
const header = JSON.parse(archive.subarray(jsonStart, directoryEnd).toString('utf8'))
const scope = header.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai']?.files ?? {}
const regex = new RegExp(pattern, 'iu')
const names = Object.keys(scope).filter((name) => regex.test(name)).sort()
console.log(names.join('\n'))
