/**
 * The regions offered by the connection form's picker.
 *
 * A convenience only — the field stays free text. AWS opens regions faster
 * than a hard-coded list can follow, and partitions like GovCloud or China are
 * not enabled in every account.
 */

export interface AwsRegion {
  code: string
  /** The city AWS names the region after, for people who think in places. */
  label: string
}

export const AWS_REGIONS: AwsRegion[] = [
  { code: 'us-east-1', label: 'N. Virginia' },
  { code: 'us-east-2', label: 'Ohio' },
  { code: 'us-west-1', label: 'N. California' },
  { code: 'us-west-2', label: 'Oregon' },
  { code: 'af-south-1', label: 'Cape Town' },
  { code: 'ap-east-1', label: 'Hong Kong' },
  { code: 'ap-south-1', label: 'Mumbai' },
  { code: 'ap-south-2', label: 'Hyderabad' },
  { code: 'ap-northeast-1', label: 'Tokyo' },
  { code: 'ap-northeast-2', label: 'Seoul' },
  { code: 'ap-northeast-3', label: 'Osaka' },
  { code: 'ap-southeast-1', label: 'Singapore' },
  { code: 'ap-southeast-2', label: 'Sydney' },
  { code: 'ap-southeast-3', label: 'Jakarta' },
  { code: 'ap-southeast-4', label: 'Melbourne' },
  { code: 'ca-central-1', label: 'Canada Central' },
  { code: 'ca-west-1', label: 'Calgary' },
  { code: 'eu-central-1', label: 'Frankfurt' },
  { code: 'eu-central-2', label: 'Zurich' },
  { code: 'eu-north-1', label: 'Stockholm' },
  { code: 'eu-south-1', label: 'Milan' },
  { code: 'eu-south-2', label: 'Spain' },
  { code: 'eu-west-1', label: 'Ireland' },
  { code: 'eu-west-2', label: 'London' },
  { code: 'eu-west-3', label: 'Paris' },
  { code: 'il-central-1', label: 'Tel Aviv' },
  { code: 'me-central-1', label: 'UAE' },
  { code: 'me-south-1', label: 'Bahrain' },
  { code: 'sa-east-1', label: 'São Paulo' },
  { code: 'us-gov-east-1', label: 'GovCloud East' },
  { code: 'us-gov-west-1', label: 'GovCloud West' }
]

/** `eu-west-2 — London`, or just the code for a region not in the list. */
export function describeRegion(code: string): string {
  const known = AWS_REGIONS.find((region) => region.code === code.trim())
  return known ? `${known.code} — ${known.label}` : code.trim()
}

/** Shape check only: new regions appear before this list does. */
export function isRegionLike(code: string): boolean {
  return /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d$/.test(code.trim())
}
