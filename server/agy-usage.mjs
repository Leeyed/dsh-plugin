import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { execCliFile } from '../engines/cli-admin.mjs'

const quotaWindowName = /^(5h|five[ -]hour|7d|weekly|30d|monthly)(?:\s+limit(?:\s+remaining)?)?$/i

export function agyUsageReport(report) {
  const limits = []
  const command = report?.command
  if (report?.status !== 'SUCCESS' || report.num_turns !== 0 || command?.name !== 'usage' || !Array.isArray(command.data?.groups)) {
    return { limits, status: 'unavailable' }
  }
  for (const [groupIndex, group] of command.data.groups.entries()) {
    const groupName = typeof group?.name === 'string' ? group.name.trim() : ''
    const groupPrefix = `${groupName} `
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      if (!bucket || bucket.disabled || typeof bucket.name !== 'string' || !bucket.name.trim()) continue
      const names = [group.name, bucket.name, bucket.window].filter(name => typeof name === 'string' && name.trim())
      const bucketName = bucket.name.trim()
      const bucketWindow = quotaWindowName.exec(bucketName) ?? (bucketName.startsWith(groupPrefix)
        ? quotaWindowName.exec(bucketName.slice(groupPrefix.length).trim()) : undefined)
      const poolName = groupName && bucketWindow ? groupName : bucketName
      const windowLabel = (typeof bucket.window === 'string' && bucket.window.trim()) || bucketWindow?.[1]
      const poolLabel = groupName && !/^models$/i.test(groupName) && groupName !== poolName
        ? `${groupName} · ${poolName}` : poolName
      const limit = {
        label: [...new Set(names)].join(' · '),
        poolId: `${groupIndex}:${poolName}`,
        poolLabel,
        ...(windowLabel ? { windowLabel } : {}),
      }
      const remaining = bucket.remaining_fraction
      if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 1) {
        limit.usedPercent = Math.round((1 - remaining) * 10_000) / 100
      }
      const resetsAt = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN
      if (Number.isFinite(resetsAt) && resetsAt > 0) limit.resetsAt = resetsAt
      if (limit.usedPercent !== undefined || limit.resetsAt !== undefined) limits.push(limit)
    }
  }
  return { limits, status: limits.length ? 'available' : 'unavailable' }
}

async function isAgyUsageSupported(options) {
  const installed = await execCliFile('agy', ['--version'], options)
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/.exec(installed.stdout.trim())
  if (!version) return false
  const [, major, minor, patch] = version.map(Number)
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)))
}

export async function agyAccountUsage({ cwd = homedir(), signal, env }) {
  const safeCwd = typeof cwd === 'string' && existsSync(cwd) ? cwd : homedir()
  const options = { cwd: safeCwd, signal, timeout: 20_000, maxBuffer: 128 * 1024, ...(env ? {env:{...process.env,...env}} : {}) }
  try {
    if (!await isAgyUsageSupported(options)) return agyUsageReport()
    const result = await execCliFile('agy', ['--print', '/usage', '--output-format', 'json'], options)
    return agyUsageReport(JSON.parse(result.stdout))
  } catch {
    signal?.throwIfAborted()
    return agyUsageReport()
  }
}
